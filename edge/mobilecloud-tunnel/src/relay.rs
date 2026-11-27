//! Tunnel relay — runs on a VPS, bridges public HTTP to phone-side services.
//!
//! The relay has two listeners:
//!
//! - **Tunnel listener** (`listen_tunnel`): Accepts WebSocket connections from
//!   tunnel clients, verifies Ed25519 handshakes, and registers services in an
//!   in-memory service registry.
//!
//! - **Public listener** (`listen_public`): Accepts HTTP requests from the
//!   internet, extracts the target service from the `Host` header, looks up the
//!   corresponding yamux `Control`, opens a substream, writes a service-name
//!   header, and proxies the request/response bidirectionally.

use crate::mux::WebSocketAdapter;
use crate::protocol::{AuthToken, ControlMessage, TunnelHandshake};

use anyhow::{Context as _, Result};
use bytes::Bytes;
use dashmap::DashMap;
use ed25519_dalek::VerifyingKey;
use futures_util::{AsyncReadExt, AsyncWriteExt, SinkExt, StreamExt};
use http_body_util::Full;
use hyper::body::Incoming;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Request, Response, StatusCode};
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;
use tracing::{error, info, warn};
use yamux::Control;

/// Maximum allowed clock skew for handshake timestamps (5 minutes).
const HANDSHAKE_MAX_AGE_SECS: u64 = 300;

// ───────────────────── service registry ──────────────────────────

/// A registered tunnel client's services.
#[derive(Debug)]
struct RegisteredClient {
    /// yamux control handle — used to open substreams.
    control: Control,
    /// Map of service name → local port on the client (informational).
    services: Vec<String>,
}

/// Thread-safe registry of connected tunnel clients.
///
/// Key = service name (e.g. `"console"`, `"api"`).
/// Value = yamux control for the client that owns that service.
type ServiceRegistry = Arc<DashMap<String, Control>>;

// ───────────────────── relay config ─────────────────────────────

/// Configuration for the tunnel relay.
#[derive(Debug, Clone)]
pub struct RelayConfig {
    /// Address for the tunnel listener (e.g. `0.0.0.0:8443`).
    pub tunnel_addr: SocketAddr,
    /// Address for the public HTTP listener (e.g. `0.0.0.0:8080`).
    pub public_addr: SocketAddr,
    /// Base domain for service routing (e.g. `furlpay.com`).
    /// A request to `console.furlpay.com` → service name `console`.
    pub domain: String,
    /// Authorized Ed25519 public keys (hex-encoded).
    /// Only clients presenting a key in this set are accepted.
    pub authorized_keys: Vec<VerifyingKey>,
}

// ───────────────────── relay server ─────────────────────────────

/// The MobileCloud tunnel relay server.
pub struct TunnelRelay {
    config: RelayConfig,
    registry: ServiceRegistry,
}

impl TunnelRelay {
    /// Create a new relay with the given configuration.
    pub fn new(config: RelayConfig) -> Self {
        Self {
            config,
            registry: Arc::new(DashMap::new()),
        }
    }

    /// Run both the tunnel listener and the public HTTP listener.
    ///
    /// This method never returns under normal operation.
    pub async fn run(&self) -> Result<()> {
        let registry = self.registry.clone();
        let config = self.config.clone();

        // Run both listeners concurrently
        let tunnel_handle = {
            let registry = registry.clone();
            let config = config.clone();
            tokio::spawn(async move {
                if let Err(e) = listen_tunnel(config, registry).await {
                    error!(%e, "tunnel listener failed");
                }
            })
        };

        let public_handle = {
            let registry = registry.clone();
            let config = config.clone();
            tokio::spawn(async move {
                if let Err(e) = listen_public(config, registry).await {
                    error!(%e, "public listener failed");
                }
            })
        };

        tokio::select! {
            r = tunnel_handle => {
                error!("tunnel listener exited: {r:?}");
            }
            r = public_handle => {
                error!("public listener exited: {r:?}");
            }
        }

        Ok(())
    }

