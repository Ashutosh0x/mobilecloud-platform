//! Full-duplex Axum WebSocket terminal streamer (terminal doc §6.1).
//!
//! Protocol: JSON control frames (`{"type":"input","data":…}` /
//! `{"type":"resize","cols":…,"rows":…}`) inbound; raw PTY bytes outbound.
//! Optional local operator interface for native clients. Browser WebSocket
//! upgrades and URL credentials are not supported.

use std::sync::Arc;

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        OriginalUri, State,
    },
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;

use crate::terminal_gateway::pty_session::PtySession;
use crate::AppState;

#[derive(Deserialize)]
#[serde(tag = "type")]
enum ClientMessage {
    #[serde(rename = "input")]
    Input { data: String },
    #[serde(rename = "resize")]
    Resize { cols: u16, rows: u16 },
}

pub async fn ws_terminal_handler(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
) -> Response {
    if state.terminal_token.is_empty() {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            "local terminal is disabled",
        )
            .into_response();
    }
    if !terminal_authorized(&state.terminal_token, &headers, uri.query().is_some()) {
        return (
            StatusCode::UNAUTHORIZED,
            "terminal header authentication required",
        )
            .into_response();
    }
    ws.max_message_size(64 * 1024)
        .max_frame_size(64 * 1024)
        .on_upgrade(move |socket| handle_terminal_session(socket, state))
}

fn terminal_authorized(expected: &[u8], headers: &HeaderMap, has_query: bool) -> bool {
    if has_query || headers.contains_key(header::ORIGIN) {
        return false;
    }
    let presented =
        crate::bearer(headers).or_else(|| headers.get("x-terminal-token").map(|v| v.as_bytes()));
    presented.is_some_and(|value| crate::token_matches(expected, value))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_requires_dedicated_header_and_rejects_browser_or_query() {
        let mut headers = HeaderMap::new();
        headers.insert(header::AUTHORIZATION, "Bearer terminal".parse().unwrap());
        assert!(terminal_authorized(b"terminal", &headers, false));
        assert!(!terminal_authorized(b"webhook", &headers, false));
        assert!(!terminal_authorized(b"", &headers, false));
        assert!(!terminal_authorized(b"terminal", &headers, true));
        headers.insert(header::ORIGIN, "https://example.test".parse().unwrap());
        assert!(!terminal_authorized(b"terminal", &headers, false));
    }
}

async fn handle_terminal_session(socket: WebSocket, state: Arc<AppState>) {
    let (mut ws_sender, mut ws_receiver) = socket.split();

    // 1. Allocate the PTY session (persistent tmux shell).
    let handle = match PtySession::spawn(&state.engine_bin, &state.home) {
        Ok(h) => h,
        Err(e) => {
            tracing::error!("terminal PTY allocation failed: {e:#}");
            let _ = ws_sender
                .send(Message::Text("terminal unavailable".into()))
                .await;
            return;
        }
    };
    let control = handle.control.clone();

    // 2. PTY output → WebSocket (stdout → browser). The receiver is owned
    //    by this task; the control half is shared with the input loop.
    let forward_task = tokio::spawn(async move {
        let mut rx = handle.output_rx;
        while let Some(data) = rx.recv().await {
            if ws_sender.send(Message::Binary(data.into())).await.is_err() {
                break;
            }
        }
    });

    // 3. WebSocket input → PTY writer & SIGWINCH resize (browser → stdin).
    while let Some(Ok(msg)) = ws_receiver.next().await {
        match msg {
            Message::Text(text) => match serde_json::from_str::<ClientMessage>(&text) {
                Ok(ClientMessage::Input { data }) => {
                    let _ = control.write(data.as_bytes());
                }
                Ok(ClientMessage::Resize { cols, rows }) => {
                    let _ = control.resize(rows, cols);
                }
                Err(e) => tracing::debug!("bad terminal control frame: {e}"),
            },
            Message::Binary(bin) => {
                let _ = control.write(&bin);
            }
            Message::Close(_) => break,
            _ => {}
        }
    }

    forward_task.abort();
}
