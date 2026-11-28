//! The management REST API — the drop-in replacement for Cloudflare's
//! `/zones/{zone}/dns_records` surface.
//!
//! Design rules:
//!
//! * The wire shape mirrors what the old Cloudflare script posted (`name`,
//!   `type`, `value`, `ttl`, `proxied`) so tooling only changes its base URL.
//! * A name may be given relative (`"auth"`) or fully qualified
//!   (`"auth.furlpay.com"`); both collapse to the same stored record.
//! * `proxied: true` is preserved: the resolver, not the API, decides which
//!   edge PoP address answers.
//! * When `MC_DNS_API_TOKEN` is set, every route except `/health` and
//!   `/metrics` requires `Authorization: Bearer <token>`.

use std::sync::Arc;

use axum::body::Body;
use axum::extract::{Path, Request, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::geo::GeoRouter;
use crate::metrics::Metrics;
use crate::record::{Record, RecordError, RecordType};
use crate::store::{DnsStore, StoreError, Zone};
use crate::wire;

/// Shared handler state. Generic over the store so a replicated SQL store can
/// be dropped in without touching a handler.
pub struct AppState<S: DnsStore + 'static> {
    pub store: Arc<S>,
    pub geo: Arc<GeoRouter>,
    pub metrics: Arc<Metrics>,
    pub api_token: Option<String>,
}

/// Build the management router. `health` and `metrics` stay open for probes;
/// everything else is behind the bearer token when one is configured.
pub fn router<S: DnsStore + 'static>(state: Arc<AppState<S>>) -> Router {
    let protected = Router::new()
        .route("/api/v1/dns/zones", get(list_zones::<S>).post(create_zone::<S>))
        .route("/api/v1/dns/zones/:zone", get(get_zone::<S>).delete(delete_zone::<S>))
        .route("/api/v1/dns/zones/:zone/records", get(list_records::<S>).post(create_record::<S>))
        .route(
            "/api/v1/dns/zones/:zone/records/:id",
            get(get_record::<S>).put(update_record::<S>).delete(delete_record::<S>),
        );

    let protected = match state.api_token.clone() {
        Some(token) => protected.route_layer(middleware::from_fn(
            move |request: Request<Body>, next: Next| {
                let token = token.clone();
                async move {
                    if !bearer_matches(request.headers(), &token) {
                        return ApiError::unauthorized().into_response();
                    }
                    next.run(request).await
                }
            },
        )),
        None => protected,
    };

    Router::new()
        .route("/api/v1/dns/health", get(health::<S>))
        .route("/metrics", get(render_metrics::<S>))
        .merge(protected)
        .with_state(state)
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[derive(Debug)]
pub struct ApiError {
    status: StatusCode,
    message: String,
}

impl ApiError {
    pub fn new(status: StatusCode, message: impl Into<String>) -> Self {
        Self { status, message: message.into() }
    }
    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, message)
    }
    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(StatusCode::NOT_FOUND, message)
    }
    pub fn conflict(message: impl Into<String>) -> Self {
        Self::new(StatusCode::CONFLICT, message)
    }
    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, message)
    }
    pub fn unauthorized() -> Self {
        Self::new(StatusCode::UNAUTHORIZED, "missing or invalid API token")
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.status, Json(json!({ "error": self.message }))).into_response()
    }
}

impl From<StoreError> for ApiError {
    fn from(error: StoreError) -> Self {
        match error {
            StoreError::ZoneExists(zone) => Self::conflict(format!("zone '{zone}' already exists")),
            StoreError::ZoneNotFound(zone) => Self::not_found(format!("zone '{zone}' not found")),
            StoreError::RecordNotFound { zone, id } => {
                Self::not_found(format!("record {id} not found in zone '{zone}'"))
            }
            StoreError::Io(message) => Self::internal(message),
        }
    }
}

impl From<RecordError> for ApiError {
    fn from(error: RecordError) -> Self {
        Self::bad_request(error.to_string())
    }
}

impl From<wire::WireError> for ApiError {
    fn from(error: wire::WireError) -> Self {
        Self::bad_request(error.to_string())
    }
}

// ---------------------------------------------------------------------------
// Request / response shapes
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct CreateZoneRequest {
    domain: String,
    #[serde(default = "default_owner")]
    owner_id: String,
    #[serde(default)]
    dnssec_enabled: bool,
    #[serde(default)]
    geo_routing_enabled: bool,
}

fn default_owner() -> String {
    "unassigned".to_string()
}

const fn default_ttl() -> u32 {
    crate::record::DEFAULT_TTL
}

#[derive(Debug, Deserialize)]
struct RecordRequest {
    name: String,
    #[serde(rename = "type")]
    record_type: String,
    value: String,
    #[serde(default = "default_ttl")]
    ttl: u32,
    #[serde(default)]
    priority: Option<u16>,
    #[serde(default)]
    proxied: bool,
}

