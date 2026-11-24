//! MobileCloud engine: private operator API and a separate static deployment listener.

mod builder;
mod proxy;
mod terminal_gateway;

use std::collections::{HashMap, HashSet};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use axum::{
    extract::{rejection::JsonRejection, DefaultBodyLimit, Path, Request, State},
    http::{header, uri::Authority, HeaderMap, StatusCode},
    middleware::{self, Next},
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse, Response,
    },
    routing::{get, post},
    Json, Router,
};
use futures_util::StreamExt;
use hmac::{Hmac, Mac};
use sha2::Sha256;
use tokio::sync::{broadcast, Semaphore};
use tracing::{error, info, warn};

use builder::{
    atomic_promoter, bun_runner, framework_detector, git_cloner, DeployRecord, DeploymentStore,
};

type HmacSha256 = Hmac<Sha256>;

/// Each engine is a single operator trust domain, not a shared tenant backend.
/// E.g. MOBILECLOUD_PREVIEW_PROJECTS='{"demo":{"repository":"owner/repo","branch":"main"}}'.
/// The optional exact `host` enables serving that project on the deployment listener.
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct PreviewProject {
    repository: String,
    branch: String,
    host: Option<String>,
}

impl PreviewProject {
    fn clone_url(&self) -> String {
        format!("https://github.com/{}.git", self.repository)
    }
}

fn valid_projects(projects: &HashMap<String, PreviewProject>) -> bool {
    let mut refs = HashSet::new();
    let mut hosts = HashSet::new();
    projects.iter().all(|(project, config)| {
        let repo_ok = config
            .repository
            .split_once('/')
            .is_some_and(|(owner, repo)| {
                let valid = |part: &str| {
                    !part.is_empty()
                        && part.len() <= 100
                        && part != "."
                        && part != ".."
                        && part
                            .bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
                };
                valid(owner) && valid(repo) && !repo.to_ascii_lowercase().ends_with(".git")
            });
        let host_ok = config.host.as_deref().is_none_or(|host| {
            host.len() <= 253
                && host.contains('.')
                && host.split('.').all(builder::valid_project)
                && host != "admin.phone.mobilecloud.live"
                && hosts.insert(host)
        });
        builder::valid_project(project)
            && repo_ok
            && host_ok
            && !config.branch.is_empty()
            && config.branch.len() <= 255
            && git2::Reference::is_valid_name(&format!("refs/heads/{}", config.branch))
            && refs.insert((
                config.repository.to_ascii_lowercase(),
                config.branch.as_str(),
            ))
    })
}

pub struct AppState {
    pub home: PathBuf,
    pub engine_bin: PathBuf,
    deployments: DeploymentStore,
    projects: HashMap<String, PreviewProject>,
    logs: HashMap<String, broadcast::Sender<String>>,
    trusted_preview: bool,
    build_slot: Arc<Semaphore>,
    deployment_slots: Arc<Semaphore>,
    operator_token: Vec<u8>,
    webhook_secret: Vec<u8>,
    terminal_token: Vec<u8>,
    requests_total: AtomicU64,
    builds_total: AtomicU64,
    agent_builds_total: AtomicU64,
}

impl AppState {
    fn new(home: PathBuf, projects: HashMap<String, PreviewProject>) -> anyhow::Result<Self> {
        anyhow::ensure!(
            valid_projects(&projects),
            "invalid or ambiguous MOBILECLOUD_PREVIEW_PROJECTS"
        );
        let home = std::path::absolute(home)?;
        for dir in ["sources", "deployments", "engine/bin", "home"] {
            std::fs::create_dir_all(home.join(dir))?;
        }
        let logs = projects
            .keys()
            .map(|project| (project.clone(), broadcast::channel(256).0))
            .collect();
        Ok(Self {
            engine_bin: home.join("engine/bin"),
            deployments: DeploymentStore::new(home.join("deployments")),
            home,
            projects,
            logs,
            trusted_preview: false,
            build_slot: Arc::new(Semaphore::new(1)),
            deployment_slots: Arc::new(Semaphore::new(16)),
            operator_token: Vec::new(),
            webhook_secret: Vec::new(),
            terminal_token: Vec::new(),
            requests_total: AtomicU64::new(0),
            builds_total: AtomicU64::new(0),
            agent_builds_total: AtomicU64::new(0),
        })
    }