    /// Get a snapshot of currently registered service names.
    pub fn registered_services(&self) -> Vec<String> {
        self.registry.iter().map(|r| r.key().clone()).collect()
    }
}

// ───────────────────── tunnel listener ──────────────────────────

/// Accept incoming WebSocket connections from tunnel clients.
async fn listen_tunnel(config: RelayConfig, registry: ServiceRegistry) -> Result<()> {
    let listener = TcpListener::bind(config.tunnel_addr)
        .await
        .context("failed to bind tunnel listener")?;

    info!(addr = %config.tunnel_addr, "tunnel listener started");

    loop {
        let (tcp_stream, peer_addr) = listener.accept().await?;
        info!(%peer_addr, "incoming tunnel connection");

        let registry = registry.clone();
        let authorized_keys = config.authorized_keys.clone();

        tokio::spawn(async move {
            if let Err(e) =
                handle_tunnel_connection(tcp_stream, peer_addr, &authorized_keys, registry).await
            {
                warn!(%peer_addr, %e, "tunnel client connection failed");
            }
        });
    }
}

/// Handle a single tunnel client WebSocket connection.
async fn handle_tunnel_connection(
    tcp_stream: tokio::net::TcpStream,
    _peer_addr: SocketAddr,
    authorized_keys: &[VerifyingKey],
    registry: ServiceRegistry,
) -> Result<()> {
    // 1. WebSocket handshake
    let ws_stream = tokio_tungstenite::accept_async(tcp_stream)
        .await
        .context("websocket handshake failed")?;

    let (mut ws_write, mut ws_read) = ws_stream.split();

    // 2. Read and verify the tunnel handshake
    let handshake: TunnelHandshake = match ws_read.next().await {
        Some(Ok(Message::Text(text))) => {
            serde_json::from_str(&text).context("invalid handshake JSON")?
        }
        Some(Ok(_)) => anyhow::bail!("expected text message for handshake"),
        Some(Err(e)) => anyhow::bail!("error reading handshake: {e}"),
        None => anyhow::bail!("connection closed before handshake"),
    };

    info!(
        client_id = %handshake.client_id,
        services = ?handshake.services.iter().map(|s| &s.name).collect::<Vec<_>>(),
        "received tunnel handshake"
    );

    // 3. Verify timestamp freshness
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();

    if now.abs_diff(handshake.timestamp) > HANDSHAKE_MAX_AGE_SECS {
        let err_msg = format!(
            "handshake timestamp too old/new: {} vs now {}",
            handshake.timestamp, now
        );
        let ctl = ControlMessage::Error(err_msg.clone());
        let _ = ws_write
            .send(Message::Text(serde_json::to_string(&ctl).unwrap().into()))
            .await;
        anyhow::bail!(err_msg);
    }

    // 4. Verify Ed25519 signature against authorized keys
    let mut verified = false;
    for key in authorized_keys {
        if AuthToken::verify(
            key,
            &handshake.client_id,
            handshake.timestamp,
            &handshake.signature,
        )
        .is_ok()
        {
            verified = true;
            break;
        }
    }

    if !verified {
        let ctl = ControlMessage::Error("unauthorized: signature verification failed".to_string());
        let _ = ws_write
            .send(Message::Text(serde_json::to_string(&ctl).unwrap().into()))
            .await;
        anyhow::bail!("unauthorized tunnel client {}", handshake.client_id);
    }

    info!(client_id = %handshake.client_id, "tunnel client authorized");

    // 5. Send handshake acknowledgement
    let ack = ControlMessage::HeartbeatAck { seq: 0 };
    ws_write
        .send(Message::Text(serde_json::to_string(&ack).unwrap().into()))
        .await?;

    // 6. Reunite WS stream and set up yamux (server mode)
    let ws_stream = ws_write
        .reunite(ws_read)
        .expect("reunite should not fail on matching halves");

    // Wrap the WebSocket in our AsyncRead+AsyncWrite adapter
    let adapter = WebSocketAdapter::new_from_reunited(ws_stream);

    let mut cfg = yamux::Config::default();
    cfg.set_max_buffer_size(16 * 1024 * 1024);

    let conn = yamux::Connection::new(adapter, cfg, yamux::Mode::Server);
    let control = conn.control();

    // 7. Register services in the global registry
    let service_names: Vec<String> = handshake
        .services
        .iter()
        .map(|s| s.name.clone())
        .collect();

    for name in &service_names {
        registry.insert(name.clone(), control.clone());
        info!(service = %name, client_id = %handshake.client_id, "service registered");
    }

    // 8. Drive the yamux connection until it closes
    // The relay is in Server mode — it opens streams via Control when
    // public requests arrive. The yamux Connection itself must be
    // polled to completion.
    let client_id = handshake.client_id.clone();
    let result = drive_yamux_connection(conn).await;

    // 9. Cleanup: remove services from registry
    for name in &service_names {
        registry.remove(name);
        info!(service = %name, client_id = %client_id, "service unregistered");
    }

    if let Err(e) = result {
        warn!(client_id = %client_id, %e, "yamux connection ended with error");
    } else {
        info!(client_id = %client_id, "yamux connection closed cleanly");
    }

    Ok(())
}

