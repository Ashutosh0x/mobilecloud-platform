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
        State,
    },
    response::IntoResponse,
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
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_terminal_session(socket, state))
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
