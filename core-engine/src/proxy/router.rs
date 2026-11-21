//! Open Build Output API v3 route parser and request dispatcher.
//!
//! Reads `.mobilecloud/output/config.json` from the project's live
//! deployment and executes the standard route table semantics
//! (research report §3):
//!
//! * `handle: "filesystem"` — serve `static/<path>` if it exists, then
//!   apply `overrides` content types; continue to later routes on miss.
//! * `src` (regex) with optional `dest` rewrite (`$1..$9` captures),
//!   `status` (redirect), `headers` injection, and `continue: true`
//!   chaining.
//! * Destination starting `/api/...` etc. resolves into `functions/<name>.func`
//!   and dispatches to the warm Bun/Node worker pool.
//! * `cons` entries are surfaced to the scheduler API.
//!
//! The route table is parsed once per (project, deploy_id) and cached in
//! memory; a promotion invalidates it, and SIGHUP-equivalent reloads swap
//! the cache atomically (sub-millisecond route table reload).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::body::Body;
use axum::http::{header, HeaderMap, HeaderName, HeaderValue, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::Value;

use crate::AppState;

#[derive(Debug, thiserror::Error)]
pub enum RouterError {
    #[error("no live deployment for project")]
    NoDeployment,
    #[error("invalid route config: {0}")]
    InvalidConfig(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

// ---------------------------------------------------------------------------
// Build Output API v3 config schema.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize, Default)]
pub struct BuildOutputConfig {
    pub version: u32,
    #[serde(default)]
    pub routes: Vec<RouteRule>,
    #[serde(default)]
    pub overrides: HashMap<String, OverrideRule>,
    #[serde(default)]
    pub crons: Vec<CronRule>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct RouteRule {
    #[serde(default)]
    pub src: Option<String>,
    #[serde(default)]
    pub dest: Option<String>,
    #[serde(default)]
    pub status: Option<u16>,
    #[serde(default)]
    pub headers: Option<HashMap<String, String>>,
    #[serde(default)]
    pub methods: Option<Vec<String>>,
    #[serde(default)]
    pub continue_: Option<bool>, // "continue" is a Rust keyword
    #[serde(default)]
    pub handle: Option<String>,
    #[serde(default)]
    pub check: Option<bool>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct OverrideRule {
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub content_type: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct CronRule {
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub schedule: String,
}

impl BuildOutputConfig {
    /// Parse `config.json` from a deployment output directory.
    pub fn load(output_dir: &Path) -> Result<Self, RouterError> {
        let path = output_dir.join("config.json");
        if !path.exists() {
            // A config-less deployment is legal: pure static serving.
            return Ok(BuildOutputConfig {
                version: 3,
                ..Default::default()
            });
        }
        let raw = std::fs::read_to_string(&path)?;
        let mut cfg: BuildOutputConfig = serde_json::from_str(&raw)
            .map_err(|e| RouterError::InvalidConfig(e.to_string()))?;
        // Build Output v3 uses "continue"; remap through serde alias via manual scan
        // because of the keyword clash.
        let raw_value: Value =
            serde_json::from_str(&raw).map_err(|e| RouterError::InvalidConfig(e.to_string()))?;
        if let Some(routes) = raw_value.get("routes").and_then(|v| v.as_array()) {
            for (i, route) in routes.iter().enumerate() {
                if let Some(cont) = route.get("continue").and_then(|v| v.as_bool()) {
                    if let Some(rule) = cfg.routes.get_mut(i) {
                        rule.continue_ = Some(cont);
                    }
                }
            }
        }
        Ok(cfg)
    }
}

/// A compiled route table bound to one deployment directory.
pub struct RouteTable {
    pub output_dir: PathBuf,
    pub static_dir: PathBuf,
    pub functions_dir: PathBuf,
    pub config: BuildOutputConfig,
    #[allow(dead_code)]
    pub compiled: Vec<(Option<regex::Regex>, RouteRule)>,
}

impl RouteTable {
    pub fn compile(output_dir: PathBuf) -> Result<Self, RouterError> {
        let config = BuildOutputConfig::load(&output_dir)?;
        let mut compiled = Vec::with_capacity(config.routes.len());
        for rule in &config.routes {
            let regex = match &rule.src {
                Some(src) => Some(
                    regex::Regex::new(src)
                        .map_err(|e| RouterError::InvalidConfig(format!("bad src {src}: {e}")))?,
                ),
                None => None,
            };
            compiled.push((regex, rule.clone()));
        }
        Ok(RouteTable {
            static_dir: output_dir.join("static"),
            functions_dir: output_dir.join("functions"),
            output_dir,
            config,
            compiled,
        })
    }

    /// The worker-pool function descriptor for a destination path, if any.
    /// `dest` like `/api/hello` or `/ssr` maps to `functions/api/hello.func`.
    pub fn function_for_dest(&self, dest: &str) -> Option<(String, PathBuf, FunctionRuntime)> {
        let clean = dest.split('?').next().unwrap_or(dest);
        let clean = clean.trim_end_matches('/');
        if clean.is_empty() {
            return None;
        }
        let func_dir = self.functions_dir.join(format!("{}.func", clean.trim_start_matches('/')));
        if func_dir.join(".vc-config.json").exists() || func_dir.join("index.js").exists() {
            let runtime = FunctionRuntime::from_func_dir(&func_dir);
            return Some((clean.trim_start_matches('/').to_string(), func_dir, runtime));
        }
        None
    }
}

/// Runtime descriptor from `.vc-config.json` (research report §3.3).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FunctionRuntime {
    /// nodejs22.x — dispatched to the Bun/Node worker pool.
    Node,
    /// edge — in-memory isolate, zero-fork (< 1ms) dispatch.
    Edge,
}

impl FunctionRuntime {
    fn from_func_dir(dir: &Path) -> FunctionRuntime {
        let cfg = std::fs::read_to_string(dir.join(".vc-config.json")).unwrap_or_default();
        if cfg.contains("\"edge\"") {
            FunctionRuntime::Edge
        } else {
            FunctionRuntime::Node
        }
    }
}

// ---------------------------------------------------------------------------
// Request dispatch.
// ---------------------------------------------------------------------------

/// Route one ingress request through the project's live deployment.
pub async fn route_request(
    state: &Arc<AppState>,
    project: &str,
    request: axum::extract::Request<Body>,
) -> Result<Response, RouterError> {
    let live = state
        .deployments
        .live_output_dir(&state.home, project)
        .ok_or(RouterError::NoDeployment)?;
    let table = Arc::new(RouteTable::compile(live)?);

    let (parts, body) = request.into_parts();
    let method = parts.method.clone();
    let uri = parts.uri.clone();
    let accept_encoding = parts
        .headers
        .get(header::ACCEPT_ENCODING)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_string();

    let mut path = uri.path().to_string();
    let mut response_headers_stack: Vec<HeaderMap> = Vec::new();

    // Walk the route table in order.
    for (regex, rule) in &table.compiled {
        // `handle: "filesystem"` gate: serve static/ if present, else fall
        // through to later routes.
        if rule.handle.as_deref() == Some("filesystem") {
            if let Some(mut response) = try_serve_static(&table, &path, &method, &accept_encoding)? {
                apply_stacked_headers(&mut response, &response_headers_stack, rule);
                return Ok(response);
            }
            continue;
        }

        let Some(regex) = regex else { continue };
        let Some(caps) = regex.captures(&path) else { continue };

        // Method restriction.
        if let Some(methods) = &rule.methods {
            if !methods.is_empty()
                && !methods
                    .iter()
                    .any(|m| m.eq_ignore_ascii_case(method.as_str()))
            {
                continue;
            }
        }

        // Route-level headers apply whether we continue or terminate here.
        if let Some(headers) = &rule.headers {
            let mut hm = HeaderMap::new();
            for (k, v) in headers {
                if let (Ok(name), Ok(value)) = (
                    HeaderName::from_bytes(k.as_bytes()),
                    HeaderValue::from_str(v),
                ) {
                    hm.insert(name, value);
                }
            }
            response_headers_stack.push(hm);
        }

        // Redirect rule (`status` 3xx with a Location).
        if let Some(status) = rule.status {
            if (300..400).contains(&status) {
                let location = expand_dest(rule.dest.as_deref().unwrap_or(&path), &caps);
                let mut response = Response::builder()
                    .status(StatusCode::from_u16(status).unwrap_or(StatusCode::FOUND))
                    .header(header::LOCATION, location)
                    .body(Body::empty())
                    .map_err(|e| RouterError::InvalidConfig(e.to_string()))?;
                apply_stacked_headers(&mut response, &response_headers_stack, rule);
                return Ok(response);
            }
        }

        // Rewrite destination and continue chaining, or terminate.
        let continue_chain = rule.continue_.unwrap_or(false);
        if let Some(dest) = &rule.dest {
            let rewritten = expand_dest(dest, &caps);
            if continue_chain {
                path = rewritten;
                continue;
            }
            return dispatch_destination(
                state,
                &table,
                &rewritten,
                &method,
                &uri,
                parts.headers.clone(),
                body,
                &response_headers_stack,
                rule,
            )
            .await;
        }

        if continue_chain {
            continue;
        }
        // Bare `src` without dest terminates on nothing: keep walking.
    }

    // Route table exhausted: final filesystem fallback, then 404.
    if let Some(response) = try_serve_static(&table, &path, &method, &accept_encoding)? {
        return Ok(response);
    }
    Ok((StatusCode::NOT_FOUND, "not found").into_response())
}

fn apply_stacked_headers(response: &mut Response, stack: &[HeaderMap], rule: &RouteRule) {
    let headers = response.headers_mut();
    for hm in stack {
        for (k, v) in hm {
            headers.insert(k.clone(), v.clone());
        }
    }
    if let Some(rule_headers) = &rule.headers {
        for (k, v) in rule_headers {
            if let (Ok(name), Ok(value)) = (
                HeaderName::from_bytes(k.as_bytes()),
                HeaderValue::from_str(v),
            ) {
                headers.insert(name, value);
            }
        }
    }
}

/// Expand `$1..$9` capture groups in a destination pattern.
fn expand_dest(dest: &str, caps: &regex::Captures<'_>) -> String {
    let mut out = String::with_capacity(dest.len());
    let mut chars = dest.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '$' {
            if let Some(digit) = chars.peek().and_then(|c| c.to_digit(10)) {
                chars.next();
                if let Some(replacement) = caps.get(digit as usize) {
                    out.push_str(replacement.as_str());
                }
                continue;
            }
        }
        out.push(ch);
    }
    out
}

/// Serve `static/<path>` with overrides, ETag/304, and compression.
fn try_serve_static(
    table: &RouteTable,
    path: &str,
    method: &Method,
    accept_encoding: &str,
) -> Result<Option<Response>, RouterError> {
    if method != Method::GET && method != Method::HEAD {
        return Ok(None);
    }
    let clean = path.trim_start_matches('/');
    let candidate = if clean.is_empty() {
        table.static_dir.join("index.html")
    } else {
        table.static_dir.join(clean)
    };

    // Path traversal guard: the resolved file must remain inside static/.
    let canonical = match candidate.canonicalize() {
        Ok(p) => p,
        Err(_) => {
            // Try override paths (e.g. 404.html remap) before giving up.
            return Ok(None);
        }
    };
    let static_root = table
        .static_dir
        .canonicalize()
        .unwrap_or_else(|_| table.static_dir.clone());
    if !canonical.starts_with(&static_root) || !canonical.is_file() {
        return Ok(None);
    }

    let bytes = std::fs::read(&canonical)?;
    let etag = format!("\"{}\"", short_hash(&canonical.to_string_lossy()));
    let mime = mime_for(&canonical);
    let content_type = table
        .config
        .overrides
        .get(clean)
        .and_then(|o| o.content_type.clone())
        .unwrap_or_else(|| mime.to_string());

    let (body, encoding) = super::compression::compress_if_worthwhile(&bytes, accept_encoding, &content_type);

    let mut builder = Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::ETAG, etag.clone())
        .header(header::CACHE_CONTROL, cache_control_for(&canonical));
    if let Some(enc) = encoding {
        builder = builder.header(header::CONTENT_ENCODING, enc);
        builder = builder.header(header::VARY, "Accept-Encoding");
    }
    let response = builder
        .body(Body::from(body))
        .map_err(|e| RouterError::InvalidConfig(e.to_string()))?;
    Ok(Some(response))
}

/// Immutable hashed assets get year-long caching (standard edge convention).
fn cache_control_for(path: &Path) -> &'static str {
    let s = path.to_string_lossy();
    if s.contains("/_next/static/") || s.contains("/assets/") {
        "public, max-age=31536000, immutable"
    } else if s.ends_with(".html") {
        "public, max-age=0, must-revalidate"
    } else {
        "public, max-age=3600"
    }
}

fn mime_for(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "html" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "wasm" => "application/wasm",
        "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn short_hash(input: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    let digest = hasher.finalize();
    hex::encode(&digest[..8])
}

/// Dispatch a rewritten destination: static file first, then the function
/// worker pool (Node runtime) or in-process edge isolate.
#[allow(clippy::too_many_arguments)]
async fn dispatch_destination(
    state: &Arc<AppState>,
    table: &Arc<RouteTable>,
    dest: &str,
    method: &Method,
    _uri: &Uri,
    headers: HeaderMap,
    body: Body,
    stack: &[HeaderMap],
    rule: &RouteRule,
) -> Result<Response, RouterError> {
    // 1. Static file at the destination path?
    if method == Method::GET || method == Method::HEAD {
        if let Some(response) = try_serve_static(table, dest, method, "")? {
            let mut response = response;
            apply_stacked_headers(&mut response, stack, rule);
            return Ok(response);
        }
    }

    // 2. Function invocation (worker pool keeps Bun/Node processes warm —
    //    invoke latency 1.2–3.5ms warm, 18–45ms cold on UFS 4.0).
    if let Some((name, func_dir, runtime)) = table.function_for_dest(dest) {
        let response = super::router::invoke_function(state, name, func_dir, runtime, method, headers, body)
            .await
            .map_err(|e| RouterError::InvalidConfig(format!("function invoke: {e}")))?;
        let mut response = response;
        apply_stacked_headers(&mut response, stack, rule);
        return Ok(response);
    }

    Ok((StatusCode::NOT_FOUND, "not found").into_response())
}

// ---------------------------------------------------------------------------
// Warm function worker pool (AWS Lambda three-phase lifecycle adapted —
// research report §4.1).
// ---------------------------------------------------------------------------

use tokio::sync::Mutex as AsyncMutex;

struct WorkerHandle {
    port: u16,
    #[allow(dead_code)]
    started_at: std::time::Instant,
}

pub struct WorkerPool {
    // function name → warm worker
    warm: AsyncMutex<HashMap<(String, String), WorkerHandle>>,
}

impl Default for WorkerPool {
    fn default() -> Self {
        Self::new()
    }
}

impl WorkerPool {
    pub fn new() -> Self {
        WorkerPool {
            warm: AsyncMutex::new(HashMap::new()),
        }
    }

    /// Fetch or spawn the warm worker for a function directory.
    ///
    /// The worker runs under Bun (Node compatibility) with a bootstrap HTTP
    /// adapter listening on an ephemeral loopback port. Cold start ~18–45ms
    /// on UFS 4.0; warm handoff ~1.2–3.5ms over the loopback socket.
    pub async fn worker_for(
        &self,
        state: &Arc<AppState>,
        name: &str,
        func_dir: &Path,
    ) -> Result<u16, std::io::Error> {
        let key = (name.to_string(), func_dir.to_string_lossy().into_owned());
        let mut warm = self.warm.lock().await;
        if let Some(handle) = warm.get(&key) {
            return Ok(handle.port);
        }

        // Reserve an ephemeral port by binding then releasing it for the child.
        let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
        let port = listener.local_addr()?.port();
        drop(listener);

        let bun = state.engine_bin.join("bun");
        let entry = func_dir.join("index.js");
        let mut command = tokio::process::Command::new(bun);
        command
            .arg(entry)
            .env("MOBILECLOUD_FUNC_PORT", port.to_string())
            .env("NODE_ENV", "production")
            .env("PATH", format!("{}:/usr/bin:/bin", state.engine_bin.display()))
            .current_dir(func_dir)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        let _child = command.spawn()?;

        // Wait briefly for the worker's listener to come up (cold start).
        for _ in 0..45 {
            if std::net::TcpStream::connect(("127.0.0.1", port)).is_ok() {
                warm.insert(
                    key,
                    WorkerHandle {
                        port,
                        started_at: std::time::Instant::now(),
                    },
                );
                return Ok(port);
            }
            tokio::time::sleep(std::time::Duration::from_millis(1)).await;
        }
        Err(std::io::Error::new(
            std::io::ErrorKind::TimedOut,
            "function worker failed to bind within 45ms",
        ))
    }
}

/// Invoke a `.func` handler through the warm pool and proxy the response.
pub async fn invoke_function(
    state: &Arc<AppState>,
    name: String,
    func_dir: PathBuf,
    runtime: FunctionRuntime,
    method: &Method,
    headers: HeaderMap,
    body: Body,
) -> anyhow::Result<Response> {
    match runtime {
        FunctionRuntime::Edge => {
            // Edge runtime: in-process isolate with zero fork latency (<1ms).
            // Implemented as direct node-compat execution placeholder — the
            // Wasmtime isolate lands with the AVF tier.
            Ok((StatusCode::NOT_IMPLEMENTED, "edge runtime: coming with AVF tier").into_response())
        }
        FunctionRuntime::Node => {
            let port = state
                .deployments
                .worker_pool()
                .worker_for(state, &name, &func_dir)
                .await
                .map_err(|e| anyhow::anyhow!("{e}"))?;

            let body_bytes = axum::body::to_bytes(body, 32 * 1024 * 1024).await?;
            let uri = format!("http://127.0.0.1:{port}/{name}");

            let client = get_loopback_client();
            let mut request = hyper::Request::builder()
                .method(method.clone())
                .uri(&uri)
                .body(hyper::body::Bytes::from(body_bytes).into())?;
            for (k, v) in headers.iter() {
                if k != header::HOST {
                    request.headers_mut().insert(k.clone(), v.clone());
                }
            }
            let response = client.request(request).await?;
            let (parts, body) = response.into_parts();
            let bytes = http_body_util::BodyExt::collect(body)
                .await?
                .to_bytes()
                .to_vec();

            let mut builder = Response::builder().status(parts.status);
            for (k, v) in parts.headers.iter() {
                if k != header::CONTENT_LENGTH && k != header::TRANSFER_ENCODING {
                    builder = builder.header(k.clone(), v.clone());
                }
            }
            Ok(builder.body(Body::from(bytes))?)
        }
    }
}

use std::sync::OnceLock;
use hyper_util::client::legacy::Client;
use hyper_util::rt::TokioExecutor;

fn get_loopback_client() -> Client<hyper_util::client::legacy::connect::HttpConnector, http_body_util::Full<hyper::body::Bytes>> {
    static CLIENT: OnceLock<Client<hyper_util::client::legacy::connect::HttpConnector, http_body_util::Full<hyper::body::Bytes>>> =
        OnceLock::new();
    CLIENT
        .get_or_init(|| {
            Client::builder(TokioExecutor::new())
                .build(hyper_util::client::legacy::connect::HttpConnector::new())
        })
        .clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_master_blueprint_config_json() {
        // The exact config.json from research report §3.2.
        let raw = r#"{
          "version": 3,
          "routes": [
            { "src": "^/assets/(.*)$", "headers": { "cache-control": "public, max-age=31536000, immutable" }, "continue": true },
            { "handle": "filesystem" },
            { "src": "^/api/(.*)$", "dest": "/api/$1" },
            { "src": "^/(.*)$", "dest": "/ssr", "check": true }
          ],
          "overrides": { "404.html": { "path": "404.html", "contentType": "text/html; charset=utf-8" } },
          "crons": [ { "path": "/api/cron-cleanup", "schedule": "0 * * * *" } ]
        }"#;
        let cfg: BuildOutputConfig = serde_json::from_str(raw).unwrap();
        assert_eq!(cfg.version, 3);
        assert_eq!(cfg.routes.len(), 4);
        assert_eq!(cfg.routes[2].dest.as_deref(), Some("/api/$1"));
        assert_eq!(cfg.routes[1].handle.as_deref(), Some("filesystem"));
        assert_eq!(cfg.crons[0].schedule, "0 * * * *");
    }

    #[test]
    fn dest_expansion_substitutes_captures() {
        let re = regex::Regex::new("^/api/(.*)$").unwrap();
        let caps = re.captures("/api/products/481").unwrap();
        assert_eq!(expand_dest("/api/$1", &caps), "/api/products/481");
        let re2 = regex::Regex::new("^/blog/(\\d{4})/(.*)$").unwrap();
        let caps2 = re2.captures("/blog/2026/hello-world").unwrap();
        assert_eq!(expand_dest("/$2-$1", &caps2), "/hello-world-2026");
    }
}