    pub fn log_line(&self, project: &str, line: impl AsRef<str>) {
        // Raw child output goes only to authenticated, transient SSE subscribers.
        // Do not copy repository output into supervisor or ingress logs.
        if let Some(sender) = self.logs.get(project) {
            let _ = sender.send(line.as_ref().to_string());
        }
    }

    fn preview_enabled(&self) -> bool {
        self.trusted_preview && !self.projects.is_empty()
    }
}

fn env_flag(name: &str) -> bool {
    std::env::var(name).as_deref() == Ok("1")
}

fn credential(name: &str) -> Vec<u8> {
    std::env::var(name)
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_default()
        .into_bytes()
}

// An empty expected credential never authenticates. Verify a fixed-size MAC so
// matching a prefix of the configured credential gives no comparison signal.
fn token_matches(expected: &[u8], presented: &[u8]) -> bool {
    if expected.is_empty() || presented.is_empty() {
        return false;
    }
    let mut mac =
        HmacSha256::new_from_slice(b"mobilecloud credential comparison v1").expect("valid key");
    let mut actual = mac.clone();
    actual.update(presented);
    mac.update(expected);
    mac.verify_slice(&actual.finalize().into_bytes()).is_ok()
}

fn bearer(headers: &HeaderMap) -> Option<&[u8]> {
    headers
        .get(header::AUTHORIZATION)?
        .as_bytes()
        .strip_prefix(b"Bearer ")
}

async fn operator_auth(
    State(state): State<Arc<AppState>>,
    request: Request,
    next: Next,
) -> Response {
    let headers = request.headers();
    if headers.contains_key(header::ORIGIN)
        || !bearer(headers).is_some_and(|value| token_matches(&state.operator_token, value))
    {
        return (
            StatusCode::UNAUTHORIZED,
            "operator bearer credential required",
        )
            .into_response();
    }
    let mut response = next.run(request).await;
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("no-store"),
    );
    response
}

fn verify_github_signature(secret: &[u8], body: &[u8], signature: &str) -> bool {
    if secret.is_empty() {
        return false;
    }
    let Some(provided) = signature
        .strip_prefix("sha256=")
        .and_then(|value| hex::decode(value).ok())
    else {
        return false;
    };
    let mut mac = HmacSha256::new_from_slice(secret).expect("valid key length");
    mac.update(body);
    mac.verify_slice(&provided).is_ok()
}

#[derive(serde::Deserialize)]
struct PushPayload {
    repository: RepoInfo,
    #[serde(rename = "ref")]
    git_ref: String,
    after: String,
    #[serde(default)]
    deleted: bool,
}

#[derive(serde::Deserialize)]
struct RepoInfo {
    full_name: String,
}

fn preview_disabled() -> Response {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        "trusted local preview builds are disabled",
    )
        .into_response()
}

async fn github_webhook(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    if !state.preview_enabled() || state.webhook_secret.is_empty() {
        return preview_disabled();
    }
    let signature = headers
        .get("x-hub-signature-256")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default();
    if headers.contains_key(header::ORIGIN)
        || !verify_github_signature(&state.webhook_secret, &body, signature)
    {
        return (StatusCode::UNAUTHORIZED, "invalid webhook signature").into_response();
    }
    if !headers.get("x-github-event").is_some_and(|v| v == "push") {
        return (StatusCode::OK, "non-push event ignored").into_response();
    }
    let Ok(payload) = serde_json::from_slice::<PushPayload>(&body) else {
        return (StatusCode::BAD_REQUEST, "invalid push payload").into_response();
    };
    if payload.deleted {
        return (StatusCode::OK, "branch deleted; ignored").into_response();
    }
    let Some(branch) = payload.git_ref.strip_prefix("refs/heads/") else {
        return (StatusCode::OK, "non-branch event ignored").into_response();
    };
    let Some((project, _)) = state.projects.iter().find(|(_, configured)| {
        configured
            .repository
            .eq_ignore_ascii_case(&payload.repository.full_name)
            && configured.branch == branch
    }) else {
        return (
            StatusCode::FORBIDDEN,
            "repository/ref is not configured for local preview",
        )
            .into_response();
    };
    if !git_cloner::valid_commit(&payload.after) {
        return (StatusCode::BAD_REQUEST, "invalid commit").into_response();
    }
    let project = project.clone();
    match queue_build(
        state,
        project,
        Some(payload.after),
        "git:push".into(),
        false,
    ) {
        Ok(()) => (StatusCode::ACCEPTED, "trusted preview build queued").into_response(),
        Err(response) => response,
    }
}

