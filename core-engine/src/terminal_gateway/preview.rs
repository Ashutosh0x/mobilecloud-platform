//! Web Preview — one-click browser access to a dev server running on the phone.
//!
//! Google Cloud Shell turns `http://localhost:8080` into a public URL; AWS
//! CloudShell does the same for whatever the user started. The engine
//! implements that locally: `GET /preview/:port/…` proxies to a loopback
//! listener that was started inside the phone's own terminal.
//!
//! The proxy can become an open relay if it is not fenced in, so:
//!
//! * the upstream is always `127.0.0.1` / `::1` — no caller-supplied host;
//! * the port must be a high port, and the engine's own control ports (the
//!   operator API, the deployment listener, the SSH daemon) are refused so
//!   the preview cannot be chained back onto the operator surface;
//! * access needs a preview session, which is minted by the operator
//!   credential and is bound to a single port for a bounded time.
//!
//! A session token travels in the query string on the first navigation (a
//! top-level browser navigation cannot carry an `Authorization` header) and
//! is then exchanged for an `HttpOnly` cookie, so the token stays out of the
//! address bar, the history entry, and any `Referer` the previewed app sends.

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::{
    body::{Body, Bytes},
    extract::{Path, Request, State},
    http::{header, HeaderMap, HeaderName, HeaderValue, Method, StatusCode, Uri},
    response::{IntoResponse, Response},
};
use http_body_util::Full;
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::client::legacy::Client;
use hyper_util::rt::TokioExecutor;

use crate::AppState;

/// How long a preview session stays valid. Long enough for a dev-server
/// reload loop, short enough that a leaked link stops working on its own.
pub const SESSION_TTL: Duration = Duration::from_secs(30 * 60);
const MAX_OUTSTANDING_SESSIONS: usize = 256;
const SESSION_COOKIE: &str = "mc_preview";
/// Largest request body forwarded to a previewed app (uploads in dev tools).
/// The engine's global body limit applies to this route as well.
const MAX_PREVIEW_BODY: usize = 16 * 1024 * 1024;

/// One preview session: a token bound to exactly one loopback port.
#[derive(Clone, Copy)]
struct Session {
    port: u16,
    expires: Instant,
}

/// In-memory registry of preview sessions.
#[derive(Default)]
pub struct PreviewSessions {
    inner: Mutex<HashMap<String, Session>>,
}

impl PreviewSessions {
    /// Mint a session for `port`. Returns the opaque token.
    pub fn issue(&self, port: u16) -> String {
        let token = random_token();
        let now = Instant::now();
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        guard.retain(|_, session| session.expires > now);
        if guard.len() >= MAX_OUTSTANDING_SESSIONS {
            if let Some(oldest) = guard
                .iter()
                .min_by_key(|(_, session)| session.expires)
                .map(|(token, _)| token.clone())
            {
                guard.remove(&oldest);
            }
        }
        guard.insert(
            token.clone(),
            Session {
                port,
                expires: now + SESSION_TTL,
            },
        );
        token
    }

    /// True when `token` is live and bound to `port`.
    pub fn allows(&self, token: &str, port: u16) -> bool {
        if token.len() != 64 || !token.bytes().all(|b| b.is_ascii_hexdigit()) {
            return false;
        }
        let now = Instant::now();
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        guard.retain(|_, session| session.expires > now);
        guard
            .get(token)
            .is_some_and(|session| session.port == port && session.expires > now)
    }

    /// Forget every session bound to `port` (used when the port stops listening).
    pub fn revoke_port(&self, port: u16) {
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        guard.retain(|_, session| session.port != port);
    }
}

/// 256 bits of entropy, hex encoded. Falls back to a per-boot mix if
/// `/dev/urandom` is unavailable (it never is on Android or Linux).
fn random_token() -> String {
    use std::io::Read;
    if let Ok(mut file) = std::fs::File::open("/dev/urandom") {
        let mut bytes = [0u8; 32];
        if file.read_exact(&mut bytes).is_ok() {
            return hex::encode(bytes);
        }
    }
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let counter = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let mut hasher = sha2::Sha256::new();
    use sha2::Digest;
    hasher.update(std::process::id().to_le_bytes());
    hasher.update(counter.to_le_bytes());
    hasher.update(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default()
            .to_le_bytes(),
    );
    hex::encode(hasher.finalize())
}