/// Drive a yamux connection to completion.
///
/// In server mode we don't accept inbound streams from the client —
/// the relay opens outbound streams via `Control` when public requests
/// come in. This function simply polls the connection so that yamux
/// can process frames.
async fn drive_yamux_connection(
    mut conn: yamux::Connection<WebSocketAdapter<tokio::net::TcpStream>>,
) -> Result<()> {
    loop {
        match conn.next_stream().await {
            Ok(Some(_stream)) => {
                // Unexpected inbound stream from client — drop it.
                tracing::debug!("ignoring inbound yamux stream from client");
            }
            Ok(None) => {
                // Connection closed
                return Ok(());
            }
            Err(e) => {
                return Err(anyhow::anyhow!("yamux error: {e}"));
            }
        }
    }
}

// ───────────────────── public HTTP listener ─────────────────────

/// Accept incoming HTTP requests from the public internet and route
/// them to tunnel clients via yamux substreams.
async fn listen_public(config: RelayConfig, registry: ServiceRegistry) -> Result<()> {
    let listener = TcpListener::bind(config.public_addr)
        .await
        .context("failed to bind public listener")?;

    info!(addr = %config.public_addr, domain = %config.domain, "public listener started");

    let domain = Arc::new(config.domain);

    loop {
        let (tcp_stream, peer_addr) = listener.accept().await?;
        let registry = registry.clone();
        let domain = domain.clone();

        tokio::spawn(async move {
            let service = service_fn(move |req: Request<Incoming>| {
                let registry = registry.clone();
                let domain = domain.clone();
                async move { handle_public_request(req, peer_addr, &domain, &registry).await }
            });

            if let Err(e) = http1::Builder::new()
                .preserve_header_case(true)
                .serve_connection(hyper_util::rt::TokioIo::new(tcp_stream), service)
                .await
            {
                tracing::debug!(%peer_addr, %e, "HTTP connection ended");
            }
        });
    }
}