#[derive(serde::Deserialize)]
struct AgentDeployRequest {
    project: String,
    clone_url: String,
    #[serde(default = "default_branch")]
    branch: String,
    commit: Option<String>,
    agent_id: Option<String>,
}

fn default_branch() -> String {
    "main".into()
}

fn parse_json<T>(body: Result<Json<T>, JsonRejection>) -> Result<T, Response> {
    body.map(|Json(payload)| payload)
        .map_err(|e| (e.status(), "invalid JSON request").into_response())
}

async fn agent_deploy(
    State(state): State<Arc<AppState>>,
    body: Result<Json<AgentDeployRequest>, JsonRejection>,
) -> Response {
    if !state.preview_enabled() {
        return preview_disabled();
    }
    let payload = match parse_json(body) {
        Ok(payload) => payload,
        Err(response) => return response,
    };
    let configured = match project_config(&state, &payload.project) {
        Ok(config) => config,
        Err(response) => return response,
    };
    // Never fetch a URL supplied by a request, even if the caller is an operator.
    let canonical = configured.clone_url();
    if (payload.clone_url != canonical
        && Some(payload.clone_url.as_str()) != canonical.strip_suffix(".git"))
        || payload.branch != configured.branch
    {
        return (
            StatusCode::FORBIDDEN,
            "repository/ref is not configured for local preview",
        )
            .into_response();
    }
    if payload
        .commit
        .as_deref()
        .is_some_and(|id| !git_cloner::valid_commit(id))
    {
        return (StatusCode::BAD_REQUEST, "invalid commit").into_response();
    }
    let agent_id = payload.agent_id.as_deref().unwrap_or("generic");
    if agent_id.is_empty()
        || agent_id.len() > 64
        || !agent_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.:".contains(&b))
    {
        return (StatusCode::BAD_REQUEST, "invalid agent ID").into_response();
    }
    let trigger = format!("agent:{agent_id}");
    let project = payload.project;
    if let Err(response) = queue_build(
        state,
        project.clone(),
        payload.commit,
        trigger.clone(),
        true,
    ) {
        return response;
    }
    (
        StatusCode::ACCEPTED,
        Json(serde_json::json!({
            "status": "queued", "project": project, "branch": payload.branch,
            "trigger": trigger, "logs_url": format!("/logs/{project}"),
            "message": "trusted preview build queued"
        })),
    )
        .into_response()
}

fn queue_build(
    state: Arc<AppState>,
    project: String,
    commit: Option<String>,
    trigger: String,
    agent: bool,
) -> Result<(), Response> {
    let permit = state.build_slot.clone().try_acquire_owned().map_err(|_| {
        (
            StatusCode::TOO_MANY_REQUESTS,
            "preview builder busy; retry later",
        )
            .into_response()
    })?;
    state.builds_total.fetch_add(1, Ordering::Relaxed);
    if agent {
        state.agent_builds_total.fetch_add(1, Ordering::Relaxed);
    }
    tokio::spawn(async move {
        let _permit = permit;
        if let Err(e) = run_build_pipeline(&state, &project, commit, trigger).await {
            warn!(%project, "trusted preview build failed");
            state.log_line(&project, format!("[Deploy] FAILED: {e:#}"));
        }
    });
    Ok(())
}

