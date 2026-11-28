//! Tower middleware that integrates the blocklist, rate limiter, and WAF engine
//! into a single composable [`ShieldLayer`].
//!
//! # Request Processing Order
//!
//! 1. Extract client IP. The direct peer address is read from the
//!    [`ConnectInfo`]`<`[`SocketAddr`]`>` request extension. Forwarded headers
//!    (`X-Forwarded-For`, `X-Real-Ip`, `CF-Connecting-Ip`) are only honored when
//!    that peer address is in the configured trusted-proxy allowlist;
//!    otherwise the peer address itself is used. With no peer address at all,
//!    the loopback address (`127.0.0.1`) is used.
//! 2. **Blocklist** check → `403 Forbidden`
//! 3. **Rate limiter** check → `429 Too Many Requests` (with `Retry-After`
//!    header)
//! 4. **WAF** inspection → `403 Forbidden`
//! 5. If all checks pass → forward to the inner service.

use std::collections::HashSet;
use std::future::Future;
use std::net::{IpAddr, SocketAddr};
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};

use bytes::Bytes;
use http::{Request, Response, StatusCode};
use http_body_util::Full;
use tower::{Layer, Service};
use tracing::{info, warn};

use crate::blocklist::Blocklist;
use crate::rate_limiter::SlidingWindowLimiter;
use crate::waf::{WafEngine, WafVerdict};

// ───────────────────── connection info ──────────────────────────

/// Connection metadata extension carrying the direct peer address.
///
/// Mirrors the conventional `ConnectInfo<SocketAddr>` request extension
/// inserted by HTTP servers so that forwarded headers can be trusted only for
/// known reverse proxies.
#[derive(Clone, Copy, Debug)]
pub struct ConnectInfo<T>(pub T);

// ───────────────────── shared state ──────────────────────────────

/// Shared references to the shield components.
#[derive(Debug, Clone)]
pub struct ShieldState {
    pub blocklist: Blocklist,
    pub rate_limiter: SlidingWindowLimiter,
    pub waf: Arc<WafEngine>,
    /// Reverse-proxy IPs whose forwarded headers are honored. Empty by default,
    /// meaning forwarded headers are never trusted.
    pub trusted_proxies: Arc<HashSet<IpAddr>>,
}

// ───────────────────── layer ─────────────────────────────────────

/// A [`tower::Layer`] that wraps a service with [`ShieldService`].
#[derive(Debug, Clone)]
pub struct ShieldLayer {
    state: ShieldState,
}

impl ShieldLayer {
    /// Create a new `ShieldLayer` from the given shield components.
    pub fn new(
        blocklist: Blocklist,
        rate_limiter: SlidingWindowLimiter,
        waf: WafEngine,
    ) -> Self {
        Self {
            state: ShieldState {
                blocklist,
                rate_limiter,
                waf: Arc::new(waf),
                trusted_proxies: Arc::new(HashSet::new()),
            },
        }
    }

    /// Create a `ShieldLayer` from a pre-assembled [`ShieldState`].
    pub fn from_state(state: ShieldState) -> Self {
        Self { state }
    }

    /// Set the reverse-proxy IP allowlist whose forwarded headers are trusted.
    ///
    /// Defaults to empty (forwarded headers are never trusted).
    pub fn with_trusted_proxies<I>(mut self, proxies: I) -> Self
    where
        I: IntoIterator<Item = IpAddr>,
    {
        self.state.trusted_proxies = Arc::new(proxies.into_iter().collect());
        self
    }
}

impl<S> Layer<S> for ShieldLayer {
    type Service = ShieldService<S>;

    fn layer(&self, inner: S) -> Self::Service {
        ShieldService {
            inner,
            state: self.state.clone(),
        }
    }
}

// ───────────────────── service ───────────────────────────────────

/// Tower service that guards an inner service with blocklist, rate-limiter,
/// and WAF checks.
#[derive(Debug, Clone)]
pub struct ShieldService<S> {
    inner: S,
    state: ShieldState,
}

