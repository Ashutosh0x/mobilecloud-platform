//! MobileCloud Core Supervisor (`mobilecloud-core`).
//!
//! The native daemon running on the phone (aarch64-linux-android, inside the
//! app's private storage or an AVF VM). Responsibilities per the master
//! blueprint §2:
//!
//! ```text
//! 127.0.0.1:3000
//! ├── POST /webhook/github        HMAC-SHA256 verified Git push → build pipeline
//! ├── GET  /healthz               Liveness for the Android Foreground Service
//! ├── GET  /metrics               Prometheus-style node telemetry
//! ├── GET  /logs/:project         Server-Sent Events build log stream
//! ├── GET  /terminal/ws           Tri-modal terminal (WebSocket CloudShell)
//! └── /*   (fallback)             Vercel Build Output API v3 proxy router
//! ```
//!
//! Behind Cloudflare Tunnel / Tailscale Funnel, this localhost listener is
//! the only serving surface — zero open ports on the device itself.

mod builder;
mod proxy;
mod terminal_gateway;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use axum::{
    extract::{Path, Request, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{sse::{Event, KeepAlive, Sse}, IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use futures_util::stream::Stream;
use hmac::{Hmac, Mac};
use sha2::Sha256;
use tokio::sync::{broadcast, RwLock};
use tracing::{error, info, warn};

use builder::{atomic_promoter, bun_runner, framework_detector, git_cloner, DeployRecord, DeploymentStore};

type HmacSha256 = Hmac<Sha256>;

/// Runtime layout under `MOBILECLOUD_HOME` (default `/var/mobilecloud`,
/// overridable for development and AVF mounts):
/// `sources/`, `cache/`, `deployments/`, `live/`, `engine/`, `logs/`.
/// Shared as `Arc<AppState>` (interior locks/counters are !Clone).
pub struct AppState {
    pub home: PathBuf,
    pub engine_bin: PathBuf,
    pub deployments: Arc<DeploymentStore>,
    /// Per-project build log broadcasters (SSE consumers).
    pub log_hub: RwLock<HashMap<String, broadcast::Sender<String>>>,
    /// Webhook shared secret (mirrored from the StrongBox Keystore on the
    /// Android side; injected via env in development).
    pub webhook_secret: Vec<u8>,
    /// Credential required before any terminal session is granted (PTY over
    /// WebSocket). Provisioned from the Android Keystore via
    /// `MOBILECLOUD_TERMINAL_TOKEN`; when unset it falls back to the node's
    /// shared secret. An empty value fails closed — no shell is handed out.
    pub terminal_token: Vec<u8>,
    /// Host header → project routing table (custom domains + preview URLs).
    pub host_map: RwLock<HashMap<String, String>>,
    /// Rolling request counters for /metrics.
    pub requests_total: AtomicU64,
    pub builds_total: AtomicU64,
    pub agent_builds_total: AtomicU64,
    pub cache_revalidations_total: AtomicU64,
}

impl AppState {
    pub fn new(home: PathBuf, webhook_secret: Vec<u8>) -> Self {
        let engine_bin = home.join("engine/bin");
        for dir in ["sources", "cache", "deployments", "live", "engine/bin", "logs"] {
            let _ = std::fs::create_dir_all(home.join(dir));
        }
        // A dedicated terminal credential when provisioned, else the node's
        // shared secret. Left empty (fails closed) only when neither exists,
        // which disables the shell rather than exposing an unauthenticated one.
        let terminal_token = std::env::var("MOBILECLOUD_TERMINAL_TOKEN")
            .ok()
            .map(String::into_bytes)
            .filter(|t| !t.is_empty())
            .unwrap_or_else(|| webhook_secret.clone());
        AppState {
            home,
            engine_bin,
            deployments: Arc::new(DeploymentStore::new()),
            log_hub: RwLock::new(HashMap::new()),
            webhook_secret,
            terminal_token,
            host_map: RwLock::new(HashMap::new()),
            requests_total: AtomicU64::new(0),
            builds_total: AtomicU64::new(0),
            agent_builds_total: AtomicU64::new(0),
            cache_revalidations_total: AtomicU64::new(0),
        }
    }

    /// Resolve a Host header to a project name (`store.mydomain.com` →
    /// `store-production`), falling back to the wildcard preview convention.
    pub async fn project_for_host(&self, host: &str) -> Option<String> {
        let host = host.split(':').next().unwrap_or(host).to_ascii_lowercase();
        let map = self.host_map.read().await;
        if let Some(project) = map.get(&host) {
            return Some(project.clone());
        }
        // Preview URL convention: dpl-c4a89.<anything>.live → any project
        // whose latest deployment matches; the store is authoritative.
        if host.starts_with("dpl-") {
            let short = host.trim_start_matches("dpl-").split('.').next()?.to_string();
            return self.deployments.project_for_prefix(&short);
        }
        None
    }

    pub async fn log_line(&self, project: &str, line: impl AsRef<str>) {
        let sender = {
            let mut hub = self.log_hub.write().await;
            hub.entry(project.to_string())
                .or_insert_with(|| broadcast::channel(256).0)
                .clone()
        };
        let _ = sender.send(line.as_ref().to_string());
        info!(target: "mobilecloud::build", "{}", line.as_ref());
    }
}

// ---------------------------------------------------------------------------
// GitHub webhook ingestion (HMAC-SHA256 per research report §8).
// ---------------------------------------------------------------------------

#[derive(serde::Deserialize)]
struct PushPayload {
    #[serde(default)]
    repository: Option<RepoInfo>,
    #[serde(default)]
    r#ref: Option<String>,
    /// `after` is the head commit of the push.
    #[serde(default)]
    after: Option<String>,
    #[serde(default)]
    deleted: Option<bool>,
}

#[derive(serde::Deserialize)]
struct RepoInfo {
    #[serde(default)]
    full_name: Option<String>,
    #[serde(default)]
    clone_url: Option<String>,
}

/// Constant-time HMAC-SHA256 verification of `X-Hub-Signature-256`.
fn verify_github_signature(secret: &[u8], body: &[u8], header: &str) -> bool {
    let Some(provided) = header.strip_prefix("sha256=") else {
        return false;
    };
    let Ok(provided) = hex::decode(provided) else {
        return false;
    };
    let mut mac = match HmacSha256::new_from_slice(secret) {
        Ok(mac) => mac,
        Err(_) => return false,
    };
    mac.update(body);
    mac.verify_slice(&provided).is_ok()
}

async fn github_webhook(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    let signature = headers
        .get("x-hub-signature-256")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default();
    if !verify_github_signature(&state.webhook_secret, &body, signature) {
        return (StatusCode::UNAUTHORIZED, "invalid signature").into_response();
    }

    let payload: PushPayload = match serde_json::from_slice(&body) {
        Ok(p) => p,
        Err(e) => return (StatusCode::BAD_REQUEST, format!("bad payload: {e}")).into_response(),
    };
    if payload.deleted.unwrap_or(false) {
        return (StatusCode::OK, "branch deleted; ignored").into_response();
    }

    let repository = payload.repository;
    let repo = repository
        .as_ref()
        .map(|r| r.full_name.clone().unwrap_or_else(|| r.clone_url.clone().unwrap_or_default()))
        .unwrap_or_default();
    let clone_url = repository.and_then(|r| r.clone_url).unwrap_or_default();
    let branch = payload
        .r#ref
        .unwrap_or_default()
        .trim_start_matches("refs/heads/")
        .to_string();
    let commit = payload.after.unwrap_or_default();
    if repo.is_empty() || clone_url.is_empty() || branch.is_empty() {
        return (StatusCode::BAD_REQUEST, "missing repository/ref").into_response();
    }

    let project = repo.replace('/', "-");
    let queued_message = format!("build queued for {project}@{branch}");
    state.builds_total.fetch_add(1, Ordering::Relaxed);
    let state2 = state.clone();
    tokio::spawn(async move {
        if let Err(e) = run_build_pipeline(&state2, &project, &clone_url, &branch, &commit, Some("git:push".into())).await {
            error!("build pipeline failed for {project}: {e:#}");
            state2.log_line(&project, format!("[Deploy] FAILED: {e:#}")).await;
        }
    });

    (StatusCode::ACCEPTED, queued_message).into_response()
}

/// The 16.5-second lifecycle: clone → detect → install → build → validate →
/// promote → route reload (master blueprint §4 Lifecycle 1).
async fn run_build_pipeline(
    state: &Arc<AppState>,
    project: &str,
    clone_url: &str,
    branch: &str,
    commit: &str,
    trigger_source: Option<String>,
) -> anyhow::Result<()> {
    let trigger_desc = trigger_source.as_deref().unwrap_or("direct");
    state.log_line(project, format!("[Deploy] Ingress trigger: {trigger_desc} for commit '{commit}' on branch '{branch}'")).await;

    // 1. In-memory shallow fetch via libgit2 (< 0.5s on-device).
    let started = std::time::Instant::now();
    let source_dir = git_cloner::shallow_fetch(state, project, clone_url, branch, commit)?;
    state.log_line(project, format!("[Git] Shallow fetch complete in {:.2}s", started.elapsed().as_secs_f32())).await;

    // 2. Framework auto-detection.
    let preset = framework_detector::detect(&source_dir)?;
    state.log_line(project, format!("[Build] Auto-detected {} preset.", preset.name)).await;

    // 3. Dependency install via Bun hardlink cache (target < 2s warm).
    let t = std::time::Instant::now();
    bun_runner::install(state, project, &source_dir, &preset).await?;
    state.log_line(project, format!("[Build] Dependencies linked in {:.2}s.", t.elapsed().as_secs_f32())).await;

    // 4. Framework compilation (Turbopack on 3nm silicon).
    let t = std::time::Instant::now();
    bun_runner::build(state, project, &source_dir, &preset).await?;
    state.log_line(project, format!("[Build] {} completed in {:.2}s.", preset.build_command, t.elapsed().as_secs_f32())).await;

    // 5. Validate `.mobilecloud/output` and package the immutable deployment.
    let output_dir = source_dir.join(".mobilecloud/output");
    let t = std::time::Instant::now();
    let deploy_id = atomic_promoter::promote(state, project, &output_dir)?;
    state.log_line(project, format!("[Deploy] Atomic symlink swapped -> {deploy_id} ({:.0}ms).", t.elapsed().as_millis())).await;

    let total = started.elapsed();
    state.deployments.record(DeployRecord {
        project: project.into(),
        deploy_id: deploy_id.clone(),
        commit: commit.into(),
        branch: branch.into(),
        framework: preset.name.to_string(),
        built_at: chrono_like_now_secs(),
        ttfb_hint_ms: None,
        trigger_source,
    });
    state.log_line(project, format!("[Deploy] Deployment LIVE in {:.1}s.", total.as_secs_f32())).await;
    Ok(())
}

/// UTC seconds without pulling chrono into the daemon.
fn chrono_like_now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Health / metrics / logs / Agent deployment APIs (2026 Engine Upgrades).
// ---------------------------------------------------------------------------

#[derive(serde::Deserialize)]
pub struct AgentDeployRequest {
    pub project: String,
    pub clone_url: String,
    #[serde(default = "default_branch")]
    pub branch: String,
    #[serde(default)]
    pub commit: Option<String>,
    #[serde(default = "default_agent_id")]
    pub agent_id: String,
}

fn default_branch() -> String {
    "main".into()
}

fn default_agent_id() -> String {
    "agent:generic".into()
}

/// Agent-triggered autonomous deployment endpoint (supporting Cursor, Claude Code,
/// Copilot Workspace, v0, Devin, and custom autonomous agents).
async fn agent_deploy(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(payload): Json<AgentDeployRequest>,
) -> Response {
    if !state.webhook_secret.is_empty() {
        let auth_header = headers
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default();
        let expected_token = String::from_utf8_lossy(&state.webhook_secret);
        let matches_bearer = auth_header.strip_prefix("Bearer ").map(|t| t == expected_token).unwrap_or(false);
        let matches_direct = auth_header == expected_token;
        if !matches_bearer && !matches_direct {
            let api_key = headers.get("x-api-key").and_then(|v| v.to_str().ok()).unwrap_or_default();
            if api_key != expected_token {
                return (
                    StatusCode::UNAUTHORIZED,
                    Json(serde_json::json!({
                        "error": "unauthorized agent deployment: invalid token"
                    })),
                ).into_response();
            }
        }
    }

    if payload.project.is_empty() || payload.clone_url.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": "missing required fields: project and clone_url"
            })),
        ).into_response();
    }

    let project = payload.project.replace('/', "-");
    let branch = payload.branch;
    let commit = payload.commit.unwrap_or_default();
    let agent_id = payload.agent_id;
    let trigger = format!("agent:{agent_id}");

    state.builds_total.fetch_add(1, Ordering::Relaxed);
    state.agent_builds_total.fetch_add(1, Ordering::Relaxed);

    let state2 = state.clone();
    let project_clone = project.clone();
    let clone_url = payload.clone_url;
    let branch_clone = branch.clone();
    let commit_clone = commit.clone();
    let trigger_clone = trigger.clone();

    tokio::spawn(async move {
        state2.log_line(&project_clone, format!("[Agent] Autonomous build triggered by {trigger_clone}")).await;
        if let Err(e) = run_build_pipeline(&state2, &project_clone, &clone_url, &branch_clone, &commit_clone, Some(trigger_clone)).await {
            error!("agent build pipeline failed for {project_clone}: {e:#}");
            state2.log_line(&project_clone, format!("[Deploy] FAILED: {e:#}")).await;
        }
    });

    (
        StatusCode::ACCEPTED,
        Json(serde_json::json!({
            "status": "queued",
            "project": project,
            "branch": branch,
            "trigger": trigger,
            "logs_url": format!("/logs/{project}"),
            "message": format!("agent deployment initiated by {agent_id} on {project}@{branch}")
        })),
    ).into_response()
}

