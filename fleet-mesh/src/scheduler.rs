//! Resource-aware placement of workloads onto fleet nodes.
//!
//! This module performs **placement only** — it selects the node(s) a workload
//! *should* run on. It does not execute, dispatch, or monitor the workload;
//! that is the responsibility of the caller.

use crate::node::{FleetRegistry, NodeId, NodeInfo, NodeRole};

/// Minimum resources and optional role a workload requires.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct WorkloadRequirements {
    pub min_cores: u32,
    pub min_ram_mb: u64,
    pub min_storage_mb: u64,
    /// If set, only nodes with exactly this role are eligible.
    pub role: Option<NodeRole>,
}

fn meets(node: &NodeInfo, req: &WorkloadRequirements) -> bool {
    node.capabilities.cpu_cores >= req.min_cores
        && node.capabilities.ram_mb >= req.min_ram_mb
        && node.capabilities.storage_mb >= req.min_storage_mb
        && req.role.is_none_or(|role| node.role == role)
}

/// Rank eligible nodes best-first.
///
/// Ordering is deterministic: higher `(cpu_cores, ram_mb, storage_mb)` first,
/// then ascending lexicographic [`NodeId`] as a stable tie-break.
fn ranked_eligible(registry: &FleetRegistry, req: &WorkloadRequirements) -> Vec<NodeInfo> {
    let mut eligible: Vec<NodeInfo> = registry
        .list()
        .into_iter()
        .filter(|node| node.is_available() && !registry.is_revoked(&node.id) && meets(node, req))
        .collect();

    eligible.sort_by(|a, b| {
        let a_key = (
            a.capabilities.cpu_cores,
            a.capabilities.ram_mb,
            a.capabilities.storage_mb,
        );
        let b_key = (
            b.capabilities.cpu_cores,
            b.capabilities.ram_mb,
            b.capabilities.storage_mb,
        );
        // Higher resources first, then lexicographically smallest id.
        b_key.cmp(&a_key).then_with(|| a.id.as_str().cmp(b.id.as_str()))
    });

    eligible
}

/// Select the single best node for a workload, or `None` if none qualifies.
///
/// Only available, non-revoked nodes are considered, and the local node is
/// never selected unless it is itself available.
pub fn select_node(registry: &FleetRegistry, req: &WorkloadRequirements) -> Option<NodeId> {
    ranked_eligible(registry, req)
        .into_iter()
        .next()
        .map(|node| node.id)
}

/// Select up to `k` distinct best nodes, in the same order as
/// [`select_node`].
pub fn select_nodes(registry: &FleetRegistry, req: &WorkloadRequirements, k: usize) -> Vec<NodeId> {
    ranked_eligible(registry, req)
        .into_iter()
        .take(k)
        .map(|node| node.id)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::node::NodeCapabilities;
    use std::net::{IpAddr, Ipv4Addr};

    fn caps(cores: u32, ram_mb: u64, storage_mb: u64) -> NodeCapabilities {
        NodeCapabilities {
            cpu_cores: cores,
            ram_mb,
            storage_mb,
            npu_tops: 10,
            storage_type: "UFS 4.0".into(),
            os_version: "Android 15".into(),
            app_version: "1.0.0".into(),
        }
    }

    fn node(role: NodeRole, cores: u32, ram_mb: u64, storage_mb: u64) -> NodeInfo {
        NodeInfo::new(
            "n".into(),
            IpAddr::V4(Ipv4Addr::LOCALHOST),
            3000,
            role,
            caps(cores, ram_mb, storage_mb),
        )
    }

    fn empty_registry() -> FleetRegistry {
        FleetRegistry::new(node(NodeRole::Primary, 4, 8192, 128_000))
    }

    #[test]
    fn picks_best_eligible_node() {
        let registry = empty_registry();
        let small = registry.join(node(NodeRole::Replica, 4, 8192, 128_000));
        let big = registry.join(node(NodeRole::Replica, 16, 32768, 512_000));
        let mid = registry.join(node(NodeRole::Replica, 8, 16384, 256_000));

        let req = WorkloadRequirements {
            min_cores: 2,
            min_ram_mb: 1024,
            min_storage_mb: 1024,
            role: None,
        };
        let picked = select_node(&registry, &req).unwrap();
        assert_eq!(picked, big);
        assert_ne!(picked, small);
        assert_ne!(picked, mid);
    }

    #[test]
    fn skips_draining_offline_and_revoked() {
        let registry = empty_registry();
        let draining = registry.join(node(NodeRole::Replica, 16, 32768, 512_000));
        registry.drain(&draining);

        let offline = registry.join(node(NodeRole::Replica, 16, 32768, 512_000));
        registry.mark_offline(&offline);

        let revoked = registry.join(node(NodeRole::Replica, 16, 32768, 512_000));
        registry.revoke(&revoked);

        let good = registry.join(node(NodeRole::Replica, 4, 8192, 128_000));

        let req = WorkloadRequirements {
            min_cores: 1,
            min_ram_mb: 1,
            min_storage_mb: 1,
            role: None,
        };
        let picked = select_node(&registry, &req).unwrap();
        assert_eq!(picked, good);
    }

    #[test]
    fn returns_none_when_nothing_meets_requirements() {
        let registry = empty_registry();
        registry.join(node(NodeRole::Replica, 4, 8192, 128_000));
        let req = WorkloadRequirements {
            min_cores: 64,
            min_ram_mb: 1_000_000,
            min_storage_mb: 1_000_000,
            role: None,
        };
        assert!(select_node(&registry, &req).is_none());
        assert!(select_nodes(&registry, &req, 3).is_empty());
    }

    #[test]
    fn role_filter_is_respected() {
        let registry = empty_registry();
        registry.join(node(NodeRole::Builder, 32, 65536, 1_000_000));
        let replica = registry.join(node(NodeRole::Replica, 4, 8192, 128_000));

        let req = WorkloadRequirements {
            min_cores: 1,
            min_ram_mb: 1,
            min_storage_mb: 1,
            role: Some(NodeRole::Replica),
        };
        assert_eq!(select_node(&registry, &req).unwrap(), replica);
    }

    #[test]
    fn select_nodes_dedups_and_caps_at_k() {
        let registry = empty_registry();
        for _ in 0..5 {
            registry.join(node(NodeRole::Replica, 8, 16384, 256_000));
        }

        let req = WorkloadRequirements {
            min_cores: 1,
            min_ram_mb: 1,
            min_storage_mb: 1,
            role: None,
        };
        let two = select_nodes(&registry, &req, 2);
        assert_eq!(two.len(), 2);
        assert_ne!(two[0], two[1]);

        let all = select_nodes(&registry, &req, 100);
        // 5 joined replicas; the local primary is still Joining (unavailable).
        assert_eq!(all.len(), 5);
        let mut ids: Vec<&str> = all.iter().map(|id| id.as_str()).collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), all.len());
    }
}