#[derive(Debug, Serialize)]
struct RecordDto {
    id: u64,
    zone: String,
    name: String,
    #[serde(rename = "type")]
    record_type: String,
    value: String,
    ttl: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    priority: Option<u16>,
    proxied: bool,
}

impl From<&Record> for RecordDto {
    fn from(record: &Record) -> Self {
        Self {
            id: record.id,
            zone: record.zone.clone(),
            name: record.name.clone(),
            record_type: record.record_type.as_str().to_string(),
            value: record.value.clone(),
            ttl: record.ttl,
            priority: record.priority,
            proxied: record.proxied,
        }
    }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async fn health<S: DnsStore + 'static>(State(state): State<Arc<AppState<S>>>) -> Json<Value> {
    let zones = state.store.list_zones().await;
    let mut records = 0usize;
    for zone in &zones {
        records += state.store.list_records(&zone.domain).await.len();
    }
    Json(json!({
        "status": "ok",
        "zones": zones.len(),
        "records": records,
        "queries_total": state.metrics.query_count(),
        "refused_total": state.metrics.refused_count(),
        "geo_regions": state.geo.regions().iter().map(|region| region.name.clone()).collect::<Vec<_>>(),
    }))
}

async fn render_metrics<S: DnsStore + 'static>(
    State(state): State<Arc<AppState<S>>>,
) -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "text/plain; version=0.0.4")],
        state.metrics.render(),
    )
}

async fn list_zones<S: DnsStore + 'static>(
    State(state): State<Arc<AppState<S>>>,
) -> Json<Vec<Zone>> {
    Json(state.store.list_zones().await)
}

async fn create_zone<S: DnsStore + 'static>(
    State(state): State<Arc<AppState<S>>>,
    Json(body): Json<CreateZoneRequest>,
) -> Result<(StatusCode, Json<Zone>), ApiError> {
    let domain = validate_zone(&body.domain)?;
    let mut zone = Zone::new(&domain, &body.owner_id);
    zone.dnssec_enabled = body.dnssec_enabled;
    zone.geo_routing_enabled = body.geo_routing_enabled;
    let created = state.store.create_zone(zone).await?;
    Ok((StatusCode::CREATED, Json(created)))
}

async fn get_zone<S: DnsStore + 'static>(
    State(state): State<Arc<AppState<S>>>,
    Path(zone): Path<String>,
) -> Result<Json<Zone>, ApiError> {
    let zone = wire::canonical_name(&zone);
    state
        .store
        .get_zone(&zone)
        .await
        .map(Json)
        .ok_or_else(|| ApiError::not_found(format!("zone '{zone}' not found")))
}

async fn delete_zone<S: DnsStore + 'static>(
    State(state): State<Arc<AppState<S>>>,
    Path(zone): Path<String>,
) -> Result<Json<Zone>, ApiError> {
    let removed = state.store.delete_zone(&zone).await?;
    Ok(Json(removed))
}

async fn list_records<S: DnsStore + 'static>(
    State(state): State<Arc<AppState<S>>>,
    Path(zone): Path<String>,
) -> Result<Json<Vec<RecordDto>>, ApiError> {
    let zone = require_zone(&state, &zone).await?;
    let records = state.store.list_records(&zone).await;
    Ok(Json(records.iter().map(RecordDto::from).collect()))
}

async fn create_record<S: DnsStore + 'static>(
    State(state): State<Arc<AppState<S>>>,
    Path(zone): Path<String>,
    Json(body): Json<RecordRequest>,
) -> Result<(StatusCode, Json<RecordDto>), ApiError> {
    let zone = require_zone(&state, &zone).await?;
    let record = build_record(&zone, None, &body)?;
    let stored = state.store.put_record(record).await?;
    Ok((StatusCode::CREATED, Json(RecordDto::from(&stored))))
}

async fn get_record<S: DnsStore + 'static>(
    State(state): State<Arc<AppState<S>>>,
    Path((zone, id)): Path<(String, u64)>,
) -> Result<Json<RecordDto>, ApiError> {
    let zone = require_zone(&state, &zone).await?;
    state
        .store
        .get_record(&zone, id)
        .await
        .map(|record| Json(RecordDto::from(&record)))
        .ok_or_else(|| ApiError::not_found(format!("record {id} not found in zone '{zone}'")))
}

async fn update_record<S: DnsStore + 'static>(
    State(state): State<Arc<AppState<S>>>,
    Path((zone, id)): Path<(String, u64)>,
    Json(body): Json<RecordRequest>,
) -> Result<Json<RecordDto>, ApiError> {
    let zone = require_zone(&state, &zone).await?;
    if state.store.get_record(&zone, id).await.is_none() {
        return Err(ApiError::not_found(format!("record {id} not found in zone '{zone}'")));
    }
    let record = build_record(&zone, Some(id), &body)?;
    let stored = state.store.put_record(record).await?;
    Ok(Json(RecordDto::from(&stored)))
}

