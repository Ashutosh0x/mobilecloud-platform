//! Fleet node identity, registration, and lifecycle management.
//!
//! The [`FleetRegistry`] tracks every known node, its liveness, revocation
//! state, and per-node monotonic heartbeat sequence used for replay protection.

use std::net::IpAddr;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use dashmap::{DashMap, DashSet};
use serde::{Deserialize, Serialize};
use tracing::{info, warn};

/// A unique identifier for a fleet node, backed by a UUID v4.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct NodeId(pub String);

impl NodeId {
    pub fn generate() -> Self {
        Self(uuid::Uuid::new_v4().to_string())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for NodeId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// Runtime status of a fleet node.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NodeStatus {
    Online,
    Offline,
    Draining,
    Joining,
}

/// The role a node plays within the fleet.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NodeRole {
    /// Accepts writes, coordinates replication.
    Primary,
    /// Read-only replica that receives replicated state.
    Replica,
    /// Dedicated build runner for CI/CD workloads.
    Builder,
    /// Monitoring-only node that does not serve traffic.
    Observer,
}

/// Hardware and software capabilities of a node.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeCapabilities {
    pub cpu_cores: u32,
    pub ram_mb: u64,
    pub storage_mb: u64,
    pub npu_tops: u32,
    pub storage_type: String,
    pub os_version: String,
    pub app_version: String,
}

/// Full information about a fleet node.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeInfo {
    pub id: NodeId,
    pub hostname: String,
    pub ip: IpAddr,
    pub port: u16,
    pub status: NodeStatus,
    pub role: NodeRole,
    pub capabilities: NodeCapabilities,
    pub joined_at: u64,
    pub last_heartbeat: u64,
    /// Highest accepted heartbeat sequence number for replay protection.
    pub last_seq: u64,
}

impl NodeInfo {
    pub fn new(
        hostname: String,
        ip: IpAddr,
        port: u16,
        role: NodeRole,
        capabilities: NodeCapabilities,
    ) -> Self {
        let now = now_secs();
        Self {
            id: NodeId::generate(),
            hostname,
            ip,
            port,
            status: NodeStatus::Joining,
            role,
            capabilities,
            joined_at: now,
            last_heartbeat: now,
            last_seq: 0,
        }
    }

    /// Mark the node as online and update its heartbeat timestamp.
    pub fn activate(&mut self) {
        self.status = NodeStatus::Online;
        self.last_heartbeat = now_secs();
    }

    /// Update the heartbeat timestamp for liveness tracking.
    pub fn heartbeat(&mut self) {
        self.last_heartbeat = now_secs();
    }

    /// Whether the node is eligible to receive traffic.
    pub fn is_available(&self) -> bool {
        matches!(self.status, NodeStatus::Online)
    }
}

/// The result of processing a sequenced heartbeat.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HeartbeatOutcome {
    /// The heartbeat had a strictly increasing sequence number and was applied.
    Accepted,
    /// The sequence number was not greater than the last seen value; state was
    /// left untouched. `expected_after` is the last accepted sequence.
    Replay { expected_after: u64 },
    /// No node with the given id is registered.
    Unknown,
    /// The node has been revoked and may not heartbeat.
    Revoked,
}

/// Thread-safe registry of all known fleet nodes.
#[derive(Debug, Clone)]
pub struct FleetRegistry {
    nodes: Arc<DashMap<NodeId, NodeInfo>>,
    revoked: Arc<DashSet<NodeId>>,
    local_node_id: NodeId,
}

impl FleetRegistry {
    pub fn new(local_node: NodeInfo) -> Self {
        let id = local_node.id.clone();
        let nodes = Arc::new(DashMap::new());
        nodes.insert(local_node.id.clone(), local_node);
        Self {
            nodes,
            revoked: Arc::new(DashSet::new()),
            local_node_id: id,
        }
    }

    /// Register a new node in the fleet.
    ///
    /// A revoked id is refused (fail closed) and returned unchanged without
    /// being inserted or activated.
    pub fn join(&self, mut node: NodeInfo) -> NodeId {
        let id = node.id.clone();
        if self.revoked.contains(&id) {
            warn!(node_id = %id, "refusing to join revoked node");
            return id;
        }
        node.activate();
        info!(node_id = %id, hostname = %node.hostname, "node joined fleet");
        self.nodes.insert(id.clone(), node);
        id
    }

