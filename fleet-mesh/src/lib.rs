//! MobileCloud Fleet Mesh: multi-device orchestration for distributed edge
//! computing.
//!
//! This crate provides the core infrastructure for running MobileCloud across
//! multiple physical devices (phones), enabling fleet discovery, authenticated
//! node enrollment, health monitoring, capability/energy telemetry, resource
//! aware placement, and an operator-facing HTTP API.
//!
//! ## Modules
//!
//! | Module | Purpose |
//! |--------|---------|
//! | [`node`] | Fleet registry, node lifecycle, revocation, replay-protected heartbeats. |
//! | [`identity`] | Ed25519 device identity, signature verification, enrollment tokens. |
//! | [`telemetry`] | Capability/energy telemetry that distinguishes measurement provenance. |
//! | [`health`] | Liveness evaluation and sweeping of stale/offline nodes. |
//! | [`scheduler`] | Resource-aware placement of workloads onto eligible nodes. |
//! | [`api`] | Fail-closed, authenticated axum router for fleet operations. |

pub mod api;
pub mod health;
pub mod identity;
pub mod node;
pub mod scheduler;
pub mod telemetry;

pub use node::{FleetRegistry, NodeId, NodeInfo, NodeRole, NodeStatus};