async fn delete_record<S: DnsStore + 'static>(
    State(state): State<Arc<AppState<S>>>,
    Path((zone, id)): Path<(String, u64)>,
) -> Result<Json<RecordDto>, ApiError> {
    let zone = require_zone(&state, &zone).await?;
    let removed = state.store.delete_record(&zone, id).await?;
    Ok(Json(RecordDto::from(&removed)))
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Confirm the zone exists and return it in canonical form.
async fn require_zone<S: DnsStore + 'static>(
    state: &AppState<S>,
    zone: &str,
) -> Result<String, ApiError> {
    let zone = wire::canonical_name(zone);
    if state.store.get_zone(&zone).await.is_none() {
        return Err(ApiError::not_found(format!("zone '{zone}' not found")));
    }
    Ok(zone)
}

/// Build a record from an API body, normalising an absolute `name` down to the
/// zone-relative label the store keys on.
fn build_record(zone: &str, id: Option<u64>, body: &RecordRequest) -> Result<Record, ApiError> {
    let record_type = RecordType::parse(&body.record_type)?;
    let name = relative_name(zone, &body.name);
    let mut record = Record::new(
        zone,
        &name,
        record_type,
        &body.value,
        body.ttl,
        body.priority,
        body.proxied,
    )?;
    if let Some(id) = id {
        record.id = id;
    }
    Ok(record)
}

/// Accept both `"auth"` and `"auth.furlpay.com"` for a record in `furlpay.com`.
fn relative_name(zone: &str, raw: &str) -> String {
    let canonical = wire::canonical_name(raw);
    if canonical.is_empty() || canonical == "@" || canonical == zone {
        return String::new();
    }
    match canonical.strip_suffix(&format!(".{zone}")) {
        Some(prefix) if !prefix.is_empty() => prefix.to_string(),
        _ => canonical,
    }
}

fn validate_zone(raw: &str) -> Result<String, ApiError> {
    let canonical = wire::canonical_name(raw);
    if canonical.is_empty() || !canonical.contains('.') {
        return Err(ApiError::bad_request(
            "zone domain must be a registrable domain such as 'furlpay.com'",
        ));
    }
    crate::record::validate_hostname(&canonical).map_err(|error| ApiError::bad_request(error.to_string()))?;
    Ok(canonical)
}

fn bearer_matches(headers: &HeaderMap, expected: &str) -> bool {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(|token| constant_time_eq(token.trim().as_bytes(), expected.as_bytes()))
        .unwrap_or(false)
}

