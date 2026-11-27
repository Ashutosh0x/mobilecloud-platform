//! Node liveness evaluation and sweeping.
//!
//! Liveness is derived from the age of a node's last heartbeat relative to a
//! [`HealthPolicy`]. Revoked and explicitly offline nodes are always reported
//! as [`Liveness::Offline`].

use serde::{Deserialize, Serialize};

use crate::node::{FleetRegistry, NodeId, NodeInfo, NodeStatus};

/// The evaluated liveness of a node.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Liveness {
    /// Heartbeating within the stale threshold.
    Online,
    /// Lagging behind but not yet considered offline.
    Stale,
    /// Not heartbeating within the offline threshold, or explicitly offline.
    Offline,
}

/// Thresholds (in seconds) that classify heartbeat age.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct HealthPolicy {
    /// Age at which a node is considered stale.
    pub stale_after_secs: u64,
    /// Age at which a node is considered offline.
    pub offline_after_secs: u64,
}

impl Default for HealthPolicy {
    fn default() -> Self {
        Self {
            stale_after_secs: 30,
            offline_after_secs: 120,
        }
    }
}

/// Evaluate the liveness of a single node at time `now`.
pub fn liveness(node: &NodeInfo, now: u64, policy: &HealthPolicy) -> Liveness {
    // Revocation marks a node offline, so an explicit offline status covers
    // both revocation and administrative offline transitions.
    if node.status == NodeStatus::Offline {
        return Liveness::Offline;
    }

    let age = now.saturating_sub(node.last_heartbeat);
    if age >= policy.offline_after_secs {
        Liveness::Offline
    } else if age >= policy.stale_after_secs {
        Liveness::Stale
    } else {
        Liveness::Online
    }
}

/// Evaluate every node and mark those that have fallen offline.
///
/// Stale nodes are reported but not forcibly transitioned (staleness is not
/// the same as being offline). Offline nodes are marked via
/// [`FleetRegistry::mark_offline`]. The returned ids are all affected nodes
/// (stale or offline).
pub fn sweep(registry: &FleetRegistry, now: u64, policy: &HealthPolicy) -> Vec<NodeId> {
    let mut affected = Vec::new();
    for node in registry.list() {
        match liveness(&node, now, policy) {
            Liveness::Online => {}
            Liveness::Stale => affected.push(node.id),
            Liveness::Offline => {
                registry.mark_offline(&node.id);
                affected.push(node.id);
            }
        }
    }
    affected
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::node::{NodeCapabilities, NodeRole};
    use std::net::{IpAddr, Ipv4Addr};

    fn caps() -> NodeCapabilities {
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

    fn node() -> NodeInfo {
        NodeInfo::new(
            "n".into(),
            IpAddr::V4(Ipv4Addr::LOCALHOST),
            3000,
            NodeRole::Replica,
            caps(),
        )
    }

    #[test]
    fn fresh_is_online() {
        let mut n = node();
        n.status = NodeStatus::Online;
        n.last_heartbeat = 1_000;
        let policy = HealthPolicy::default();
        assert_eq!(liveness(&n, 1_000, &policy), Liveness::Online);
    }

    #[test]
    fn age_at_stale_threshold_is_stale() {
        let mut n = node();
        n.status = NodeStatus::Online;
        n.last_heartbeat = 1_000;
        let policy = HealthPolicy::default();
        assert_eq!(
            liveness(&n, 1_000 + policy.stale_after_secs, &policy),
            Liveness::Stale
        );
    }

    #[test]
    fn age_at_offline_threshold_is_offline() {
        let mut n = node();
        n.status = NodeStatus::Online;
        n.last_heartbeat = 1_000;
        let policy = HealthPolicy::default();
        assert_eq!(
            liveness(&n, 1_000 + policy.offline_after_secs, &policy),
            Liveness::Offline
        );
    }

    #[test]
    fn revoked_node_is_offline() {
        let mut local = node();
        local.status = NodeStatus::Online;
        let registry = FleetRegistry::new(local);
        let id = registry.local_id().clone();
        let policy = HealthPolicy::default();

        // A freshly joined node is online.
        let fresh = registry.get(&id).unwrap();
        assert_eq!(
            liveness(&fresh, fresh.last_heartbeat, &policy),
            Liveness::Online
        );

        // Revocation forces the node offline regardless of heartbeat age.
        registry.revoke(&id);
        let revoked = registry.get(&id).unwrap();
        assert_eq!(
            liveness(&revoked, revoked.last_heartbeat, &policy),
            Liveness::Offline
        );
    }

    #[test]
    fn sweep_marks_offline_and_reports_affected() {
        let mut local = node();
        local.status = NodeStatus::Online;
        let registry = FleetRegistry::new(local);
        let local_id = registry.local_id().clone();
        let policy = HealthPolicy::default();

        // Far enough in the future that the node is offline.
        let hb = registry.get(&local_id).unwrap().last_heartbeat;
        let now = hb + policy.offline_after_secs + 5;
        let affected = sweep(&registry, now, &policy);

        assert!(affected.contains(&local_id));
        assert_eq!(
            registry.get(&local_id).unwrap().status,
            NodeStatus::Offline
        );
    }
}