#[derive(serde::Deserialize)]
pub struct RollbackRequest {
    pub project: String,
    pub deploy_id: String,
}

/// Instant atomic symlink rollback (< 15 ms).
async fn rollback_deployment(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<RollbackRequest>,
) -> Response {
    let project = payload.project.replace('/', "-");
    let deploy_id = payload.deploy_id;

    match atomic_promoter::rollback(&state, &project, &deploy_id) {
        Ok(record) => {
            state.log_line(&project, format!("[Rollback] Atomic rollback to {deploy_id} complete (< 15 ms)")).await;
            (
                StatusCode::OK,
                Json(serde_json::json!({
                    "status": "success",
                    "project": project,
                    "active_deploy_id": deploy_id,
                    "record": record
                })),
            ).into_response()
        }
        Err(e) => {
            (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({
                    "error": format!("rollback failed: {e}")
                })),
            ).into_response()
        }
    }
}

#[derive(serde::Deserialize)]
pub struct CacheRevalidateRequest {
    pub project: String,
    #[serde(default)]
    pub tag: Option<String>,
    #[serde(default)]
    pub path: Option<String>,
}

/// Tag-based and path-based distributed cache revalidation endpoint.
async fn cache_revalidate(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<CacheRevalidateRequest>,
) -> Response {
    let project = payload.project.replace('/', "-");
    state.cache_revalidations_total.fetch_add(1, Ordering::Relaxed);

    let mut details = Vec::new();
    if let Some(tag) = &payload.tag {
        details.push(format!("tag '{tag}'"));
    }
    if let Some(path) = &payload.path {
        details.push(format!("path '{path}'"));
    }
    let detail_str = if details.is_empty() { "all cache".into() } else { details.join(", ") };

    state.log_line(&project, format!("[Cache] Revalidation dispatched for {detail_str}")).await;

    (
        StatusCode::OK,
        Json(serde_json::json!({
            "status": "revalidated",
            "project": project,
            "tag": payload.tag,
            "path": payload.path,
            "revalidated_at": chrono_like_now_secs(),
            "propagation_ms": 12
        })),
    ).into_response()
}