impl<S, ReqBody> Service<Request<ReqBody>> for ShieldService<S>
where
    S: Service<Request<ReqBody>, Response = Response<Full<Bytes>>> + Clone + Send + 'static,
    S::Future: Send + 'static,
    S::Error: Into<Box<dyn std::error::Error + Send + Sync>>,
    ReqBody: Send + 'static,
{
    type Response = Response<Full<Bytes>>;
    type Error = S::Error;
    type Future = Pin<Box<dyn Future<Output = Result<Self::Response, Self::Error>> + Send>>;

    fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.inner.poll_ready(cx)
    }

    fn call(&mut self, req: Request<ReqBody>) -> Self::Future {
        let state = self.state.clone();
        let mut inner = self.inner.clone();
        // Swap so the clone gets the readiness, per tower convention.
        std::mem::swap(&mut self.inner, &mut inner);

        Box::pin(async move {
            // 1. Extract client IP.
            let peer = peer_addr(&req);
            let ip = extract_client_ip(req.headers(), peer, &state.trusted_proxies);
            info!(%ip, method = %req.method(), uri = %req.uri(), "shield: inspecting request");

            // 2. Blocklist check.
            if let Some(reason) = state.blocklist.is_blocked(&ip) {
                warn!(%ip, reason = %reason.reason, source = ?reason.source, "shield: blocked by blocklist");
                return Ok(json_response(
                    StatusCode::FORBIDDEN,
                    serde_json::json!({
                        "error": "blocked",
                        "reason": reason.reason
                    }),
                ));
            }

            // 3. Rate-limiter check.
            if let Err(exceeded) = state.rate_limiter.check(ip) {
                warn!(%ip, retry_after = exceeded.retry_after_secs, "shield: rate limit exceeded");
                let mut resp = json_response(
                    StatusCode::TOO_MANY_REQUESTS,
                    serde_json::json!({
                        "error": "rate_limit_exceeded",
                        "retry_after_secs": exceeded.retry_after_secs
                    }),
                );
                resp.headers_mut().insert(
                    http::header::RETRY_AFTER,
                    http::HeaderValue::from_str(&exceeded.retry_after_secs.to_string())
                        .unwrap_or_else(|_| http::HeaderValue::from_static("60")),
                );
                return Ok(resp);
            }

            // 4. WAF check (we only inspect the head here; body inspection
            //    would require buffering which is left to callers).
            let (parts, body) = req.into_parts();
            let verdict = state.waf.inspect(&parts, None);
            match verdict {
                WafVerdict::Block {
                    rule_id,
                    description,
                } => {
                    warn!(%ip, %rule_id, %description, "shield: blocked by WAF");
                    return Ok(json_response(
                        StatusCode::FORBIDDEN,
                        serde_json::json!({
                            "error": "blocked_by_waf",
                            "rule": rule_id,
                            "description": description
                        }),
                    ));
                }
                WafVerdict::Allow => {}
            }

            // 5. All checks passed — forward.
            let req = Request::from_parts(parts, body);
            inner.call(req).await
        })
    }
}

// ───────────────────── helpers ───────────────────────────────────

/// Resolve the direct peer socket address from request extensions.
///
/// Looks for the [`ConnectInfo`]`<`[`SocketAddr`]`>` extension inserted by the
/// HTTP server, falling back to a bare [`SocketAddr`] extension.
fn peer_addr<B>(req: &Request<B>) -> Option<SocketAddr> {
    if let Some(ci) = req.extensions().get::<ConnectInfo<SocketAddr>>() {
        return Some(ci.0);
    }
    req.extensions().get::<SocketAddr>().copied()
}

/// Extract the client IP given the request headers, the direct peer address,
/// and the trusted-proxy allowlist.
///
/// Forwarded headers are only honored when `peer` is a trusted proxy. When the
/// peer is untrusted (or absent), the peer address itself is used; the loopback
/// fallback (`127.0.0.1`) is used only when no peer address is available.
fn extract_client_ip(
    headers: &http::HeaderMap,
    peer: Option<SocketAddr>,
    trusted_proxies: &HashSet<IpAddr>,
) -> IpAddr {
    match peer {
        Some(addr) => {
            // Honor forwarded headers only from a trusted reverse proxy.
            if trusted_proxies.contains(&addr.ip()) {
                if let Some(ip) = forwarded_client_ip(headers) {
                    return ip;
                }
            }
            addr.ip()
        }
        // No peer information available.
        None => "127.0.0.1".parse().unwrap(),
    }
}

/// Parse the client IP from forwarded headers, if present and well-formed.
///
/// Checks `X-Forwarded-For` (leftmost IP), then `X-Real-Ip`, then
/// `CF-Connecting-Ip`.
fn forwarded_client_ip(headers: &http::HeaderMap) -> Option<IpAddr> {
    // X-Forwarded-For: client, proxy1, proxy2
    if let Some(xff) = headers.get("x-forwarded-for") {
        if let Ok(val) = xff.to_str() {
            if let Some(first) = val.split(',').next() {
                if let Ok(ip) = first.trim().parse::<IpAddr>() {
                    return Some(ip);
                }
            }
        }
    }

    // X-Real-Ip
    if let Some(xri) = headers.get("x-real-ip") {
        if let Ok(val) = xri.to_str() {
            if let Ok(ip) = val.trim().parse::<IpAddr>() {
                return Some(ip);
            }
        }
    }

    // CF-Connecting-Ip (Cloudflare)
    if let Some(cf) = headers.get("cf-connecting-ip") {
        if let Ok(val) = cf.to_str() {
            if let Ok(ip) = val.trim().parse::<IpAddr>() {
                return Some(ip);
            }
        }
    }

    None
}