async fn run_build_pipeline(
    state: &Arc<AppState>,
    project: &str,
    expected: Option<String>,
    trigger: String,
) -> anyhow::Result<()> {
    let config = &state.projects[project];
    let branch = config.branch.clone();
    let fetch_branch = branch.clone();
    let url = config.clone_url();
    let home = state.home.clone();
    let (checkout, commit) = tokio::task::spawn_blocking(move || {
        git_cloner::shallow_fetch(&home, &url, &fetch_branch, expected.as_deref())
    })
    .await??;
    let source_dir = checkout.path();
    let preset = framework_detector::detect(source_dir)?;
    anyhow::ensure!(
        preset.runtime == framework_detector::RuntimeKind::Static,
        "unsupported preview target: only static builds are supported"
    );
    state.log_line(project, format!("[Build] {} ({commit})", preset.name));
    bun_runner::install(state, project, source_dir, &preset).await?;
    bun_runner::build(state, project, source_dir, &preset).await?;

    let state_for_promote = state.clone();
    let record = DeployRecord {
        project: project.into(),
        deploy_id: String::new(),
        commit,
        branch,
        framework: preset.name.into(),
        built_at: now_secs(),
        ttfb_hint_ms: None,
        trigger_source: Some(trigger),
    };
    let id = tokio::task::spawn_blocking(move || {
        atomic_promoter::promote(
            &state_for_promote.deployments,
            record,
            &checkout,
            preset.output_dir,
        )
    })
    .await??;
    state.log_line(project, format!("[Deploy] Static preview active: {id}"));
    Ok(())
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn project_config<'a>(state: &'a AppState, project: &str) -> Result<&'a PreviewProject, Response> {
    if !builder::valid_project(project) {
        return Err((StatusCode::BAD_REQUEST, "invalid project identifier").into_response());
    }
    state
        .projects
        .get(project)
        .ok_or_else(|| (StatusCode::NOT_FOUND, "unknown preview project").into_response())
}

#[derive(serde::Deserialize)]
struct RollbackRequest {
    project: String,
    deploy_id: String,
}

async fn rollback_deployment(
    State(state): State<Arc<AppState>>,
    body: Result<Json<RollbackRequest>, JsonRejection>,
) -> Response {
    let RollbackRequest { project, deploy_id } = match parse_json(body) {
        Ok(payload) => payload,
        Err(response) => return response,
    };
    if let Err(response) = project_config(&state, &project) {
        return response;
    }
    if !builder::valid_deploy_id(&deploy_id) {
        return (StatusCode::BAD_REQUEST, "invalid deployment identifier").into_response();
    }
    let store_state = state.clone();
    let p = project.clone();
    let id = deploy_id.clone();
    match tokio::task::spawn_blocking(move || store_state.deployments.rollback(&p, &id)).await {
        Ok(Ok(Some(record))) => {
            state.log_line(
                &project,
                format!("[Rollback] Active deployment: {deploy_id}"),
            );
            Json(serde_json::json!({"status": "success", "project": project, "active_deploy_id": deploy_id, "record": record})).into_response()
        }
        Ok(Ok(None)) => (
            StatusCode::NOT_FOUND,
            "deployment artifact not found in this project",
        )
            .into_response(),
        _ => (
            StatusCode::INTERNAL_SERVER_ERROR,
            "rollback could not be completed",
        )
            .into_response(),
    }
}

#[derive(serde::Deserialize)]
struct CacheRevalidateRequest {
    project: String,
}

async fn cache_revalidate(
    State(state): State<Arc<AppState>>,
    body: Result<Json<CacheRevalidateRequest>, JsonRejection>,
) -> Response {
    let payload = match parse_json(body) {
        Ok(payload) => payload,
        Err(response) => return response,
    };
    if let Err(response) = project_config(&state, &payload.project) {
        return response;
    }
    (
        StatusCode::NOT_IMPLEMENTED,
        Json(serde_json::json!({"error": "cache revalidation is not supported"})),
    )
        .into_response()
}

async fn get_project_deployments(
    State(state): State<Arc<AppState>>,
    Path(project): Path<String>,
) -> Response {
    if let Err(response) = project_config(&state, &project) {
        return response;
    }
    let p = project.clone();
    match tokio::task::spawn_blocking(move || state.deployments.read(&p)).await {
        Ok(Ok(snapshot)) => Json(serde_json::json!({
            "project": project, "total": snapshot.history.len(),
            "active_deploy_id": snapshot.active, "deployments": snapshot.history
        }))
        .into_response(),
        _ => (
            StatusCode::INTERNAL_SERVER_ERROR,
            "deployment history unavailable",
        )
            .into_response(),
    }
}

async fn healthz() -> impl IntoResponse {
    Json(serde_json::json!({"status": "ok"}))
}

