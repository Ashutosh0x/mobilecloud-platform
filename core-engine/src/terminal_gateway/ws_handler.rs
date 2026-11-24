//! Full-duplex Axum WebSocket terminal streamer (terminal doc §6.1).
//!
//! Protocol: JSON control frames (`{"type":"input","data":…}` /
//! `{"type":"resize","cols":…,"rows":…}`) inbound; raw PTY bytes outbound.
//! Authentication is enforced upstream by the zero-trust ingress
//! (Cloudflare Access JWT / Tailscale Funnel) — the local listener itself
//! binds loopback-only, so a remote terminal session can only exist after a
//! tunnel-authenticated request. New remote sessions additionally require a
//! biometric-issued token from the Android app (§3.1).

use std::sync::Arc;

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Query, State,
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

#[derive(Deserialize)]
pub struct TerminalAuth {
    token: Option<String>,
}

pub async fn ws_terminal_handler(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
    Query(auth): Query<TerminalAuth>,
    headers: HeaderMap,
) -> Response {
    // A shell is never handed out unauthenticated: an empty configured token
    // fails closed, exactly like a mismatched one.
    if !terminal_authorized(&state, &headers, auth.token.as_deref()) {
        return (StatusCode::UNAUTHORIZED, "terminal authentication required").into_response();
    }
    ws.on_upgrade(move |socket| handle_terminal_session(socket, state))
}

/// Accept the terminal credential from `?token=`, `x-terminal-token`, or an
/// `Authorization: Bearer` header (the Android client uses the header form).
fn terminal_authorized(state: &AppState, headers: &HeaderMap, query_token: Option<&str>) -> bool {
    let expected = state.terminal_token.as_slice();
    let candidates = [
        query_token,
        headers.get("x-terminal-token").and_then(|v| v.to_str().ok()),
        headers
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer ")),
    ];
    candidates
        .into_iter()
        .flatten()
        .any(|token| token_matches(expected, token))
}

/// Constant-time credential comparison; an empty expected token never matches.
fn token_matches(expected: &[u8], presented: &str) -> bool {
    let presented = presented.as_bytes();
    if expected.is_empty() || presented.len() != expected.len() {
        return false;
    }
    expected
        .iter()
        .zip(presented.iter())
        .fold(0u8, |acc, (a, b)| acc | (a ^ b))
        == 0
}

async fn handle_terminal_session(socket: WebSocket, state: Arc<AppState>) {
    let (mut ws_sender, mut ws_receiver) = socket.split();

    // 1. Allocate the PTY session (persistent tmux shell).
    let handle = match PtySession::spawn(&state.engine_bin, &state.home) {
        Ok(h) => h,
        Err(e) => {
            tracing::error!("terminal PTY allocation failed: {e:#}");
            let _ = ws_sender
                .send(Message::Text(format!("terminal unavailable: {e}")))
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