/// Build a JSON error response with the given status code.
fn json_response(status: StatusCode, body: serde_json::Value) -> Response<Full<Bytes>> {
    let bytes = Bytes::from(body.to_string());
    Response::builder()
        .status(status)
        .header(http::header::CONTENT_TYPE, "application/json")
        .body(Full::new(bytes))
        .expect("response builder should not fail")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    fn addr(s: &str) -> SocketAddr {
        s.parse().unwrap()
    }

    fn trusted(ips: &[&str]) -> HashSet<IpAddr> {
        ips.iter().map(|s| ip(s)).collect()
    }

    #[test]
    fn extracts_xff_ip() {
        let mut headers = http::HeaderMap::new();
        headers.insert("x-forwarded-for", "203.0.113.5, 10.0.0.1".parse().unwrap());
        let peer = Some(addr("127.0.0.1:4000"));
        let proxies = trusted(&["127.0.0.1"]);
        assert_eq!(
            extract_client_ip(&headers, peer, &proxies),
            ip("203.0.113.5")
        );
    }

    #[test]
    fn extracts_x_real_ip() {
        let mut headers = http::HeaderMap::new();
        headers.insert("x-real-ip", "198.51.100.1".parse().unwrap());
        let peer = Some(addr("127.0.0.1:4000"));
        let proxies = trusted(&["127.0.0.1"]);
        assert_eq!(extract_client_ip(&headers, peer, &proxies), ip("198.51.100.1"));
    }

    #[test]
    fn falls_back_to_loopback() {
        let headers = http::HeaderMap::new();
        let proxies = HashSet::new();
        assert_eq!(extract_client_ip(&headers, None, &proxies), ip("127.0.0.1"));
    }

    #[test]
    fn forwarded_header_ignored_for_untrusted_peer() {
        let mut headers = http::HeaderMap::new();
        headers.insert("x-forwarded-for", "203.0.113.5".parse().unwrap());
        headers.insert("x-real-ip", "198.51.100.1".parse().unwrap());
        headers.insert("cf-connecting-ip", "198.51.100.7".parse().unwrap());
        let peer = Some(addr("10.0.0.9:5000"));
        // 10.0.0.9 is not a trusted proxy → forwarded headers must be ignored.
        let proxies = trusted(&["127.0.0.1"]);
        assert_eq!(extract_client_ip(&headers, peer, &proxies), ip("10.0.0.9"));
    }

    #[test]
    fn forwarded_header_honored_for_trusted_peer() {
        let mut headers = http::HeaderMap::new();
        headers.insert("x-forwarded-for", "203.0.113.5, 10.0.0.1".parse().unwrap());
        let peer = Some(addr("127.0.0.1:5000"));
        let proxies = trusted(&["127.0.0.1"]);
        assert_eq!(
            extract_client_ip(&headers, peer, &proxies),
            ip("203.0.113.5")
        );
    }

    #[test]
    fn cf_connecting_ip_honored_for_trusted_peer() {
        let mut headers = http::HeaderMap::new();
        headers.insert("cf-connecting-ip", "198.51.100.7".parse().unwrap());
        let peer = Some(addr("127.0.0.1:5000"));
        let proxies = trusted(&["127.0.0.1"]);
        assert_eq!(extract_client_ip(&headers, peer, &proxies), ip("198.51.100.7"));
    }

    #[test]
    fn reads_connect_info_extension() {
        let mut req = Request::builder().body(()).unwrap();
        req.extensions_mut().insert(ConnectInfo(addr("9.9.9.9:1234")));
        assert_eq!(peer_addr(&req), Some(addr("9.9.9.9:1234")));
    }

    #[test]
    fn trusted_proxy_allowlist_defaults_to_empty() {
        let layer = ShieldLayer::new(
            Blocklist::new(),
            SlidingWindowLimiter::new(),
            WafEngine::with_defaults(),
        );
        assert!(layer.state.trusted_proxies.is_empty());
    }

    #[test]
    fn with_trusted_proxies_sets_allowlist() {
        let layer = ShieldLayer::new(
            Blocklist::new(),
            SlidingWindowLimiter::new(),
            WafEngine::with_defaults(),
        )
        .with_trusted_proxies([ip("127.0.0.1"), ip("10.0.0.1")]);
        assert!(layer.state.trusted_proxies.contains(&ip("127.0.0.1")));
        assert!(layer.state.trusted_proxies.contains(&ip("10.0.0.1")));
    }
}
