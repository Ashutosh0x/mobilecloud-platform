//! # MobileCloud Sovereign DNS Authority
//!
//! Replaces Cloudflare's authoritative DNS. Everything in the resolution path —
//! the wire codec, the authoritative logic, and the geographic edge routing —
//! is owned by MobileCloud and has no third-party dependency in the hot path.
//!
//! Layers:
//! * [`wire`] — RFC 1035 message codec (parse + encode with name compression).
//! * [`record`] — the stored record model and presentation-form parsing.
//! * [`geo`] — the GeoDNS layer that maps clients to the nearest edge PoP.
//! * [`store`] — the [`DnsStore`] abstraction and its in-memory implementation.
//! * [`resolver`] — authoritative resolution built on the store.
//! * [`api`] — the management REST API that replaces Cloudflare's DNS API.
//! * [`server`] — UDP/TCP DNS listeners.
//! * [`metrics`] — Prometheus-text counters for queries and responses.

pub mod api;
pub mod config;
pub mod geo;
pub mod metrics;
pub mod record;
pub mod resolver;
pub mod server;
pub mod store;
pub mod wire;

pub use geo::{GeoRegion, GeoRouter, Ipv4Cidr};
pub use record::{Record, RecordError, RecordType, DEFAULT_TTL};
pub use resolver::{AuthoritativeResolver, ResolutionOutcome, Resolver};
pub use store::{DnsStore, MemoryStore, StoreError, Zone};

use std::time::{SystemTime, UNIX_EPOCH};

/// Seconds since the Unix epoch, saturating at 0 if the clock is before it.
pub fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs() as i64)
        .unwrap_or(0)
}