    /// Remove a node from the fleet.
    pub fn leave(&self, id: &NodeId) -> Option<NodeInfo> {
        let removed = self.nodes.remove(id).map(|(_, info)| info);
        if removed.is_some() {
            info!(node_id = %id, "node left fleet");
        } else {
            warn!(node_id = %id, "attempted to remove unknown node");
        }
        removed
    }

    /// Update a node's heartbeat timestamp, bumping its sequence counter.
    ///
    /// Returns `false` for unknown or revoked nodes.
    pub fn heartbeat(&self, id: &NodeId) -> bool {
        if self.revoked.contains(id) {
            warn!(node_id = %id, "heartbeat from revoked node rejected");
            return false;
        }
        if let Some(mut entry) = self.nodes.get_mut(id) {
            entry.last_seq = entry.last_seq.saturating_add(1);
            entry.heartbeat();
            true
        } else {
            false
        }
    }

    /// Process a sequenced heartbeat with replay protection.
    ///
    /// Only strictly increasing sequence numbers are accepted. Any value less
    /// than or equal to the last accepted sequence is treated as a replay and
    /// leaves state unchanged.
    pub fn heartbeat_seq(&self, id: &NodeId, seq: u64) -> HeartbeatOutcome {
        if self.revoked.contains(id) {
            return HeartbeatOutcome::Revoked;
        }
        match self.nodes.get_mut(id) {
            None => HeartbeatOutcome::Unknown,
            Some(mut entry) => {
                if seq > entry.last_seq {
                    entry.last_seq = seq;
                    entry.heartbeat();
                    HeartbeatOutcome::Accepted
                } else {
                    HeartbeatOutcome::Replay {
                        expected_after: entry.last_seq,
                    }
                }
            }
        }
    }

    /// Revoke a node, marking it offline so it is excluded from availability.
    ///
    /// The id is always recorded as revoked (fail closed); the return value
    /// indicates whether a node with that id was currently registered.
    pub fn revoke(&self, id: &NodeId) -> bool {
        self.revoked.insert(id.clone());
        if let Some(mut entry) = self.nodes.get_mut(id) {
            entry.status = NodeStatus::Offline;
            info!(node_id = %id, "node revoked");
            true
        } else {
            warn!(node_id = %id, "revoked unknown node id");
            false
        }
    }

    /// Whether a node id has been revoked.
    pub fn is_revoked(&self, id: &NodeId) -> bool {
        self.revoked.contains(id)
    }

    /// Mark a node as draining (will not receive new traffic).
    pub fn drain(&self, id: &NodeId) -> bool {
        if let Some(mut entry) = self.nodes.get_mut(id) {
            entry.status = NodeStatus::Draining;
            info!(node_id = %id, "node draining");
            true
        } else {
            false
        }
    }

    /// Mark a node as offline.
    pub fn mark_offline(&self, id: &NodeId) {
        if let Some(mut entry) = self.nodes.get_mut(id) {
            if entry.status != NodeStatus::Offline {
                warn!(node_id = %id, hostname = %entry.hostname, "node marked offline");
                entry.status = NodeStatus::Offline;
            }
        }
    }

    /// Return a snapshot of all registered nodes.
    pub fn list(&self) -> Vec<NodeInfo> {
        self.nodes.iter().map(|entry| entry.value().clone()).collect()
    }

    /// Return only nodes that are online, available, and not revoked.
    pub fn available_nodes(&self) -> Vec<NodeInfo> {
        self.nodes
            .iter()
            .filter(|entry| {
                let node = entry.value();
                node.is_available() && !self.revoked.contains(&node.id)
            })
            .map(|entry| entry.value().clone())
            .collect()
    }

    /// Look up a single node by its ID.
    pub fn get(&self, id: &NodeId) -> Option<NodeInfo> {
        self.nodes.get(id).map(|entry| entry.value().clone())
    }

    /// The ID of this node (the one running this process).
    pub fn local_id(&self) -> &NodeId {
        &self.local_node_id
    }

    /// Total number of nodes.
    pub fn len(&self) -> usize {
        self.nodes.len()
    }