/// Ports the engine itself listens on. A preview must never be able to reach
/// them, otherwise the proxy becomes a way to drive the operator API from a
/// page that the operator opened by accident.
fn reserved_ports() -> Vec<u16> {
    let mut ports = vec![2222u16];
    for (name, default) in [
        ("MOBILECLOUD_BIND", "127.0.0.1:3000"),
        ("MOBILECLOUD_DEPLOY_BIND", "127.0.0.1:3001"),
    ] {
        if let Some(port) = std::env::var(name)
            .ok()
            .and_then(|raw| raw.rsplit_once(':').map(|(_, p)| p.to_owned()))
            .and_then(|p| p.parse::<u16>().ok())
        {
            ports.push(port);
        } else if let Some(port) = default.rsplit_once(':').and_then(|(_, p)| p.parse().ok()) {
            ports.push(port);
        }
    }
    ports
}

/// A port may be previewed when it is a high port that the engine does not
/// itself own.
pub fn previewable_port(port: u16) -> bool {
    port >= 1024 && !reserved_ports().contains(&port)
}

/// Every loopback port with a listening socket, minus the engine's own.
///
/// `/proc/net/tcp` is the only portable way to enumerate listeners on
/// Android without extra permissions; when it cannot be read the list is
/// simply empty and the user types the port by hand.
pub fn listening_ports() -> Vec<u16> {
    let mut ports = Vec::new();
    for file in ["/proc/net/tcp", "/proc/net/tcp6"] {
        let Ok(text) = std::fs::read_to_string(file) else {
            continue;
        };
        for line in text.lines().skip(1) {
            let mut fields = line.split_whitespace();
            let Some(local) = fields.next() else { continue };
            let Some(state) = fields.next() else { continue };
            // TCP_LISTEN
            if state != "0A" {
                continue;
            }
            let Some(hex_port) = local.rsplit_once(':').map(|(_, port)| port) else {
                continue;
            };
            if let Ok(port) = u16::from_str_radix(hex_port, 16) {
                ports.push(port);
            }
        }
    }
    ports.sort_unstable();
    ports.dedup();
    ports.retain(|port| previewable_port(*port));
    ports
}

/// `true` when something is actually accepting connections on the loopback
/// port. Used so the picker only offers ports that work.
pub fn port_is_open(port: u16) -> bool {
    if !previewable_port(port) {
        return false;
    }
    let addrs = [SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port)];
    let addrs = if addrs[0].ip().is_ipv4() {
        vec![addrs[0], SocketAddr::new(IpAddr::V6(Ipv6Addr::LOCALHOST), port)]
    } else {
        addrs.to_vec()
    };
    addrs.iter().any(|addr| {
        std::net::TcpStream::connect_timeout(addr, Duration::from_millis(400)).is_ok()
    })
}

/// `GET /api/v1/preview/ports` — the dev servers the user can preview.
///
/// Ports are only offered when something is actually accepting connections,
/// so the picker never shows a dead entry.
pub async fn list_ports() -> Response {
    let ports: Vec<u16> = listening_ports()
        .into_iter()
        .filter(|port| port_is_open(*port))
        .collect();
    (
        [(header::CACHE_CONTROL, "no-store")],
        axum::Json(serde_json::json!({ "ports": ports })),
    )
        .into_response()
}

