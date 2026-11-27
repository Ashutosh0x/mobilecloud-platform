//! Authenticated, fail-closed HTTP API for fleet operations.
//!
//! Two independent secrets gate the API:
//!
//! * `x-enrollment-token` — a shared [`EnrollmentToken`] required to enroll a
//!   new device.
//! * `Authorization: Bearer <operator_token>` — required for all operator
//!   endpoints (list, summary, heartbeat, revoke).
//!
//! All token comparisons are constant-time and every failure returns `401`
//! rather than panicking, even when headers are missing or malformed.

use std::net::IpAddr;
use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::{header, HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use dashmap::DashMap;
use serde::{Deserialize, Serialize};

use crate::identity::{verify_signature, EnrollmentToken};
use crate::node::{
    FleetRegistry, HeartbeatOutcome, NodeCapabilities, NodeId, NodeInfo, NodeRole,
};

/// Shared state for the fleet API.
pub struct FleetApiState {
    /// The fleet registry.
    pub registry: Arc<FleetRegistry>,
    /// Bearer token required for operator endpoints.
    pub operator_token: String,
    /// Shared secret required for device enrollment.
    pub enrollment_token: EnrollmentToken,
    /// Device public key (lowercase hex) bound to each enrolled node.
    pub device_keys: Arc<DashMap<NodeId, String>>,
}

/// Constant-time string equality used for all secret comparisons.
pub fn constant_time_eq(a: &str, b: &str) -> bool {
    crate::identity::ct_eq(a, b)
}

fn bearer_ok(headers: &HeaderMap, expected: &str) -> bool {
    let Some(value) = headers.get(header::AUTHORIZATION) else {
        return false;
    };
    let Ok(value) = value.to_str() else {
        return false;
    };
    let Some(token) = value.strip_prefix("Bearer ") else {
        return false;
    };
    constant_time_eq(token.trim(), expected)
}

fn device_id_for(state: &FleetApiState, key_hex: &str) -> Option<NodeId> {
    state
        .device_keys
        .iter()
        .find(|entry| entry.value() == key_hex)
        .map(|entry| entry.key().clone())
}

/// Enrollment request payload.
#[derive(Debug, Deserialize)]
pub struct EnrollRequest {
    pub device_public_key_hex: String,
    pub hostname: String,
    pub ip: String,
    pub port: u16,
    pub role: NodeRole,
    pub capabilities: NodeCapabilities,
}

/// Enrollment response payload.
#[derive(Debug, Serialize)]
pub struct EnrollResponse {
    pub node_id: String,
}

/// Sequenced, signed heartbeat payload.
#[derive(Debug, Deserialize)]
pub struct HeartbeatRequest {
    pub seq: u64,
    pub signature_hex: String,
}

async fn enroll(
    State(state): State<Arc<FleetApiState>>,
    headers: HeaderMap,
    Json(req): Json<EnrollRequest>,
) -> impl IntoResponse {
    let presented = headers
        .get("x-enrollment-token")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    if !state.enrollment_token.matches(presented) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "invalid enrollment token" })),
        );
    }

    // Idempotent per device public key: the same device always receives the
    // same stable NodeId.
    if let Some(existing) = device_id_for(&state, &req.device_public_key_hex) {
        return (
            StatusCode::OK,
            Json(serde_json::json!({ "node_id": existing.as_str() })),
        );
    }

    let Ok(ip) = req.ip.parse::<IpAddr>() else {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "invalid ip address" })),
        );
    };

    let node = NodeInfo::new(req.hostname, ip, req.port, req.role, req.capabilities);
    let id = state.registry.join(node);
    state
        .device_keys
        .insert(id.clone(), req.device_public_key_hex);

    (
        StatusCode::CREATED,
        Json(serde_json::json!({ "node_id": id.as_str() })),
    )
}

