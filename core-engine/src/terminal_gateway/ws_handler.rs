//! Full-duplex Axum WebSocket terminal streamer (terminal doc §6.1).
//!
//! Protocol: JSON control frames (`{"type":"input","data":…}` /
//! `{"type":"resize","cols":…,"rows":…}`) inbound; raw PTY bytes outbound.
//!
//! Authentication has two supported shapes:
//!
//! * **Non-browser clients** present the static terminal credential in
//!   `Authorization: Bearer …` or `X-Terminal-Token: …` and must *not* send an
//!   `Origin` header.
//! * **Browsers** cannot attach arbitrary headers to a WebSocket handshake, so
//!   they redeem a short-lived, single-use *connection ticket* issued by
//!   `POST /terminal/ticket` (operator-authenticated). The ticket is accepted
//!   from `?ticket=…` or from the `ticket.<value>` WebSocket sub-protocol.
//!   An `Origin` header is mandatory and must match either the request `Host`
//!   (same-origin deployment) or an explicitly configured origin in
//!   `MOBILECLOUD_TERMINAL_ORIGINS`.
//!
//! There is deliberately no "trust every Origin" mode: the ticket is the
//! credential, the Origin check is the CSRF boundary.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        OriginalUri, State,
    },
    http::{header, HeaderMap, StatusCode, Uri},
    response::{IntoResponse, Response},
};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use sha2::Digest;

use crate::terminal_gateway::pty_session::PtySession;
use crate::AppState;

/// Browser tickets are valid for a single handshake and die quickly.
pub const TICKET_TTL: Duration = Duration::from_secs(30);
const MAX_OUTSTANDING_TICKETS: usize = 512;
const SUBPROTOCOL: &str = "mobilecloud.terminal.v1";
const TICKET_PREFIX: &str = "ticket.";
const HEARTBEAT: Duration = Duration::from_secs(25);

#[derive(Deserialize)]
#[serde(tag = "type")]
enum ClientMessage {
    #[serde(rename = "input")]
    Input { data: String },
    #[serde(rename = "resize")]
    Resize { cols: u16, rows: u16 },
}

/// In-memory one-use ticket registry. Tickets are opaque 256-bit values and
/// are removed the moment they are redeemed, so replay is impossible even
/// inside the TTL window.
#[derive(Default)]
pub struct TerminalTickets {
    inner: Mutex<HashMap<String, Instant>>,
}

impl TerminalTickets {
    /// Issue a fresh ticket. Returns `(ticket, ttl_seconds)`.
    pub fn issue(&self) -> Option<(String, u64)> {
        let ticket = random_ticket()?;
        let now = Instant::now();
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        guard.retain(|_, expires| *expires > now);
        if guard.len() >= MAX_OUTSTANDING_TICKETS {
            // Drop the oldest entry rather than growing without bound.
            if let Some(oldest) = guard
                .iter()
                .min_by_key(|(_, expires)| **expires)
                .map(|(key, _)| key.clone())
            {
                guard.remove(&oldest);
            }
        }
        guard.insert(ticket.clone(), now + TICKET_TTL);
        Some((ticket, TICKET_TTL.as_secs()))
    }

    /// Redeem a ticket exactly once.
    pub fn redeem(&self, ticket: &str) -> bool {
        if !valid_ticket_shape(ticket) {
            return false;
        }
        let now = Instant::now();
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        guard.retain(|_, expires| *expires > now);
        guard.remove(ticket).is_some()
    }
}

fn valid_ticket_shape(ticket: &str) -> bool {
    ticket.len() == 64 && ticket.bytes().all(|b| b.is_ascii_hexdigit())
}

/// 256 bits of entropy from the OS. Android and every desktop target expose
/// `/dev/urandom`; the SHA-256 fallback is only a last resort and still mixes
/// several per-boot signals into a value an attacker cannot guess cheaply.
fn random_ticket() -> Option<String> {
    use std::io::Read;
    if let Ok(mut file) = std::fs::File::open("/dev/urandom") {
        let mut bytes = [0u8; 32];
        if file.read_exact(&mut bytes).is_ok() {
            return Some(hex::encode(bytes));
        }
    }
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let counter = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?;
    let mut hasher = sha2::Sha256::new();
    hasher.update(now.as_nanos().to_le_bytes());
    hasher.update(std::process::id().to_le_bytes());
    hasher.update(counter.to_le_bytes());
    let stack = &counter as *const u64 as usize;
    hasher.update(stack.to_le_bytes());
    Some(hex::encode(hasher.finalize()))
}

