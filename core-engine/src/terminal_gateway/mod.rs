//! Tri-modal terminal subsystem (terminal architecture doc §1–2):
//! * Mode 1: Native Android app → local Unix transport into the PTY manager.
//! * Mode 2: Browser CloudShell → full-duplex Axum WebSocket (`ws_handler`).
//! * Mode 3: Headless SSH on port 2222 with Ed25519 keys (`ssh_server`).
//!
//! Every mode lands in the same PTY supervisor (`pty_session`) attached to a
//! persistent `tmux` session, so network drops and screen sleeps never kill
//! long-running builds.

pub mod files;
pub mod preview;
pub mod pty_session;
pub mod ssh_server;
pub mod ws_handler;

use std::sync::Arc;

use axum::{
    extract::State,
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    Json,
};

use crate::AppState;

/// Terminal router mounted at `/terminal/ws`, plus the preview proxy.
///
/// The WebSocket route is authenticated by a one-use ticket, the preview
/// proxy by a preview session; neither may sit behind the operator bearer
/// middleware, because a browser cannot attach that header to a navigation
/// or a WebSocket handshake.
pub fn router() -> axum::Router<Arc<AppState>> {
    axum::Router::new()
        .route(
            "/terminal/ws",
            axum::routing::get(ws_handler::ws_terminal_handler),
        )
        .route(
            "/preview/:port/*path",
            axum::routing::get(preview::preview_handler),
        )
}

/// Transfer routes that sit behind the operator credential.
///
/// They are registered by the engine's protected router because a file
/// listing must never be reachable without the operator credential.
pub fn transfer_router() -> axum::Router<Arc<AppState>> {
    axum::Router::new()
        .route("/api/v1/terminal/files", axum::routing::get(files::list_files))
        .route("/api/v1/terminal/upload", axum::routing::post(files::upload_file))
        .route(
            "/api/v1/terminal/download",
            axum::routing::get(files::download_file),
        )
        .route(
            "/api/v1/terminal/file",
            axum::routing::delete(files::delete_file),
        )
        .route(
            "/api/v1/preview/session",
            axum::routing::post(preview::create_session),
        )
        .route(
            "/api/v1/preview/ports",
            axum::routing::get(preview::list_ports),
        )
        // The engine's global body limit is tuned for API payloads; a file
        // transfer is allowed to be as large as the transfer contract says.
        .layer(axum::extract::DefaultBodyLimit::max(files::MAX_TRANSFER_BYTES))
}

/// Issue a single-use browser connection ticket. This route lives behind the
/// operator bearer middleware: the browser never holds the operator token, a
/// server-side companion (or the operator tooling) exchanges it for a ticket
/// that is valid for one handshake and 30 seconds.
pub async fn issue_ticket(State(state): State<Arc<AppState>>) -> Response {
    if state.terminal_token.is_empty() {
        return (StatusCode::SERVICE_UNAVAILABLE, "local terminal is disabled").into_response();
    }
    match state.terminal_tickets.issue() {
        Some((ticket, expires_in)) => (
            [(header::CACHE_CONTROL, "no-store")],
            Json(serde_json::json!({
                "ticket": ticket,
                "expires_in": expires_in,
                "subprotocol": "mobilecloud.terminal.v1",
            })),
        )
            .into_response(),
        None => (
            StatusCode::INTERNAL_SERVER_ERROR,
            "terminal ticket generation failed",
        )
            .into_response(),
    }
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