/// Handle a single public HTTP request.
///
/// 1. Extract the service name from the `Host` header.
/// 2. Look up the yamux `Control` in the registry.
/// 3. Open a yamux substream to the client.
/// 4. Write the service name header + raw HTTP request.
/// 5. Read the response from the substream and return it.
async fn handle_public_request(
    req: Request<Incoming>,
    peer_addr: SocketAddr,
    domain: &str,
    registry: &ServiceRegistry,
) -> Result<Response<Full<Bytes>>, hyper::Error> {
    let host = req
        .headers()
        .get(hyper::header::HOST)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    // Extract service name: "console.furlpay.com" → "console"
    // Also handle "console.furlpay.com:8080" (strip port).
    let host_no_port = host.split(':').next().unwrap_or(host);
    let service_name = extract_service_name(host_no_port, domain);

    info!(
        %peer_addr,
        %host,
        service = %service_name,
        method = %req.method(),
        uri = %req.uri(),
        "routing public request"
    );

    // Look up the service in the registry
    let mut control = match registry.get(&service_name) {
        Some(entry) => entry.value().clone(),
        None => {
            warn!(service = %service_name, "service not found in registry");
            return Ok(error_response(
                StatusCode::BAD_GATEWAY,
                &format!("service '{}' not connected", service_name),
            ));
        }
    };

    // Open a yamux substream to the tunnel client
    let mut stream = match control.open_stream().await {
        Ok(s) => s,
        Err(e) => {
            error!(service = %service_name, %e, "failed to open yamux stream");
            return Ok(error_response(
                StatusCode::BAD_GATEWAY,
                "failed to reach backend service",
            ));
        }
    };

    // Write the service name header so the client knows which local port to use
    let header = format!("{}\n", service_name);
    if let Err(e) = stream.write_all(header.as_bytes()).await {
        error!(%e, "failed to write service header to yamux stream");
        return Ok(error_response(
            StatusCode::BAD_GATEWAY,
            "tunnel write error",
        ));
    }

    // Serialize and write the HTTP request line + headers
    let (parts, body) = req.into_parts();

    let request_line = format!(
        "{} {} HTTP/1.1\r\n",
        parts.method,
        parts.uri.path_and_query().map(|pq| pq.as_str()).unwrap_or("/")
    );

    if let Err(e) = stream.write_all(request_line.as_bytes()).await {
        error!(%e, "failed to write request line");
        return Ok(error_response(StatusCode::BAD_GATEWAY, "tunnel write error"));
    }

    // Write headers
    for (name, value) in parts.headers.iter() {
        let header_line = format!("{}: {}\r\n", name.as_str(), value.to_str().unwrap_or(""));
        if let Err(e) = stream.write_all(header_line.as_bytes()).await {
            error!(%e, "failed to write header");
            return Ok(error_response(StatusCode::BAD_GATEWAY, "tunnel write error"));
        }
    }

    // End of headers
    if let Err(e) = stream.write_all(b"\r\n").await {
        error!(%e, "failed to write header terminator");
        return Ok(error_response(StatusCode::BAD_GATEWAY, "tunnel write error"));
    }

    // Write body (collect from Incoming)
    use http_body_util::BodyExt;
    match body.collect().await {
        Ok(collected) => {
            let body_bytes = collected.to_bytes();
            if !body_bytes.is_empty() {
                if let Err(e) = stream.write_all(&body_bytes).await {
                    error!(%e, "failed to write request body");
                    return Ok(error_response(StatusCode::BAD_GATEWAY, "tunnel write error"));
                }
            }
        }
        Err(e) => {
            error!(%e, "failed to collect request body");
            return Ok(error_response(
                StatusCode::BAD_REQUEST,
                "failed to read request body",
            ));
        }
    }

    // Shut down the write side so the client knows we're done sending
    // (yamux supports half-close)
    let _ = stream.close().await;

    // Read the full response from the yamux stream
    let mut response_buf = Vec::with_capacity(8192);
    if let Err(e) = stream.read_to_end(&mut response_buf).await {
        error!(%e, "failed to read response from tunnel");
        return Ok(error_response(
            StatusCode::BAD_GATEWAY,
            "tunnel read error",
        ));
    }

    // Parse the HTTP response
    // For simplicity in Phase 1, we return the raw bytes as the response body.
    // A full implementation would parse HTTP/1.1 response headers.
    if response_buf.is_empty() {
        return Ok(error_response(
            StatusCode::BAD_GATEWAY,
            "empty response from backend",
        ));
    }

    // Try to find the header/body boundary
    let response = parse_raw_http_response(&response_buf);

    Ok(response)
}