/// Normalize a configured origin (`scheme://host[:port]`) or reject it.
/// Paths, credentials, fragments and query strings are not origins.
pub fn normalize_origin(value: &str) -> Option<String> {
    let value = value.trim().trim_end_matches('/');
    if value.is_empty() || value.len() > 255 {
        return None;
    }
    let (scheme, rest) = value.split_once("://")?;
    if !scheme.eq_ignore_ascii_case("http") && !scheme.eq_ignore_ascii_case("https") {
        return None;
    }
    if rest.is_empty() || rest.contains(['/', '?', '#', '@', '\\']) {
        return None;
    }
    // Bracketed IPv6 literal, optionally with a port.
    if let Some(inner) = rest.strip_prefix('[') {
        let (addr, tail) = inner.split_once(']')?;
        addr.parse::<std::net::Ipv6Addr>().ok()?;
        match tail {
            "" => return Some(format!("{scheme}://[{addr}]").to_ascii_lowercase()),
            _ => {
                let port = tail.strip_prefix(':')?;
                if port.parse::<u16>().is_err() {
                    return None;
                }
                return Some(format!("{scheme}://[{addr}]:{port}").to_ascii_lowercase());
            }
        }
    }
    if rest.parse::<std::net::SocketAddr>().is_ok() {
        return Some(format!("{scheme}://{rest}").to_ascii_lowercase());
    }
    // `host:port` needs a valid u16 port; a bare host must look like a host.
    let (host, port) = match rest.rsplit_once(':') {
        Some((host, port)) if !host.is_empty() => {
            if port.is_empty() || !port.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            if port.parse::<u16>().is_err() {
                return None;
            }
            (host, Some(port))
        }
        Some(_) => return None,
        None => (rest, None),
    };
    if host.is_empty()
        || host.len() > 253
        || !host
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-._".contains(&b))
        || host.starts_with('.')
        || host.ends_with('.')
    {
        return None;
    }
    match port {
        Some(port) => Some(format!("{scheme}://{host}:{port}").to_ascii_lowercase()),
        None => Some(format!("{scheme}://{host}").to_ascii_lowercase()),
    }
}

/// True when the browser `Origin` is safe for this handshake: either the same
/// origin that addressed the request (`Host`), or an operator-configured one.
fn origin_trusted(origin: &str, headers: &HeaderMap, allowlist: &[String]) -> bool {
    let Some(origin) = normalize_origin(origin) else {
        return false;
    };
    if allowlist.iter().any(|allowed| allowed == &origin) {
        return true;
    }
    same_origin_as_host(&origin, headers)
}

fn same_origin_as_host(origin: &str, headers: &HeaderMap) -> bool {
    let Some(host) = headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
    else {
        return false;
    };
    let host = host.trim();
    if host.is_empty() || host.contains(['/', '\\', '@', '?', '#']) {
        return false;
    }
    let lower = origin.to_ascii_lowercase();
    // Default ports are omitted from Origin but often present in Host.
    let candidates = [
        format!("http://{host}"),
        format!("https://{host}"),
        format!("http://{host}:80"),
        format!("https://{host}:443"),
    ];
    candidates
        .iter()
        .any(|candidate| candidate.eq_ignore_ascii_case(&lower))
}

fn header_ticket(headers: &HeaderMap) -> Option<String> {
    let value = headers.get("x-terminal-ticket")?.to_str().ok()?;
    let value = value.trim();
    valid_ticket_shape(value).then(|| value.to_owned())
}

fn query_param(uri: &Uri, name: &str) -> Option<String> {
    let query = uri.query()?;
    query.split('&').find_map(|pair| {
        let (key, value) = pair.split_once('=')?;
        if key != name {
            return None;
        }
        let decoded = percent_decode(value)?;
        (!decoded.is_empty()).then_some(decoded)
    })
}

/// Minimal percent-decoding for the ticket parameter (tickets are hex, so
/// anything that decodes outside `[0-9a-f]` is rejected later anyway).
fn percent_decode(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' => {
                let hi = *bytes.get(i + 1)?;
                let lo = *bytes.get(i + 2)?;
                let pair = [hi, lo];
                let decoded = u8::from_str_radix(std::str::from_utf8(&pair).ok()?, 16).ok()?;
                out.push(decoded);
                i += 3;
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            byte => {
                out.push(byte);
                i += 1;
            }
        }
    }
    String::from_utf8(out).ok()
}