/// Mint a preview session for `port` and return the browser-facing URL.
pub async fn create_session(
    State(state): State<Arc<AppState>>,
    axum::extract::Query(query): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> Response {
    let Some(raw) = query.get("port").and_then(|p| p.parse::<u16>().ok()) else {
        return (StatusCode::BAD_REQUEST, "port must be a number").into_response();
    };
    if !previewable_port(raw) {
        return (
            StatusCode::BAD_REQUEST,
            "that port cannot be previewed (reserved or privileged)",
        )
            .into_response();
    }
    let token = state.preview_sessions.issue(raw);
    Json2(serde_json::json!({
        "port": raw,
        "url": format!("/preview/{raw}/?token={token}"),
        "expires_in": SESSION_TTL.as_secs(),
    }))
    .into_response()
}

/// Small helper so the response shape stays consistent with the rest of the API.
struct Json2(serde_json::Value);

impl IntoResponse for Json2 {
    fn into_response(self) -> Response {
        (
            [(header::CACHE_CONTROL, "no-store")],
            axum::Json(self.0),
        )
            .into_response()
    }
}

/// Proxy `GET /preview/:port/*path` to the loopback dev server.
pub async fn preview_handler(
    State(state): State<Arc<AppState>>,
    Path((port, rest)): Path<(u16, String)>,
    uri: Uri,
    headers: HeaderMap,
    request: Request<Body>,
) -> Response {
    if !previewable_port(port) {
        return (StatusCode::BAD_REQUEST, "port cannot be previewed").into_response();
    }

    // Session check: the query token is accepted on the first navigation and
    // then exchanged for a cookie, so sub-resources keep working.
    let query_token = uri
        .query()
        .and_then(|q| {
            q.split('&').find_map(|pair| {
                let (key, value) = pair.split_once('=')?;
                (key == "token").then_some(value.to_owned())
            })
        })
        .map(|value| percent_decode(&value).unwrap_or(value));
    let cookie_token = cookie_value(&headers, SESSION_COOKIE);

    let authorized = query_token
        .as_deref()
        .is_some_and(|token| state.preview_sessions.allows(token, port))
        || cookie_token
            .as_deref()
            .is_some_and(|token| state.preview_sessions.allows(token, port));

    if !authorized {
        return (
            StatusCode::UNAUTHORIZED,
            "preview session required; request one from the CloudShell toolbar",
        )
            .into_response();
    }

    // Drop the token from the URL so it does not linger in history or leak
    // through a `Referer` header sent by the previewed app.
    if query_token.is_some() {
        let target = match uri.path_and_query() {
            Some(pq) => {
                let query = strip_token(pq.query().unwrap_or(""));
                if query.is_empty() {
                    pq.path().to_owned()
                } else {
                    format!("{}?{}", pq.path(), query)
                }
            }
            None => uri.path().to_owned(),
        };
        let mut response = (
            StatusCode::FOUND,
            [(header::LOCATION, target.as_str())],
            [(header::CACHE_CONTROL, "no-store")],
        )
            .into_response();
        if let Some(token) = query_token {
            response.headers_mut().append(
                header::SET_COOKIE,
                HeaderValue::from_str(&format!("{SESSION_COOKIE}={token}; Path=/preview/{port}/; HttpOnly; SameSite=Lax; Max-Age={}", SESSION_TTL.as_secs()))
                    .unwrap_or_else(|_| HeaderValue::from_static("")),
            );
        }
        return response;
    }

    let path = if rest.is_empty() {
        "/".to_owned()
    } else {
        format!("/{rest}")
    };
    let query = strip_token(uri.query().unwrap_or(""));
    let target = if query.is_empty() {
        path
    } else {
        format!("{path}?{query}")
    };

    let method = request.method().clone();
    let body = match axum::body::to_bytes(request.into_body(), MAX_PREVIEW_BODY).await {
        Ok(bytes) => bytes,
        Err(_) => return (StatusCode::PAYLOAD_TOO_LARGE, "request body too large").into_response(),
    };

    match proxy_to_loopback(port, &target, method, &headers, body).await {
        Ok(mut response) => {
            rewrite_location(&mut response, port);
            strip_hop_by_hop(response.headers_mut());
            response
        }
        Err(status) => (status, "the preview target did not respond").into_response(),
    }
}

/// Forward one request to the loopback dev server and return its response.
async fn proxy_to_loopback(
    port: u16,
    path: &str,
    method: Method,
    headers: &HeaderMap,
    body: Bytes,
) -> Result<Response, StatusCode> {
    // Both loopback families are tried: a dev server may bind v4 or v6 only.
    let targets = [
        SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port),
        SocketAddr::new(IpAddr::V6(Ipv6Addr::LOCALHOST), port),
    ];

    let connector = HttpConnector::new();
    let client: Client<HttpConnector, Full<Bytes>> =
        Client::builder(TokioExecutor::new()).build(connector);

    let mut last = StatusCode::BAD_GATEWAY;
    for target in targets {
        let authority = if target.is_ipv6() {
            format!("[{target}]")
        } else {
            target.to_string()
        };
        let uri = format!("http://{authority}{path}");
        let Ok(parsed) = uri.parse::<Uri>() else {
            continue;
        };
        let mut builder = hyper::Request::builder().method(method.clone()).uri(parsed);
        // Forward the content headers a dev server needs, nothing else. The
        // credential headers of this hop are never copied upstream.
        for name in FORWARDED_REQUEST_HEADERS {
            let Ok(name) = HeaderName::from_bytes(name.as_bytes()) else {
                continue;
            };
            if is_forbidden_request_header(&name) {
                continue;
            }
            if let Some(value) = headers.get(&name) {
                builder = builder.header(name, value);
            }
        }
        let Ok(mut request) = builder.body(Full::new(body.clone())) else {
            continue;
        };
        request.headers_mut().insert(
            header::HOST,
            HeaderValue::from_str(&authority)
                .unwrap_or_else(|_| HeaderValue::from_static("localhost")),
        );

        match client.request(request).await {
            Ok(response) => {
                let (parts, incoming) = response.into_parts();
                let mut out = Response::builder().status(parts.status);
                for (name, value) in parts.headers.iter() {
                    out = out.header(name, value);
                }
                return Ok(out.body(Body::new(incoming)).unwrap_or_else(|_| {
                    (StatusCode::BAD_GATEWAY, "invalid preview response").into_response()
                }));
            }
            Err(_) => last = StatusCode::BAD_GATEWAY,
        }
    }
    Err(last)
}