async fn metrics(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let body = format!(
        "# TYPE mobilecloud_requests_total counter\nmobilecloud_requests_total {}\n\
         # TYPE mobilecloud_builds_total counter\nmobilecloud_builds_total {}\n\
         # TYPE mobilecloud_agent_builds_total counter\nmobilecloud_agent_builds_total {}\n",
        state.requests_total.load(Ordering::Relaxed),
        state.builds_total.load(Ordering::Relaxed),
        state.agent_builds_total.load(Ordering::Relaxed),
    );
    ([(header::CONTENT_TYPE, "text/plain; version=0.0.4")], body)
}

async fn build_logs_sse(
    State(state): State<Arc<AppState>>,
    Path(project): Path<String>,
) -> Response {
    if let Err(response) = project_config(&state, &project) {
        return response;
    }
    let stream = tokio_stream::wrappers::BroadcastStream::new(state.logs[&project].subscribe())
        .map(|item| {
            Ok::<_, std::convert::Infallible>(match item {
                Ok(line) => Event::default().data(line),
                Err(_) => Event::default().data("[Logs] Some lines were dropped"),
            })
        });
    Sse::new(stream)
        .keep_alive(KeepAlive::default())
        .into_response()
}

fn operator_router(state: Arc<AppState>) -> Router {
    let protected = Router::new()
        .route("/api/v1/deploy/agent", post(agent_deploy))
        .route("/api/v1/deploy/rollback", post(rollback_deployment))
        .route("/api/v1/cache/revalidate", post(cache_revalidate))
        .route("/api/v1/deployments/:project", get(get_project_deployments))
        .route("/metrics", get(metrics))
        .route("/logs/:project", get(build_logs_sse))
        .route_layer(middleware::from_fn_with_state(state.clone(), operator_auth));
    Router::new()
        .merge(protected)
        .route(
            "/webhook/github",
            post(github_webhook).layer(DefaultBodyLimit::max(256 * 1024)),
        )
        .route("/healthz", get(healthz))
        .merge(terminal_gateway::ws_router())
        .layer(DefaultBodyLimit::max(16 * 1024))
        .with_state(state)
}

fn deployment_router(state: Arc<AppState>) -> Router {
    Router::new().fallback(proxy_handler).with_state(state)
}

fn loopback_bind(name: &str, default: &str) -> anyhow::Result<SocketAddr> {
    let bind: SocketAddr = std::env::var(name)
        .unwrap_or_else(|_| default.into())
        .parse()
        .map_err(|_| anyhow::anyhow!("{name} must be a numeric loopback socket address"))?;
    anyhow::ensure!(bind.ip().is_loopback(), "{name} must bind to loopback");
    Ok(bind)
}

fn main() -> anyhow::Result<()> {
    // SAFETY: these libgit2 process-wide limits are set at entry, before any
    // worker threads or concurrent libgit2 operations exist.
    unsafe {
        git2::opts::set_server_connect_timeout_in_milliseconds(10_000)?;
        git2::opts::set_server_timeout_in_milliseconds(30_000)?;
    }
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?
        .block_on(run())
}