/// Compare two byte strings without an early return on the first mismatch.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::MemoryStore;
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    fn test_app() -> (Router, Arc<AppState<MemoryStore>>) {
        test_app_with_token(None)
    }

    fn test_app_with_token(api_token: Option<&str>) -> (Router, Arc<AppState<MemoryStore>>) {
        let state = Arc::new(AppState {
            store: Arc::new(MemoryStore::new()),
            geo: Arc::new(GeoRouter::default()),
            metrics: Arc::new(Metrics::new()),
            api_token: api_token.map(str::to_string),
        });
        (router(state.clone()), state)
    }

    async fn send(app: Router, request: Request<Body>) -> (StatusCode, Value) {
        let response = app.oneshot(request).await.expect("router is infallible");
        let status = response.status();
        let bytes = response.into_body().collect().await.expect("body").to_bytes();
        let value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        (status, value)
    }

    fn json_request(method: &str, uri: &str, body: Value) -> Request<Body> {
        Request::builder()
            .method(method)
            .uri(uri)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_string()))
            .expect("request builds")
    }

    async fn seed_zone(app: Router) -> Router {
        let (status, _) = send(
            app.clone(),
            json_request("POST", "/api/v1/dns/zones", json!({ "domain": "furlpay.com", "owner_id": "ashutosh0x" })),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
        app
    }

    #[tokio::test]
    async fn zone_lifecycle_over_http() {
        let (app, _state) = test_app();
        let app = seed_zone(app).await;

        let (status, body) = send(app.clone(), json_request("GET", "/api/v1/dns/zones", json!(null))).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body.as_array().map(Vec::len), Some(1));

        // A duplicate zone is a conflict, not a silent overwrite.
        let (status, _) = send(
            app.clone(),
            json_request("POST", "/api/v1/dns/zones", json!({ "domain": "furlpay.com" })),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);
    }

    #[tokio::test]
    async fn records_accept_absolute_and_relative_names() {
        let (app, _state) = test_app();
        let app = seed_zone(app).await;

        let (status, created) = send(
            app.clone(),
            json_request(
                "POST",
                "/api/v1/dns/zones/furlpay.com/records",
                json!({ "name": "auth.furlpay.com", "type": "cname", "value": "edge.furlpay.com", "proxied": true }),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
        assert_eq!(created["name"], "auth", "an absolute name collapses to its label");
        assert_eq!(created["type"], "CNAME", "types are normalised to upper case");
        assert_eq!(created["ttl"], crate::record::DEFAULT_TTL);

        let (status, listed) = send(
            app.clone(),
            json_request("GET", "/api/v1/dns/zones/furlpay.com/records", json!(null)),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(listed.as_array().map(Vec::len), Some(1));

        // Apex form.
        let (status, apex) = send(
            app,
            json_request(
                "POST",
                "/api/v1/dns/zones/furlpay.com/records",
                json!({ "name": "@", "type": "A", "value": "203.0.113.10" }),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
        assert_eq!(apex["name"], "");
    }

    #[tokio::test]
    async fn update_and_delete_a_record() {
        let (app, _state) = test_app();
        let app = seed_zone(app).await;

        let (_, created) = send(
            app.clone(),
            json_request(
                "POST",
                "/api/v1/dns/zones/furlpay.com/records",
                json!({ "name": "www", "type": "A", "value": "203.0.113.10" }),
            ),
        )
        .await;
        let id = created["id"].as_u64().expect("id");

        let (status, updated) = send(
            app.clone(),
            json_request(
                "PUT",
                &format!("/api/v1/dns/zones/furlpay.com/records/{id}"),
                json!({ "name": "www", "type": "A", "value": "203.0.113.99", "ttl": 60 }),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(updated["value"], "203.0.113.99");
        assert_eq!(updated["ttl"], 60);
        assert_eq!(updated["id"], id, "PUT keeps the record identity");

        let (status, _) = send(
            app.clone(),
            json_request("DELETE", &format!("/api/v1/dns/zones/furlpay.com/records/{id}"), json!(null)),
        )
        .await;
        assert_eq!(status, StatusCode::OK);

        let (status, _) = send(
            app,
            json_request("GET", &format!("/api/v1/dns/zones/furlpay.com/records/{id}"), json!(null)),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn rejects_a_bad_value_and_an_unknown_zone() {
        let (app, _state) = test_app();
        let app = seed_zone(app).await;

        let (status, body) = send(
            app.clone(),
            json_request(
                "POST",
                "/api/v1/dns/zones/furlpay.com/records",
                json!({ "name": "www", "type": "A", "value": "not-an-ip" }),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(body["error"].as_str().unwrap().contains("A"));

        let (status, _) = send(
            app,
            json_request("GET", "/api/v1/dns/zones/other.example/records", json!(null)),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn a_configured_token_gates_the_zone_api() {
        let (app, _state) = test_app_with_token(Some("s3cret"));

        let (status, _) = send(
            app.clone(),
            json_request("GET", "/api/v1/dns/zones", json!(null)),
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);

        let authorized = Request::builder()
            .method("GET")
            .uri("/api/v1/dns/zones")
            .header(header::AUTHORIZATION, "Bearer s3cret")
            .body(Body::empty())
            .unwrap();
        let (status, _) = send(app.clone(), authorized).await;
        assert_eq!(status, StatusCode::OK);

        // Health stays open so a load balancer can probe it.
        let (status, _) = send(app, json_request("GET", "/api/v1/dns/health", json!(null))).await;
        assert_eq!(status, StatusCode::OK);
    }

    #[tokio::test]
    async fn health_reports_counts() {
        let (app, _state) = test_app();
        let app = seed_zone(app).await;
        let (status, body) = send(app, json_request("GET", "/api/v1/dns/health", json!(null))).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["status"], "ok");
        assert_eq!(body["zones"], 1);
        assert!(body["geo_regions"].as_array().map(Vec::len).unwrap_or(0) >= 1);
    }

    #[test]
    fn constant_time_comparison_behaves_like_equality() {
        assert!(constant_time_eq(b"token", b"token"));
        assert!(!constant_time_eq(b"token", b"tokeN"));
        assert!(!constant_time_eq(b"token", b"token "));
    }

    #[test]
    fn relative_names_normalise_both_forms() {
        assert_eq!(relative_name("furlpay.com", "@"), "");
        assert_eq!(relative_name("furlpay.com", "furlpay.com"), "");
        assert_eq!(relative_name("furlpay.com", "auth"), "auth");
        assert_eq!(relative_name("furlpay.com", "auth.furlpay.com"), "auth");
        assert_eq!(relative_name("furlpay.com", "_acme-challenge.furlpay.com"), "_acme-challenge");
    }
}