async fn heartbeat(
    State(state): State<Arc<FleetApiState>>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(req): Json<HeartbeatRequest>,
) -> impl IntoResponse {
    if !bearer_ok(&headers, &state.operator_token) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "unauthorized" })),
        );
    }

    let node_id = NodeId(id);
    let Some(public_key) = state.device_keys.get(&node_id).map(|e| e.value().clone()) else {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "unknown node" })),
        );
    };

    let Some(signature) = hex::decode(&req.signature_hex)
        .ok()
        .and_then(|bytes| bytes.try_into().ok())
    else {
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "malformed signature" })),
        );
    };

    let message = format!("enroll:{}:{}", node_id.as_str(), req.seq);
    if !verify_signature(&public_key, message.as_bytes(), &signature) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "invalid signature" })),
        );
    }

    match state.registry.heartbeat_seq(&node_id, req.seq) {
        HeartbeatOutcome::Accepted => (
            StatusCode::OK,
            Json(serde_json::json!({ "status": "accepted" })),
        ),
        HeartbeatOutcome::Replay { expected_after } => (
            StatusCode::CONFLICT,
            Json(serde_json::json!({ "status": "replay", "expected_after": expected_after })),
        ),
        HeartbeatOutcome::Unknown => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "unknown node" })),
        ),
        HeartbeatOutcome::Revoked => (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "status": "revoked" })),
        ),
    }
}

async fn list_nodes(
    State(state): State<Arc<FleetApiState>>,
    headers: HeaderMap,
) -> impl IntoResponse {
    if !bearer_ok(&headers, &state.operator_token) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "unauthorized" })),
        );
    }
    (
        StatusCode::OK,
        Json(serde_json::json!(state.registry.list())),
    )
}

async fn summary(
    State(state): State<Arc<FleetApiState>>,
    headers: HeaderMap,
) -> impl IntoResponse {
    if !bearer_ok(&headers, &state.operator_token) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "unauthorized" })),
        );
    }
    let value = serde_json::to_value(state.registry.fleet_summary())
        .unwrap_or(serde_json::Value::Null);
    (StatusCode::OK, Json(value))
}

async fn revoke_node(
    State(state): State<Arc<FleetApiState>>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> impl IntoResponse {
    if !bearer_ok(&headers, &state.operator_token) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "unauthorized" })),
        );
    }

    let node_id = NodeId(id);
    if state.registry.revoke(&node_id) {
        (
            StatusCode::OK,
            Json(serde_json::json!({ "status": "revoked" })),
        )
    } else {
        (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "unknown node" })),
        )
    }
}