async fn run() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();
    let home = std::env::var("MOBILECLOUD_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("/var/mobilecloud"));
    let projects = match std::env::var("MOBILECLOUD_PREVIEW_PROJECTS") {
        Ok(raw) => serde_json::from_str(&raw)
            .map_err(|_| anyhow::anyhow!("invalid MOBILECLOUD_PREVIEW_PROJECTS JSON"))?,
        Err(std::env::VarError::NotPresent) => HashMap::new(),
        Err(_) => anyhow::bail!("invalid MOBILECLOUD_PREVIEW_PROJECTS encoding"),
    };
    let mut state = AppState::new(home, projects)?;
    state.trusted_preview = env_flag("MOBILECLOUD_TRUSTED_LOCAL_PREVIEW");
    state.operator_token = credential("MOBILECLOUD_OPERATOR_TOKEN");
    state.webhook_secret = credential("MOBILECLOUD_WEBHOOK_SECRET");
    let terminal_token = credential("MOBILECLOUD_TERMINAL_TOKEN");
    let dashboard_token = credential("MOBILECLOUD_BUILDER_TOKEN");
    let secrets = [
        &state.operator_token,
        &state.webhook_secret,
        &terminal_token,
        &dashboard_token,
    ];
    for (index, secret) in secrets.iter().enumerate() {
        anyhow::ensure!(
            secret.is_empty() || !secrets[..index].contains(secret),
            "engine credentials must be distinct"
        );
    }
    if env_flag("MOBILECLOUD_ENABLE_LOCAL_TERMINAL") {
        state.terminal_token = terminal_token;
    }
    if state.preview_enabled() {
        warn!("trusted local preview enabled: builds run as the engine user, with no sandbox or tenant isolation");
    }
    let state = Arc::new(state);
    let control =
        tokio::net::TcpListener::bind(loopback_bind("MOBILECLOUD_BIND", "127.0.0.1:3000")?).await?;
    let deploy =
        tokio::net::TcpListener::bind(loopback_bind("MOBILECLOUD_DEPLOY_BIND", "127.0.0.1:3001")?)
            .await?;
    info!(operator = %control.local_addr()?, deployments = %deploy.local_addr()?, "engine listening on loopback");
    if env_flag("MOBILECLOUD_ENABLE_LOCAL_SSH") {
        terminal_gateway::start_ssh_server(state.clone()).await;
    }
    let (shutdown, _) = tokio::sync::watch::channel(false);
    let mut control_shutdown = shutdown.subscribe();
    let mut deploy_shutdown = shutdown.subscribe();
    tokio::spawn(async move {
        shutdown_signal().await;
        let _ = shutdown.send(true);
    });
    tokio::try_join!(
        axum::serve(control, operator_router(state.clone())).with_graceful_shutdown(async move {
            let _ = control_shutdown.changed().await;
        }),
        axum::serve(deploy, deployment_router(state)).with_graceful_shutdown(async move {
            let _ = deploy_shutdown.changed().await;
        }),
    )?;
    Ok(())
}

fn deployment_path(path: &str) -> bool {
    // Normalize separators and percent escapes for this deny check only. The
    // deployment router never merges or forwards to the operator router.
    let mut decoded = Vec::with_capacity(path.len());
    let mut bytes = path.as_bytes().iter().copied();
    while let Some(byte) = bytes.next() {
        let byte = if byte == b'%' {
            let (Some(a), Some(b)) = (bytes.next(), bytes.next()) else {
                return false;
            };
            let Ok([byte]) = <[u8; 1]>::try_from(hex::decode([a, b]).unwrap_or_default()) else {
                return false;
            };
            byte
        } else {
            byte
        };
        if byte.is_ascii_control() || byte == b'%' {
            return false;
        }
        decoded.push(byte.to_ascii_lowercase());
    }
    let mut parts = decoded
        .split(|b| *b == b'/' || *b == b'\\')
        .filter(|part| !part.is_empty());
    if !decoded.starts_with(b"/") || parts.clone().any(|p| p == b"." || p == b"..") {
        return false;
    }
    match parts.next() {
        Some(b"api") => parts.next() != Some(b"v1"),
        Some(b"webhook" | b"terminal" | b"logs" | b"healthz" | b"metrics") => false,
        _ => true,
    }
}