fn subprotocol_ticket(headers: &HeaderMap) -> Option<String> {
    let raw = headers
        .get(header::SEC_WEBSOCKET_PROTOCOL)?
        .to_str()
        .ok()?;
    raw.split(',').find_map(|part| {
        let part = part.trim();
        let ticket = part.strip_prefix(TICKET_PREFIX)?;
        valid_ticket_shape(ticket).then(|| ticket.to_owned())
    })
}

fn offers_subprotocol(headers: &HeaderMap) -> bool {
    headers
        .get(header::SEC_WEBSOCKET_PROTOCOL)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|raw| raw.split(',').any(|part| part.trim() == SUBPROTOCOL))
}

enum Authorization {
    Browser,
    Operator,
}

fn authorize(
    expected_token: &[u8],
    allowlist: &[String],
    tickets: &TerminalTickets,
    headers: &HeaderMap,
    uri: &Uri,
) -> Result<Authorization, (StatusCode, &'static str)> {
    let origin = headers
        .get(header::ORIGIN)
        .map(|value| value.to_str().unwrap_or_default());

    if let Some(origin) = origin {
        if !origin_trusted(origin, headers, allowlist) {
            return Err((
                StatusCode::FORBIDDEN,
                "websocket origin is not allowed for the terminal gateway",
            ));
        }
        // Browsers authenticate with a one-use ticket only. Query credentials
        // are never accepted for the static token, so it cannot leak via logs.
        let ticket = query_param(uri, "ticket")
            .or_else(|| subprotocol_ticket(headers))
            .or_else(|| header_ticket(headers));
        return match ticket {
            Some(ticket) if tickets.redeem(&ticket) => Ok(Authorization::Browser),
            Some(_) => Err((
                StatusCode::UNAUTHORIZED,
                "terminal ticket is invalid, expired, or already used",
            )),
            None => Err((
                StatusCode::UNAUTHORIZED,
                "a one-use terminal ticket is required for browser connections",
            )),
        };
    }

    // Non-browser path: a ticket may also be supplied in the query string.
    if let Some(ticket) = query_param(uri, "ticket").or_else(|| header_ticket(headers)) {
        return if tickets.redeem(&ticket) {
            Ok(Authorization::Operator)
        } else {
            Err((
                StatusCode::UNAUTHORIZED,
                "terminal ticket is invalid, expired, or already used",
            ))
        };
    }

    let presented = crate::bearer(headers).or_else(|| {
        headers
            .get("x-terminal-token")
            .map(|value| value.as_bytes())
    });
    match presented {
        Some(value) if crate::token_matches(expected_token, value) => Ok(Authorization::Operator),
        _ => Err((
            StatusCode::UNAUTHORIZED,
            "terminal header authentication required",
        )),
    }
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

    let browser = headers.contains_key(header::ORIGIN);
    match authorize(
        &state.terminal_token,
        &state.terminal_origins,
        &state.terminal_tickets,
        &headers,
        &uri,
    ) {
        Ok(_) => {}
        Err((status, message)) => return (status, message).into_response(),
    }

    let mut upgrade = ws
        .max_message_size(64 * 1024)
        .max_frame_size(64 * 1024);
    if offers_subprotocol(&headers) {
        upgrade = upgrade.protocols([SUBPROTOCOL]);
    }
    if browser {
        tracing::info!("browser CloudShell handshake accepted");
    }
    upgrade
        .on_upgrade(move |socket| handle_terminal_session(socket, state))
        .into_response()
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
    let mut output_rx = handle.output_rx;
    // Keep the child handle alive for the lifetime of the socket.
    let _child = handle.child;

    // 2. Single select loop: PTY output → WebSocket, WebSocket input → PTY,
    //    plus a protocol-level heartbeat for idle sessions.
    let mut heartbeat = tokio::time::interval(HEARTBEAT);
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    loop {
        tokio::select! {
            chunk = output_rx.recv() => {
                let Some(data) = chunk else { break };
                if ws_sender.send(Message::Binary(data)).await.is_err() {
                    break;
                }
            }
            message = ws_receiver.next() => {
                let Some(message) = message else { break };
                match message {
                    Ok(Message::Text(text)) => match serde_json::from_str::<ClientMessage>(&text) {
                        Ok(ClientMessage::Input { data }) => {
                            let _ = control.write(data.as_bytes());
                        }
                        Ok(ClientMessage::Resize { cols, rows }) => {
                            let _ = control.resize(rows.min(500), cols.min(500));
                        }
                        Err(e) => tracing::debug!("bad terminal control frame: {e}"),
                    },
                    Ok(Message::Binary(bin)) => {
                        let _ = control.write(&bin);
                    }
                    Ok(Message::Ping(payload)) => {
                        let _ = ws_sender.send(Message::Pong(payload)).await;
                    }
                    Ok(Message::Close(_)) | Err(_) => break,
                    _ => {}
                }
            }
            _ = heartbeat.tick() => {
                if ws_sender.send(Message::Ping(Vec::new())).await.is_err() {
                    break;
                }
            }
        }
    }

    let _ = ws_sender.close().await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    fn headers(origin: Option<&str>, host: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(header::HOST, HeaderValue::from_str(host).unwrap());
        if let Some(origin) = origin {
            headers.insert(header::ORIGIN, HeaderValue::from_str(origin).unwrap());
        }
        headers
    }

    #[test]
    fn ticket_is_single_use_and_shape_checked() {
        let tickets = TerminalTickets::default();
        let (ticket, ttl) = tickets.issue().expect("ticket");
        assert_eq!(ttl, TICKET_TTL.as_secs());
        assert!(valid_ticket_shape(&ticket));
        assert!(tickets.redeem(&ticket));
        assert!(!tickets.redeem(&ticket), "tickets must not be replayable");
        assert!(!tickets.redeem("nope"));
    }

    #[test]
    fn origin_normalization_accepts_real_origins_only() {
        assert_eq!(
            normalize_origin("https://admin.phone.mobilecloud.live/").as_deref(),
            Some("https://admin.phone.mobilecloud.live")
        );
        assert_eq!(
            normalize_origin("http://localhost:5173").as_deref(),
            Some("http://localhost:5173")
        );
        assert!(normalize_origin("https://evil.test/path").is_none());
        assert!(normalize_origin("javascript:alert(1)").is_none());
        assert!(normalize_origin("https://user@evil.test").is_none());
    }

    #[test]
    fn browser_connections_require_an_allowed_origin_and_ticket() {
        let tickets = TerminalTickets::default();
        let allowed = vec!["https://admin.phone.mobilecloud.live".to_string()];
        let uri = Uri::from_static("/terminal/ws");
        let token = b"terminal";

        // Same-origin browser without a ticket still fails.
        let same = headers(Some("http://localhost:3000"), "localhost:3000");
        assert!(authorize(token, &allowed, &tickets, &same, &uri).is_err());

        // Allow-listed origin with a valid ticket succeeds exactly once.
        let (ticket, _) = tickets.issue().unwrap();
        let uri_ticket = Uri::from_static("/terminal/ws?ticket=placeholder");
        let with_ticket = headers(
            Some("https://admin.phone.mobilecloud.live"),
            "admin.phone.mobilecloud.live",
        );
        let query = format!("/terminal/ws?ticket={ticket}");
        let uri_ticket = Uri::from_maybe_shared(query).unwrap_or(uri_ticket);
        assert!(matches!(
            authorize(token, &allowed, &tickets, &with_ticket, &uri_ticket),
            Ok(Authorization::Browser)
        ));
        assert!(authorize(token, &allowed, &tickets, &with_ticket, &uri_ticket).is_err());

        // Cross-origin browser is refused before tickets are considered.
        let evil = headers(Some("https://evil.test"), "localhost:3000");
        assert!(authorize(token, &allowed, &tickets, &evil, &uri).is_err());
    }

    #[test]
    fn non_browser_path_keeps_static_header_auth() {
        let tickets = TerminalTickets::default();
        let uri = Uri::from_static("/terminal/ws");
        let mut headers = HeaderMap::new();
        headers.insert(header::AUTHORIZATION, "Bearer terminal".parse().unwrap());
        assert!(matches!(
            authorize(b"terminal", &[], &tickets, &headers, &uri),
            Ok(Authorization::Operator)
        ));
        assert!(authorize(b"webhook", &[], &tickets, &headers, &uri).is_err());
        assert!(authorize(b"", &[], &tickets, &headers, &uri).is_err());
    }

    #[test]
    fn query_token_is_not_accepted_without_a_ticket() {
        let tickets = TerminalTickets::default();
        let uri = Uri::from_static("/terminal/ws?token=terminal");
        let headers = HeaderMap::new();
        assert!(authorize(b"terminal", &[], &tickets, &headers, &uri).is_err());
    }
}