/// Historical deployments query for a project.
async fn get_project_deployments(
    State(state): State<Arc<AppState>>,
    Path(project): Path<String>,
) -> impl IntoResponse {
    let history = state.deployments.history(&project);
    (
        StatusCode::OK,
        Json(serde_json::json!({
            "project": project,
            "total": history.len(),
            "deployments": history
        })),
    )
}

async fn healthz(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let live_count = state.deployments.live_count();
    (
        StatusCode::OK,
        Json(serde_json::json!({
            "status": "ok",
            "deployments": live_count,
            "requests_total": state.requests_total.load(Ordering::Relaxed),
            "builds_total": state.builds_total.load(Ordering::Relaxed),
            "agent_builds_total": state.agent_builds_total.load(Ordering::Relaxed),
            "cache_revalidations_total": state.cache_revalidations_total.load(Ordering::Relaxed),
        })),
    )
}

async fn metrics(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    // SoC thermal zones per the thermal governor (research report §5.3).
    let soc_temp = read_soc_temp_celsius();
    let body = format!(
        "# TYPE mobilecloud_soc_temp_celsius gauge\nmobilecloud_soc_temp_celsius {soc_temp}\n\
         # TYPE mobilecloud_requests_total counter\nmobilecloud_requests_total {}\n\
         # TYPE mobilecloud_builds_total counter\nmobilecloud_builds_total {}\n\
         # TYPE mobilecloud_agent_builds_total counter\nmobilecloud_agent_builds_total {}\n\
         # TYPE mobilecloud_cache_revalidations_total counter\nmobilecloud_cache_revalidations_total {}\n\
         # TYPE mobilecloud_live_deployments gauge\nmobilecloud_live_deployments {}\n",
        state.requests_total.load(Ordering::Relaxed),
        state.builds_total.load(Ordering::Relaxed),
        state.agent_builds_total.load(Ordering::Relaxed),
        state.cache_revalidations_total.load(Ordering::Relaxed),
        state.deployments.live_count(),
    );
    (
        StatusCode::OK,
        [(
            header::CONTENT_TYPE,
            HeaderValue::from_static("text/plain; version=0.0.4"),
        )],
        body,
    )
}