async fn proxy_handler(State(state): State<Arc<AppState>>, request: Request) -> Response {
    if !deployment_path(request.uri().path()) {
        return StatusCode::NOT_FOUND.into_response();
    }
    state.requests_total.fetch_add(1, Ordering::Relaxed);
    let host = request
        .headers()
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<Authority>().ok());
    let Some((project, _)) = host.as_ref().and_then(|host| {
        state.projects.iter().find(|(_, p)| {
            p.host
                .as_deref()
                .is_some_and(|configured| configured.eq_ignore_ascii_case(host.host()))
        })
    }) else {
        return (StatusCode::NOT_FOUND, "unknown deployment host").into_response();
    };
    let Ok(permit) = state.deployment_slots.clone().try_acquire_owned() else {
        return (StatusCode::SERVICE_UNAVAILABLE, "deployment listener busy").into_response();
    };
    match proxy::router::route_request(&state, project, request, permit).await {
        Ok(response) => response,
        Err(proxy::router::RouterError::NoDeployment) => {
            (StatusCode::SERVICE_UNAVAILABLE, "no live deployment").into_response()
        }
        Err(e) => {
            error!(%project, error = %e, "deployment routing failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "deployment routing failed",
            )
                .into_response()
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
            Ok(mut signal) => {
                signal.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! { _ = ctrl_c => {}, _ = terminate => {} }
    info!("shutdown signal received; draining connections");
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    const AGENT_PATH: &str = "/api/v1/deploy/agent";
    const AGENT_BODY: &str =
        r#"{"project":"demo","clone_url":"https://github.com/example/demo.git"}"#;
    const AUTH: &str = "Authorization: Bearer operator-test\r\n";

    fn test_state(dir: &std::path::Path) -> AppState {
        let mut state = AppState::new(
            dir.to_owned(),
            HashMap::from([(
                "demo".into(),
                PreviewProject {
                    repository: "example/demo".into(),
                    branch: "main".into(),
                    host: Some("demo.example.test".into()),
                },
            )]),
        )
        .unwrap();
        state.operator_token = b"operator-test".to_vec();
        state.webhook_secret = b"webhook-test".to_vec();
        state
    }

    async fn request(
        router: Router,
        method: &str,
        path: &str,
        extra_headers: &str,
        body: &str,
    ) -> (u16, String) {
        request_host(
            router,
            method,
            path,
            "demo.example.test",
            extra_headers,
            body,
        )
        .await
    }

    async fn request_host(
        router: Router,
        method: &str,
        path: &str,
        host: &str,
        extra_headers: &str,
        body: &str,
    ) -> (u16, String) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        let mut socket = tokio::net::TcpStream::connect(addr).await.unwrap();
        let raw = format!("{method} {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\n{extra_headers}\r\n{body}", body.len());
        socket.write_all(raw.as_bytes()).await.unwrap();
        let mut response = Vec::new();
        tokio::time::timeout(
            std::time::Duration::from_secs(5),
            socket.read_to_end(&mut response),
        )
        .await
        .unwrap()
        .unwrap();
        server.abort();
        let response = String::from_utf8(response).unwrap();
        (
            response.split_whitespace().nth(1).unwrap().parse().unwrap(),
            response,
        )
    }

    #[tokio::test]
    async fn private_operator_routes_authenticate_before_reading_payload() {
        let dir = tempfile::tempdir().unwrap();
        let state = Arc::new(test_state(dir.path()));
        let router = operator_router(state);
        for (method, path) in [
            ("POST", AGENT_PATH),
            ("POST", "/api/v1/deploy/rollback"),
            ("POST", "/api/v1/cache/revalidate"),
            ("GET", "/logs/demo"),
            ("GET", "/api/v1/deployments/demo"),
            ("GET", "/metrics"),
        ] {
            let (status, _) = request(router.clone(), method, path, "", "").await;
            assert_eq!(status, 401, "{method} {path}");
        }
        assert_eq!(
            request(
                router.clone(),
                "GET",
                "/api/v1/deployments/demo",
                "Authorization: Bearer webhook-test\r\n",
                ""
            )
            .await
            .0,
            401
        );
        assert_eq!(
            request(
                router.clone(),
                "GET",
                "/api/v1/deployments/demo",
                &format!("{AUTH}Origin: https://example.test\r\n"),
                ""
            )
            .await
            .0,
            401
        );
        let (status, response) =
            request(router.clone(), "GET", "/api/v1/deployments/demo", AUTH, "").await;
        assert_eq!(status, 200);
        assert!(response.contains("cache-control: no-store"));
        assert_eq!(
            request(
                router.clone(),
                "GET",
                "/api/v1/deployments/unknown",
                AUTH,
                ""
            )
            .await
            .0,
            404
        );
        assert_eq!(
            request(
                router.clone(),
                "POST",
                "/api/v1/deploy/rollback",
                AUTH,
                r#"{"project":"demo","deploy_id":"invalid"}"#
            )
            .await
            .0,
            400
        );
        assert_eq!(
            request(
                router,
                "POST",
                "/api/v1/cache/revalidate",
                AUTH,
                r#"{"project":"demo","tag":"test"}"#
            )
            .await
            .0,
            501
        );
    }

    #[tokio::test]
    async fn builds_require_opt_in_and_match_the_local_allowlist() {
        let dir = tempfile::tempdir().unwrap();
        let mut state = test_state(dir.path());
        let after = "0123456789abcdef0123456789abcdef01234567";
        let push = format!(
            r#"{{"repository":{{"full_name":"example/demo"}},"ref":"refs/heads/main","after":"{after}"}}"#
        );
        let mut mac = HmacSha256::new_from_slice(&state.webhook_secret).unwrap();
        mac.update(push.as_bytes());
        let signed = format!(
            "X-GitHub-Event: push\r\nX-Hub-Signature-256: sha256={}\r\n",
            hex::encode(mac.finalize().into_bytes())
        );
        let router = operator_router(Arc::new(test_state(dir.path())));
        assert_eq!(
            request(router.clone(), "POST", AGENT_PATH, AUTH, AGENT_BODY)
                .await
                .0,
            503
        );
        assert_eq!(
            request(router, "POST", "/webhook/github", &signed, &push)
                .await
                .0,
            503
        );

        state.trusted_preview = true;
        // Prove valid requests reach the queue boundary without doing a network fetch.
        let _permit = state.build_slot.clone().try_acquire_owned().unwrap();
        let router = operator_router(Arc::new(state));
        assert_eq!(
            request(router.clone(), "POST", AGENT_PATH, AUTH, AGENT_BODY)
                .await
                .0,
            429
        );
        assert_eq!(
            request(router.clone(), "POST", "/webhook/github", &signed, &push)
                .await
                .0,
            429
        );
        assert_eq!(
            request(router.clone(), "POST", "/webhook/github", "", &push)
                .await
                .0,
            401
        );
        let (status, response) = request(
            router,
            "POST",
            AGENT_PATH,
            AUTH,
            &AGENT_BODY.replace("example/demo", "example/other"),
        )
        .await;
        assert_eq!(status, 403);
        assert!(!response.contains("example/other"));
    }

    #[tokio::test]
    async fn deployment_listener_serves_only_static_routes_on_configured_hosts() {
        let dir = tempfile::tempdir().unwrap();
        let state = Arc::new(test_state(dir.path()));
        let checkout = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(checkout.path().join("dist/api")).unwrap();
        std::fs::write(checkout.path().join("dist/api/example.txt"), "public asset").unwrap();
        atomic_promoter::promote(
            &state.deployments,
            DeployRecord {
                project: "demo".into(),
                deploy_id: String::new(),
                commit: "commit".into(),
                branch: "main".into(),
                framework: "static".into(),
                built_at: 1,
                ttfb_hint_ms: None,
                trigger_source: None,
            },
            &checkout,
            "dist",
        )
        .unwrap();
        let router = deployment_router(state.clone());
        for path in [
            "/logs/demo",
            "/terminal/ws",
            "/webhook/github",
            "/healthz",
            "/metrics",
            "/api/v1/deployments/demo",
        ] {
            assert_eq!(
                request(router.clone(), "GET", path, AUTH, "").await.0,
                404,
                "{path}"
            );
        }
        assert_eq!(
            request_host(
                router.clone(),
                "GET",
                "/api/example.txt",
                "unconfigured.example.test",
                "",
                ""
            )
            .await
            .0,
            404
        );
        let (status, response) = request(router, "GET", "/api/example.txt", "", "").await;
        assert_eq!(status, 200);
        assert!(response.ends_with("public asset"));
        assert_eq!(
            request(operator_router(state), "GET", "/api/example.txt", "", "")
                .await
                .0,
            404
        );
    }

    #[test]
    fn identifiers_and_reserved_segments_are_canonical() {
        assert!(builder::valid_project("operator-demo1"));
        assert!(!builder::valid_project("demo/app"));
        assert!(!builder::valid_project("COM1"));
        assert!(!builder::valid_project("com1"));
        assert!(builder::valid_deploy_id("dpl_0123456789abcdef01234567"));
        assert!(!builder::valid_deploy_id("dpl_012345"));
        assert!(!deployment_path("/api/v1"));
        assert!(!deployment_path("/logs/%64emo"));
        assert!(!deployment_path("/healthz/"));
        assert!(deployment_path("/api/demo"));
        assert!(deployment_path("/docs/healthz"));
    }
}
