//! Tower middleware that integrates the blocklist, rate limiter, and WAF engine
//! into a single composable [`ShieldLayer`].
//!
//! # Request Processing Order
//!
//! 1. Extract client IP (from `X-Forwarded-For` header, falling back to
//!    `X-Real-Ip`, then `127.0.0.1`).
//! 2. **Blocklist** check → `403 Forbidden`
//! 3. **Rate limiter** check → `429 Too Many Requests` (with `Retry-After`
//!    header)
//! 4. **WAF** inspection → `403 Forbidden`
//! 5. If all checks pass → forward to the inner service.

use std::future::Future;
use std::net::IpAddr;
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

// ───────────────────── shared state ──────────────────────────────

/// Shared references to the shield components.
#[derive(Debug, Clone)]
pub struct ShieldState {
    pub blocklist: Blocklist,
    pub rate_limiter: SlidingWindowLimiter,
    pub waf: Arc<WafEngine>,
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
            },
        }
    }

    /// Create a `ShieldLayer` from a pre-assembled [`ShieldState`].
    pub fn from_state(state: ShieldState) -> Self {
        Self { state }
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
            let ip = extract_client_ip(req.headers());
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

/// Extract the client IP from request headers.
///
/// Checks `X-Forwarded-For` first (takes the leftmost IP), then `X-Real-Ip`,
/// and falls back to `127.0.0.1`.
fn extract_client_ip(headers: &http::HeaderMap) -> IpAddr {
    // X-Forwarded-For: client, proxy1, proxy2
    if let Some(xff) = headers.get("x-forwarded-for") {
        if let Ok(val) = xff.to_str() {
            if let Some(first) = val.split(',').next() {
                if let Ok(ip) = first.trim().parse::<IpAddr>() {
                    return ip;
                }
            }
        }
    }

    // X-Real-Ip
    if let Some(xri) = headers.get("x-real-ip") {
        if let Ok(val) = xri.to_str() {
            if let Ok(ip) = val.trim().parse::<IpAddr>() {
                return ip;
            }
        }
    }

    // Fallback
    "127.0.0.1".parse().unwrap()
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

    #[test]
    fn extracts_xff_ip() {
        let mut headers = http::HeaderMap::new();
        headers.insert("x-forwarded-for", "203.0.113.5, 10.0.0.1".parse().unwrap());
        assert_eq!(extract_client_ip(&headers), "203.0.113.5".parse::<IpAddr>().unwrap());
    }

    #[test]
    fn extracts_x_real_ip() {
        let mut headers = http::HeaderMap::new();
        headers.insert("x-real-ip", "198.51.100.1".parse().unwrap());
        assert_eq!(extract_client_ip(&headers), "198.51.100.1".parse::<IpAddr>().unwrap());
    }

    #[test]
    fn falls_back_to_loopback() {
        let headers = http::HeaderMap::new();
        assert_eq!(
            extract_client_ip(&headers),
            "127.0.0.1".parse::<IpAddr>().unwrap()
        );
    }
}
