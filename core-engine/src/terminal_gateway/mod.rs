//! Tri-modal terminal subsystem (terminal architecture doc §1–2):
//! * Mode 1: Native Android app → local Unix transport into the PTY manager.
//! * Mode 2: Browser CloudShell → full-duplex Axum WebSocket (`ws_handler`).
//! * Mode 3: Headless SSH on port 2222 with Ed25519 keys (`ssh_server`).
//!
//! Every mode lands in the same PTY supervisor (`pty_session`) attached to a
//! persistent `tmux` session, so network drops and screen sleeps never kill
//! long-running builds.

pub mod pty_session;
pub mod ssh_server;
pub mod ws_handler;

use std::sync::Arc;

use crate::AppState;

/// WebSocket terminal router mounted at `/terminal/ws`.
pub fn ws_router() -> axum::Router<Arc<AppState>> {
    axum::Router::new().route(
        "/terminal/ws",
        axum::routing::get(ws_handler::ws_terminal_handler),
    )
}

/// Launch the headless SSH daemon (mode 3) on port 2222. Failure is logged,
/// never fatal — the phone serves without SSH on restricted hosts.
pub async fn start_ssh_server(state: Arc<AppState>) {
    tokio::spawn(async move {
        match ssh_server::run(state).await {
            Ok(()) => tracing::info!("SSH daemon exited cleanly"),
            Err(e) => tracing::warn!("SSH daemon unavailable on :2222 — {e}"),
        }
    });
}