/// Extract the service name from a hostname.
///
/// - `console.furlpay.com` with domain `furlpay.com` → `"console"`
/// - `api.staging.furlpay.com` with domain `furlpay.com` → `"api.staging"`
/// - `furlpay.com` with domain `furlpay.com` → `"root"`
/// - Anything without the domain suffix → the full hostname.
fn extract_service_name(host: &str, domain: &str) -> String {
    if host == domain {
        return "root".to_string();
    }

    let suffix = format!(".{}", domain);
    if host.ends_with(&suffix) {
        let prefix = &host[..host.len() - suffix.len()];
        if prefix.is_empty() {
            "root".to_string()
        } else {
            prefix.to_string()
        }
    } else {
        // No matching domain — use the full host as service name
        host.to_string()
    }
}

/// Parse a raw HTTP/1.1 response from bytes.
///
/// Returns a hyper `Response<Full<Bytes>>` by extracting the status line,
/// headers, and body from the raw response.
fn parse_raw_http_response(raw: &[u8]) -> Response<Full<Bytes>> {
    // Find the header/body boundary (\r\n\r\n)
    let header_end = raw
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .unwrap_or(raw.len());

    let header_bytes = &raw[..header_end];
    let body_start = std::cmp::min(header_end + 4, raw.len());
    let body_bytes = &raw[body_start..];

    let header_str = String::from_utf8_lossy(header_bytes);
    let mut lines = header_str.lines();

    // Parse status line: "HTTP/1.1 200 OK"
    let status_code = if let Some(status_line) = lines.next() {
        status_line
            .split_whitespace()
            .nth(1)
            .and_then(|code| code.parse::<u16>().ok())
            .unwrap_or(502)
    } else {
        502
    };

    let mut builder = Response::builder().status(StatusCode::from_u16(status_code).unwrap_or(StatusCode::BAD_GATEWAY));

    // Parse headers
    for line in lines {
        if let Some((name, value)) = line.split_once(": ") {
            // Skip hop-by-hop headers
            let lower = name.to_lowercase();
            if lower == "transfer-encoding" || lower == "connection" {
                continue;
            }
            builder = builder.header(name, value);
        }
    }

    builder
        .body(Full::new(Bytes::from(body_bytes.to_vec())))
        .unwrap_or_else(|_| {
            Response::builder()
                .status(StatusCode::BAD_GATEWAY)
                .body(Full::new(Bytes::from("internal proxy error")))
                .unwrap()
        })
}

/// Build a JSON error response.
fn error_response(status: StatusCode, message: &str) -> Response<Full<Bytes>> {
    let body = serde_json::json!({
        "error": message,
        "status": status.as_u16()
    });

    Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .body(Full::new(Bytes::from(body.to_string())))
        .unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_service_subdomain() {
        assert_eq!(
            extract_service_name("console.furlpay.com", "furlpay.com"),
            "console"
        );
    }

    #[test]
    fn extract_service_nested_subdomain() {
        assert_eq!(
            extract_service_name("api.staging.furlpay.com", "furlpay.com"),
            "api.staging"
        );
    }

    #[test]
    fn extract_service_bare_domain() {
        assert_eq!(
            extract_service_name("furlpay.com", "furlpay.com"),
            "root"
        );
    }

    #[test]
    fn extract_service_unknown_domain() {
        assert_eq!(
            extract_service_name("other.example.com", "furlpay.com"),
            "other.example.com"
        );
    }

    #[test]
    fn parse_raw_response_basic() {
        let raw = b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\nHello, world!";
        let resp = parse_raw_http_response(raw);
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(
            resp.headers().get("Content-Type").unwrap().to_str().unwrap(),
            "text/plain"
        );
    }

    #[test]
    fn parse_raw_response_no_body() {
        let raw = b"HTTP/1.1 204 No Content\r\n\r\n";
        let resp = parse_raw_http_response(raw);
        assert_eq!(resp.status(), StatusCode::NO_CONTENT);
    }
}