    pub fn is_empty(&self) -> bool {
        self.nodes.is_empty()
    }

    /// Whether the local node holds the primary role.
    pub fn is_primary(&self) -> bool {
        self.nodes
            .get(&self.local_node_id)
            .is_some_and(|n| n.role == NodeRole::Primary)
    }

    /// Aggregate fleet resources.
    ///
    /// Revoked nodes are never counted as online, even if their stored status
    /// has not yet been updated.
    pub fn fleet_summary(&self) -> FleetSummary {
        let mut summary = FleetSummary::default();
        for entry in self.nodes.iter() {
            let node = entry.value();
            summary.total_nodes += 1;
            if node.is_available() && !self.revoked.contains(&node.id) {
                summary.online_nodes += 1;
            }
            summary.total_cores += node.capabilities.cpu_cores;
            summary.total_ram_mb += node.capabilities.ram_mb;
            summary.total_storage_mb += node.capabilities.storage_mb;
            summary.total_npu_tops += node.capabilities.npu_tops;
        }
        summary
    }
}

/// Aggregate resource summary across all fleet nodes.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct FleetSummary {
    pub total_nodes: u32,
    pub online_nodes: u32,
    pub total_cores: u32,
    pub total_ram_mb: u64,
    pub total_storage_mb: u64,
    pub total_npu_tops: u32,
    pub requests_per_sec: u64,
    pub avg_latency_ms: u64,
}