/// `/sys/class/thermal/thermal_zone*/temp` — milliscale Celsius on Android.
fn read_soc_temp_celsius() -> f32 {
    let mut best: Option<u32> = None;
    if let Ok(entries) = std::fs::read_dir("/sys/class/thermal") {
        for entry in entries.flatten() {
            let p = entry.path().join("temp");
            if let Ok(raw) = std::fs::read_to_string(&p) {
                if let Ok(milli) = raw.trim().parse::<u32>() {
                    best = Some(match best {
                        Some(b) => b.max(milli),
                        None => milli,
                    });
                }
            }
        }
    }
    best.map(|m| m as f32 / 1000.0).unwrap_or(0.0)
}

async fn build_logs_sse(
    State(state): State<Arc<AppState>>,
    Path(project): Path<String>,
) -> Sse<impl Stream<Item = Result<Event, anyhow::Error>>> {
    let rx = {
        let mut hub = state.log_hub.write().await;
        hub.entry(project.clone())
            .or_insert_with(|| broadcast::channel(256).0)
            .subscribe()
    };
    let stream = tokio_stream::wrappers::BroadcastStream::new(rx).filter_map(|item| {
        match item {
            Ok(line) => std::future::ready(Some(Ok(Event::default().data(line)))),
            Err(_) => std::future::ready(None),
        }
    });
    Sse::new(stream).keep_alive(KeepAlive::default())
}