/// Rewrite `Location: http://127.0.0.1:PORT/…` so the browser stays on the
/// preview path instead of trying to reach the phone's loopback address.
fn rewrite_location(response: &mut Response, port: u16) {
    let Some(location) = response
        .headers()
        .get(header::LOCATION)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.to_owned())
    else {
        return;
    };
    let rewritten = if let Some(rest) = location
        .strip_prefix(&format!("http://127.0.0.1:{port}"))
        .or_else(|| location.strip_prefix(&format!("http://[::1]:{port}")))
        .or_else(|| location.strip_prefix(&format!("http://localhost:{port}")))
    {
        format!("/preview/{port}{rest}")
    } else if location.starts_with('/') {
        format!("/preview/{port}{location}")
    } else {
        return;
    };
    if let Ok(value) = HeaderValue::from_str(&rewritten) {
        response.headers_mut().insert(header::LOCATION, value);
    }
}

/// Remove hop-by-hop headers that must not cross the proxy boundary.
fn strip_hop_by_hop(headers: &mut HeaderMap) {
    for name in [
        "connection",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
        "content-length",
    ] {
        headers.remove(name);
    }
}

/// Read one cookie value out of a `Cookie` header.
fn cookie_value(headers: &HeaderMap, name: &str) -> Option<String> {
    let raw = headers.get(header::COOKIE)?.to_str().ok()?;
    raw.split(';')
        .filter_map(|pair| pair.trim().split_once('='))
        .find(|(key, _)| *key == name)
        .map(|(_, value)| value.trim().to_owned())
}

/// Remove the `token` parameter from a query string.
fn strip_token(query: &str) -> String {
    query
        .split('&')
        .filter(|pair| !pair.starts_with("token="))
        .collect::<Vec<_>>()
        .join("&")
}

/// Minimal percent-decoding for the session token.
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
            byte => {
                out.push(byte);
                i += 1;
            }
        }
    }
    String::from_utf8(out).ok()
}

/// Request headers that are copied to the previewed application.
const FORWARDED_REQUEST_HEADERS: [&str; 6] = [
    "content-type",
    "accept",
    "accept-language",
    "user-agent",
    "accept-encoding",
    "cache-control",
];

/// `true` when the header name is one the proxy must not copy upstream.
fn is_forbidden_request_header(name: &HeaderName) -> bool {
    matches!(
        name.as_str(),
        "authorization" | "cookie" | "host" | "origin" | "referer" | "x-forwarded-for"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sessions_are_bound_to_one_port() {
        let sessions = PreviewSessions::default();
        let token = sessions.issue(3000);
        assert!(sessions.allows(&token, 3000));
        assert!(!sessions.allows(&token, 5173), "a session must not open another port");
        assert!(!sessions.allows("nope", 3000));
    }

    #[test]
    fn reserved_and_privileged_ports_are_refused() {
        assert!(!previewable_port(80));
        assert!(!previewable_port(2222));
        assert!(previewable_port(5173));
    }

    #[test]
    fn query_token_is_stripped() {
        assert_eq!(strip_token("token=abc"), "");
        assert_eq!(strip_token("a=1&token=abc&b=2"), "a=1&b=2");
    }

    #[test]
    fn cookies_are_read_safely() {
        let mut headers = HeaderMap::new();
        headers.insert(header::COOKIE, HeaderValue::from_static("a=1; mc_preview=deadbeef; b=2"));
        assert_eq!(cookie_value(&headers, "mc_preview").as_deref(), Some("deadbeef"));
        assert_eq!(cookie_value(&headers, "missing"), None);
    }

    #[test]
    fn credential_headers_are_not_copied_upstream() {
        assert!(is_forbidden_request_header(&header::AUTHORIZATION));
        assert!(is_forbidden_request_header(&header::COOKIE));
        assert!(!is_forbidden_request_header(&header::ACCEPT));
    }
}