/// Build the fleet API router.
pub fn router(state: Arc<FleetApiState>) -> Router {
    Router::new()
        .route("/fleet/nodes/enroll", post(enroll))
        .route("/fleet/nodes/:id/heartbeat", post(heartbeat))
        .route("/fleet/nodes/:id/revoke", post(revoke_node))
        .route("/fleet/nodes", get(list_nodes))
        .route("/fleet/summary", get(summary))
        .with_state(state)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use tower::ServiceExt;

    use crate::identity::DeviceIdentity;

    const OP_TOKEN: &str = "op-secret";
    const ENROLL_TOKEN: &str = "enroll-secret";

    fn caps_json() -> serde_json::Value {
        serde_json::json!({
            "cpu_cores": 8,
            "ram_mb": 16384,
            "storage_mb": 256000,
            "npu_tops": 45,
            "storage_type": "UFS 4.0",
            "os_version": "Android 15",
            "app_version": "1.0.0"
        })
    }

    fn local_node() -> NodeInfo {
        NodeInfo::new(
            "local".into(),
            "127.0.0.1".parse().expect("valid ip"),
            3000,
            NodeRole::Primary,
            NodeCapabilities {
                cpu_cores: 8,
                ram_mb: 16384,
                storage_mb: 256_000,
                npu_tops: 45,
                storage_type: "UFS 4.0".into(),
                os_version: "Android 15".into(),
                app_version: "1.0.0".into(),
            },
        )
    }

    fn state() -> Arc<FleetApiState> {
        Arc::new(FleetApiState {
            registry: Arc::new(FleetRegistry::new(local_node())),
            operator_token: OP_TOKEN.into(),
            enrollment_token: EnrollmentToken::new(ENROLL_TOKEN.into()),
            device_keys: Arc::new(DashMap::new()),
        })
    }

    fn enroll_body(identity: &DeviceIdentity) -> serde_json::Value {
        serde_json::json!({
            "device_public_key_hex": identity.public_key_hex(),
            "hostname": "phone-1",
            "ip": "10.0.0.5",
            "port": 3000,
            "role": "replica",
            "capabilities": caps_json()
        })
    }

    fn enroll_request(token: Option<&str>, body: &serde_json::Value) -> Request<Body> {
        let mut builder = Request::builder()
            .method("POST")
            .uri("/fleet/nodes/enroll")
            .header("content-type", "application/json");
        if let Some(token) = token {
            builder = builder.header("x-enrollment-token", token);
        }
        builder
            .body(Body::from(serde_json::to_vec(body).expect("serialize")))
            .expect("build request")
    }

    fn heartbeat_request(
        id: &str,
        seq: u64,
        sig_hex: &str,
        auth: Option<&str>,
    ) -> Request<Body> {
        let mut builder = Request::builder()
            .method("POST")
            .uri(format!("/fleet/nodes/{id}/heartbeat"))
            .header("content-type", "application/json");
        if let Some(auth) = auth {
            builder = builder.header("authorization", auth);
        }
        let body = serde_json::json!({ "seq": seq, "signature_hex": sig_hex });
        builder
            .body(Body::from(serde_json::to_vec(&body).expect("serialize")))
            .expect("build request")
    }

    fn revoke_request(id: &str, auth: Option<&str>) -> Request<Body> {
        let mut builder = Request::builder()
            .method("POST")
            .uri(format!("/fleet/nodes/{id}/revoke"));
        if let Some(auth) = auth {
            builder = builder.header("authorization", auth);
        }
        builder.body(Body::empty()).expect("build request")
    }

    fn get_request(uri: &str, auth: Option<&str>) -> Request<Body> {
        let mut builder = Request::builder().method("GET").uri(uri);
        if let Some(auth) = auth {
            builder = builder.header("authorization", auth);
        }
        builder.body(Body::empty()).expect("build request")
    }

    async fn body_json(resp: axum::response::Response) -> serde_json::Value {
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .expect("read body");
        serde_json::from_slice(&bytes).expect("parse json")
    }

    fn heartbeat_sig(identity: &DeviceIdentity, node_id: &str, seq: u64) -> String {
        let message = format!("enroll:{node_id}:{seq}");
        hex::encode(identity.sign(message.as_bytes()))
    }

    async fn enroll_ok(state: &Arc<FleetApiState>, identity: &DeviceIdentity) -> String {
        let resp = router(state.clone())
            .oneshot(enroll_request(Some(ENROLL_TOKEN), &enroll_body(identity)))
            .await
            .expect("enroll");
        assert_eq!(resp.status(), StatusCode::CREATED);
        let json = body_json(resp).await;
        json["node_id"].as_str().expect("node_id").to_string()
    }

    #[tokio::test]
    async fn enroll_without_token_is_unauthorized() {
        let state = state();
        let identity = DeviceIdentity::from_seed([7u8; 32]);
        let resp = router(state.clone())
            .oneshot(enroll_request(None, &enroll_body(&identity)))
            .await
            .expect("request");
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn enroll_with_wrong_token_is_unauthorized() {
        let state = state();
        let identity = DeviceIdentity::from_seed([7u8; 32]);
        let resp = router(state.clone())
            .oneshot(enroll_request(Some("wrong"), &enroll_body(&identity)))
            .await
            .expect("request");
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn enroll_is_idempotent_per_device_key() {
        let state = state();
        let identity = DeviceIdentity::from_seed([7u8; 32]);

        let first = router(state.clone())
            .oneshot(enroll_request(Some(ENROLL_TOKEN), &enroll_body(&identity)))
            .await
            .expect("enroll");
        assert_eq!(first.status(), StatusCode::CREATED);
        let first_json = body_json(first).await;
        let first_id = first_json["node_id"].as_str().expect("node_id").to_string();

        let second = router(state.clone())
            .oneshot(enroll_request(Some(ENROLL_TOKEN), &enroll_body(&identity)))
            .await
            .expect("re-enroll");
        assert_eq!(second.status(), StatusCode::OK);
        let second_json = body_json(second).await;
        assert_eq!(second_json["node_id"].as_str().expect("node_id"), first_id);

        // Only one node was added to the registry.
        assert_eq!(state.registry.len(), 2);
    }

    #[tokio::test]
    async fn heartbeat_without_auth_is_unauthorized() {
        let state = state();
        let identity = DeviceIdentity::from_seed([7u8; 32]);
        let node_id = enroll_ok(&state, &identity).await;
        let sig = heartbeat_sig(&identity, &node_id, 1);

        let resp = router(state.clone())
            .oneshot(heartbeat_request(&node_id, 1, &sig, None))
            .await
            .expect("request");
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn heartbeat_with_bad_signature_is_unauthorized() {
        let state = state();
        let identity = DeviceIdentity::from_seed([7u8; 32]);
        let node_id = enroll_ok(&state, &identity).await;

        // Signature over a different message.
        let bad_sig = hex::encode(identity.sign(b"enroll:other:1"));
        let resp = router(state.clone())
            .oneshot(heartbeat_request(
                &node_id,
                1,
                &bad_sig,
                Some("Bearer op-secret"),
            ))
            .await
            .expect("request");
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn heartbeat_accepts_then_rejects_replay() {
        let state = state();
        let identity = DeviceIdentity::from_seed([7u8; 32]);
        let node_id = enroll_ok(&state, &identity).await;

        let sig1 = heartbeat_sig(&identity, &node_id, 1);
        let resp = router(state.clone())
            .oneshot(heartbeat_request(
                &node_id,
                1,
                &sig1,
                Some("Bearer op-secret"),
            ))
            .await
            .expect("request");
        assert_eq!(resp.status(), StatusCode::OK);

        // Same sequence number again -> conflict.
        let resp = router(state.clone())
            .oneshot(heartbeat_request(
                &node_id,
                1,
                &sig1,
                Some("Bearer op-secret"),
            ))
            .await
            .expect("request");
        assert_eq!(resp.status(), StatusCode::CONFLICT);
    }

    #[tokio::test]
    async fn revoke_then_heartbeat_is_forbidden() {
        let state = state();
        let identity = DeviceIdentity::from_seed([7u8; 32]);
        let node_id = enroll_ok(&state, &identity).await;

        let resp = router(state.clone())
            .oneshot(revoke_request(&node_id, Some("Bearer op-secret")))
            .await
            .expect("request");
        assert_eq!(resp.status(), StatusCode::OK);

        let sig = heartbeat_sig(&identity, &node_id, 2);
        let resp = router(state.clone())
            .oneshot(heartbeat_request(
                &node_id,
                2,
                &sig,
                Some("Bearer op-secret"),
            ))
            .await
            .expect("request");
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn revoke_unknown_node_is_not_found() {
        let state = state();
        let resp = router(state.clone())
            .oneshot(revoke_request("does-not-exist", Some("Bearer op-secret")))
            .await
            .expect("request");
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn list_nodes_requires_auth() {
        let state = state();

        let resp = router(state.clone())
            .oneshot(get_request("/fleet/nodes", None))
            .await
            .expect("request");
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);

        let resp = router(state.clone())
            .oneshot(get_request("/fleet/nodes", Some("Bearer op-secret")))
            .await
            .expect("request");
        assert_eq!(resp.status(), StatusCode::OK);
        let json = body_json(resp).await;
        assert!(json.is_array());
    }

    #[tokio::test]
    async fn summary_requires_auth() {
        let state = state();

        let resp = router(state.clone())
            .oneshot(get_request("/fleet/summary", None))
            .await
            .expect("request");
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);

        let resp = router(state.clone())
            .oneshot(get_request("/fleet/summary", Some("Bearer op-secret")))
            .await
            .expect("request");
        assert_eq!(resp.status(), StatusCode::OK);
        let json = body_json(resp).await;
        assert!(json.is_object());
    }

    #[test]
    fn constant_time_eq_works() {
        assert!(constant_time_eq("abc", "abc"));
        assert!(!constant_time_eq("abc", "abd"));
        assert!(!constant_time_eq("abc", "abcd"));
    }
}