pub(crate) fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::Ipv4Addr;

    fn test_caps() -> NodeCapabilities {
        NodeCapabilities {
            cpu_cores: 8,
            ram_mb: 16384,
            storage_mb: 256_000,
            npu_tops: 45,
            storage_type: "UFS 4.0".into(),
            os_version: "Android 15".into(),
            app_version: "1.0.0".into(),
        }
    }

    fn test_node(hostname: &str) -> NodeInfo {
        NodeInfo::new(
            hostname.into(),
            IpAddr::V4(Ipv4Addr::new(192, 168, 1, 10)),
            3000,
            NodeRole::Replica,
            test_caps(),
        )
    }

    fn test_primary() -> NodeInfo {
        NodeInfo::new(
            "primary".into(),
            IpAddr::V4(Ipv4Addr::LOCALHOST),
            3000,
            NodeRole::Primary,
            test_caps(),
        )
    }

    #[test]
    fn registry_join_and_list() {
        let primary = NodeInfo::new(
            "primary".into(),
            IpAddr::V4(Ipv4Addr::LOCALHOST),
            3000,
            NodeRole::Primary,
            test_caps(),
        );
        let registry = FleetRegistry::new(primary);
        assert_eq!(registry.len(), 1);

        let node2 = test_node("node-2");
        registry.join(node2);
        assert_eq!(registry.len(), 2);
    }

    #[test]
    fn registry_leave_removes_node() {
        let primary = NodeInfo::new(
            "primary".into(),
            IpAddr::V4(Ipv4Addr::LOCALHOST),
            3000,
            NodeRole::Primary,
            test_caps(),
        );
        let registry = FleetRegistry::new(primary);
        let node = test_node("leaver");
        let id = registry.join(node);
        assert_eq!(registry.len(), 2);
        registry.leave(&id);
        assert_eq!(registry.len(), 1);
    }

    #[test]
    fn registry_drain_excludes_from_available() {
        let primary = NodeInfo::new(
            "primary".into(),
            IpAddr::V4(Ipv4Addr::LOCALHOST),
            3000,
            NodeRole::Primary,
            test_caps(),
        );
        let registry = FleetRegistry::new(primary);
        let node = test_node("drainer");
        let id = registry.join(node);

        // Both should be available initially (primary is Joining until activated)
        let avail_before = registry.available_nodes().len();
        registry.drain(&id);
        let avail_after = registry.available_nodes().len();
        assert!(avail_after < avail_before);
    }

    #[test]
    fn fleet_summary_aggregates_resources() {
        let primary = NodeInfo::new(
            "primary".into(),
            IpAddr::V4(Ipv4Addr::LOCALHOST),
            3000,
            NodeRole::Primary,
            test_caps(),
        );
        let registry = FleetRegistry::new(primary);
        registry.join(test_node("node-2"));
        registry.join(test_node("node-3"));

        let summary = registry.fleet_summary();
        assert_eq!(summary.total_nodes, 3);
        assert_eq!(summary.total_cores, 24); // 8 * 3
        assert_eq!(summary.total_ram_mb, 49152); // 16384 * 3
    }

    #[test]
    fn heartbeat_updates_timestamp() {
        let primary = NodeInfo::new(
            "primary".into(),
            IpAddr::V4(Ipv4Addr::LOCALHOST),
            3000,
            NodeRole::Primary,
            test_caps(),
        );
        let registry = FleetRegistry::new(primary);
        let node = test_node("heartbeater");
        let id = registry.join(node);
        let before = registry.get(&id).unwrap().last_heartbeat;
        std::thread::sleep(std::time::Duration::from_millis(10));
        registry.heartbeat(&id);
        let after = registry.get(&id).unwrap().last_heartbeat;
        assert!(after >= before);
    }

    #[test]
    fn revoked_node_is_rejected() {
        let registry = FleetRegistry::new(test_primary());
        let node = test_node("victim");
        let id = registry.join(node);
        assert!(registry.get(&id).unwrap().is_available());

        assert!(registry.revoke(&id));
        assert!(registry.is_revoked(&id));
        // Revocation marks the node offline and removes it from availability.
        assert!(!registry.get(&id).unwrap().is_available());
        assert!(!registry
            .available_nodes()
            .iter()
            .any(|n| n.id == id));

        // A revoked id may not re-join the fleet.
        let mut rejoin = test_node("victim");
        rejoin.id = id.clone();
        registry.join(rejoin);
        assert!(!registry.get(&id).unwrap().is_available());

        // Revoked nodes may not heartbeat.
        assert!(!registry.heartbeat(&id));
    }

    #[test]
    fn heartbeat_replay_is_rejected() {
        let registry = FleetRegistry::new(test_primary());
        let id = registry.join(test_node("seq-node"));

        assert_eq!(registry.heartbeat_seq(&id, 5), HeartbeatOutcome::Accepted);
        let after_accept = registry.get(&id).unwrap();
        assert_eq!(after_accept.last_seq, 5);

        // Equal sequence is a replay.
        assert_eq!(
            registry.heartbeat_seq(&id, 5),
            HeartbeatOutcome::Replay { expected_after: 5 }
        );
        // Lower sequence is also a replay.
        assert_eq!(
            registry.heartbeat_seq(&id, 4),
            HeartbeatOutcome::Replay { expected_after: 5 }
        );

        // State is unchanged by the replays.
        let after_replay = registry.get(&id).unwrap();
        assert_eq!(after_replay.last_seq, 5);
        assert_eq!(after_replay.last_heartbeat, after_accept.last_heartbeat);
    }

    #[test]
    fn heartbeat_seq_accepts_increasing() {
        let registry = FleetRegistry::new(test_primary());
        let id = registry.join(test_node("seq-node"));

        assert_eq!(registry.heartbeat_seq(&id, 1), HeartbeatOutcome::Accepted);
        assert_eq!(registry.heartbeat_seq(&id, 2), HeartbeatOutcome::Accepted);
        assert_eq!(registry.heartbeat_seq(&id, 10), HeartbeatOutcome::Accepted);
        assert_eq!(registry.get(&id).unwrap().last_seq, 10);

        let missing = NodeId::generate();
        assert_eq!(
            registry.heartbeat_seq(&missing, 1),
            HeartbeatOutcome::Unknown
        );
    }

    #[test]
    fn heartbeat_seq_rejects_revoked() {
        let registry = FleetRegistry::new(test_primary());
        let id = registry.join(test_node("seq-node"));
        registry.revoke(&id);
        assert_eq!(registry.heartbeat_seq(&id, 99), HeartbeatOutcome::Revoked);
    }

    #[test]
    fn fleet_summary_excludes_revoked() {
        let registry = FleetRegistry::new(test_primary());
        let id = registry.join(test_node("node-2"));
        assert_eq!(registry.fleet_summary().online_nodes, 1);

        registry.revoke(&id);
        assert_eq!(registry.fleet_summary().online_nodes, 0);
    }
}