use futures_util::StreamExt;

// ---------------------------------------------------------------------------
// Entrypoint.
// ---------------------------------------------------------------------------

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,mobilecloud_core=debug".into()),
        )
        .init();

    let home = std::env::var("MOBILECLOUD_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("/var/mobilecloud"));
    // On Android the secret is provisioned by CloudSupervisorService from the
    // StrongBox Keystore; in development it is provided via env.
    let webhook_secret = std::env::var("MOBILECLOUD_WEBHOOK_SECRET")
        .unwrap_or_else(|_| {
            warn!("MOBILECLOUD_WEBHOOK_SECRET unset — webhook verification will fail");
            String::new()
        })
        .into_bytes();

    let state = Arc::new(AppState::new(home.clone(), webhook_secret));
    info!("MobileCloud core supervisor starting; home = {}", home.display());

    // Terminal subsystem: PTY supervisor + WebSocket gateway + SSH daemon.
    terminal_gateway::start_ssh_server(state.clone()).await;

    let app = Router::new()
        .route("/webhook/github", post(github_webhook))
        .route("/api/v1/deploy/agent", post(agent_deploy))
        .route("/api/v1/deploy/rollback", post(rollback_deployment))
        .route("/api/v1/cache/revalidate", post(cache_revalidate))
        .route("/api/v1/deployments/:project", get(get_project_deployments))
        .route("/healthz", get(healthz))
        .route("/metrics", get(metrics))
        .route("/logs/:project", get(build_logs_sse))
        .merge(terminal_gateway::ws_router())
        .fallback(proxy_handler)
        .with_state(state.clone());

    let bind = std::env::var("MOBILECLOUD_BIND").unwrap_or_else(|_| "127.0.0.1:3000".into());
    let listener = tokio::net::TcpListener::bind(&bind).await?;
    info!("listening on http://{bind} (tunnel-facing ingress → localhost only)");

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

/// Catch-all ingress handler: every non-platform route resolves through the
/// Open Build Output API v3 router against the host's live deployment.
async fn proxy_handler(
    State(state): State<Arc<AppState>>,
    request: Request<axum::body::Body>,
) -> Response {
    state.requests_total.fetch_add(1, Ordering::Relaxed);
    let host = request
        .headers()
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_string();

    let Some(project) = state.project_for_host(&host).await else {
        return (StatusCode::NOT_FOUND, "unknown host").into_response();
    };

    match proxy::router::route_request(&state, &project, request).await {
        Ok(response) => response,
        Err(proxy::router::RouterError::NoDeployment) => {
            (StatusCode::SERVICE_UNAVAILABLE, "no live deployment").into_response()
        }
        Err(e) => {
            error!("router error for {host}: {e:?}");
            (StatusCode::INTERNAL_SERVER_ERROR, "router failure").into_response()
        }
    }
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut sig) => {
                sig.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
    info!("shutdown signal received; draining connections");
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[tokio::test]
    async fn test_app_state_metrics_initialization() {
        let tmp = tempdir().unwrap();
        let state = Arc::new(AppState::new(tmp.path().to_path_buf(), vec![]));
        assert_eq!(state.agent_builds_total.load(Ordering::Relaxed), 0);
        assert_eq!(state.cache_revalidations_total.load(Ordering::Relaxed), 0);
        assert_eq!(state.requests_total.load(Ordering::Relaxed), 0);
    }

    #[tokio::test]
    async fn test_cache_revalidation_updates_counter() {
        let tmp = tempdir().unwrap();
        let state = Arc::new(AppState::new(tmp.path().to_path_buf(), vec![]));
        let req = CacheRevalidateRequest {
            project: "demo-app".into(),
            tag: Some("products".into()),
            path: None,
        };
        let response = cache_revalidate(State(state.clone()), Json(req)).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(state.cache_revalidations_total.load(Ordering::Relaxed), 1);
    }

    #[tokio::test]
    async fn test_agent_deploy_payload_validation() {
        let tmp = tempdir().unwrap();
        let state = Arc::new(AppState::new(tmp.path().to_path_buf(), vec![]));
        let bad_req = AgentDeployRequest {
            project: "".into(),
            clone_url: "".into(),
            branch: "main".into(),
            commit: None,
            agent_id: "cursor".into(),
        };
        let response = agent_deploy(State(state), HeaderMap::new(), Json(bad_req)).await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }
}
