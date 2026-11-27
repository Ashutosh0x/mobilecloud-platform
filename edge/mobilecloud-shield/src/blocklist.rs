//! Thread-safe IP blocklist with CrowdSec-compatible file loading.
//!
//! Stores blocked IPs in a [`DashMap`] with metadata about why they were
//! blocked.  Expired entries are automatically pruned on lookup.

use std::net::IpAddr;
use std::path::Path;
use std::sync::Arc;
use std::time::Instant;

use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use tracing::{debug, info, warn};

// ───────────────────────────── types ──────────────────────────────

/// Why an IP was placed on the blocklist.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum BlockSource {
    /// Imported from a CrowdSec decisions export.
    CrowdSec,
    /// Manually added by an operator.
    Manual,
    /// Automatically added by the WAF engine.
    Waf,
}

/// Metadata associated with a blocked IP.
#[derive(Debug, Clone)]
pub struct BlockReason {
    /// Origin of the block decision.
    pub source: BlockSource,
    /// Human-readable reason.
    pub reason: String,
    /// Optional expiry.  `None` means the block never expires.
    pub expires_at: Option<Instant>,
}

/// On-disk representation used for JSON (de)serialisation.
#[derive(Debug, Deserialize)]
struct BlocklistEntry {
    ip: String,
    reason: String,
    source: String,
    /// Optional duration-in-seconds until expiry (from load time).
    #[serde(default)]
    expires_in_secs: Option<u64>,
}

// ───────────────────────────── blocklist ──────────────────────────

/// A thread-safe set of blocked IP addresses.
///
/// Backed by [`DashMap`] so look-ups and mutations are lock-free.
#[derive(Debug, Clone)]
pub struct Blocklist {
    inner: Arc<DashMap<IpAddr, BlockReason>>,
}

impl Blocklist {
    /// Create an empty blocklist.
    pub fn new() -> Self {
        Self {
            inner: Arc::new(DashMap::new()),
        }
    }

    /// Load entries from a JSON file.
    ///
    /// The file should contain a JSON array of objects with keys `ip`, `reason`,
    /// `source` (`"crowdsec"`, `"manual"`, or `"waf"`), and an optional
    /// `expires_in_secs`.
    ///
    /// ```json
    /// [
    ///   { "ip": "192.168.1.100", "reason": "brute-force", "source": "crowdsec" },
    ///   { "ip": "10.0.0.5", "reason": "scan", "source": "manual", "expires_in_secs": 3600 }
    /// ]
    /// ```
    pub fn load_from_file(&self, path: &Path) -> Result<usize, BlocklistError> {
        let data = std::fs::read_to_string(path)
            .map_err(|e| BlocklistError::Io(e.to_string()))?;
        let entries: Vec<BlocklistEntry> = serde_json::from_str(&data)
            .map_err(|e| BlocklistError::Parse(e.to_string()))?;

        let now = Instant::now();
        let mut loaded = 0usize;

        for entry in entries {
            let ip: IpAddr = match entry.ip.parse() {
                Ok(ip) => ip,
                Err(e) => {
                    warn!(ip = %entry.ip, error = %e, "skipping invalid IP in blocklist file");
                    continue;
                }
            };

            let source = match entry.source.to_lowercase().as_str() {
                "crowdsec" => BlockSource::CrowdSec,
                "waf" => BlockSource::Waf,
                _ => BlockSource::Manual,
            };

            let expires_at = entry
                .expires_in_secs
                .map(|s| now + std::time::Duration::from_secs(s));

            self.inner.insert(
                ip,
                BlockReason {
                    source,
                    reason: entry.reason,
                    expires_at,
                },
            );
            loaded += 1;
        }

        info!(loaded, path = %path.display(), "blocklist entries loaded from file");
        Ok(loaded)
    }

    /// Check whether `ip` is currently blocked.
    ///
    /// Returns `Some(BlockReason)` if blocked, `None` otherwise.  Expired
    /// entries are pruned automatically on access.
    pub fn is_blocked(&self, ip: &IpAddr) -> Option<BlockReason> {
        // Look up the entry.
        let entry = self.inner.get(ip)?;
        let reason = entry.value();

        // Check expiry.
        if let Some(expires_at) = reason.expires_at {
            if Instant::now() >= expires_at {
                // Drop the read ref before removing.
                drop(entry);
                self.inner.remove(ip);
                debug!(%ip, "expired blocklist entry removed");
                return None;
            }
        }

        Some(reason.clone())
    }

    /// Add an IP to the blocklist.
    pub fn add(&self, ip: IpAddr, reason: BlockReason) {
        info!(%ip, source = ?reason.source, reason = %reason.reason, "IP added to blocklist");
        self.inner.insert(ip, reason);
    }

    /// Remove an IP from the blocklist.  Returns `true` if it was present.
    pub fn remove(&self, ip: &IpAddr) -> bool {
        let removed = self.inner.remove(ip).is_some();
        if removed {
            info!(%ip, "IP removed from blocklist");
        }
        removed
    }

    /// Return the number of entries currently stored (including potentially
    /// expired ones that have not yet been pruned).
    pub fn len(&self) -> usize {
        self.inner.len()
    }

    /// Whether the blocklist is empty.
    pub fn is_empty(&self) -> bool {
        self.inner.is_empty()
    }
}

impl Default for Blocklist {
    fn default() -> Self {
        Self::new()
    }
}

// ───────────────────────────── errors ─────────────────────────────

/// Errors that can occur while loading a blocklist file.
#[derive(Debug, thiserror::Error)]
pub enum BlocklistError {
    /// File I/O error.
    #[error("blocklist I/O error: {0}")]
    Io(String),
    /// JSON parse error.
    #[error("blocklist parse error: {0}")]
    Parse(String),
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn add_and_check() {
        let bl = Blocklist::new();
        let ip: IpAddr = "10.0.0.1".parse().unwrap();
        bl.add(
            ip,
            BlockReason {
                source: BlockSource::Manual,
                reason: "test".into(),
                expires_at: None,
            },
        );
        assert!(bl.is_blocked(&ip).is_some());
        assert_eq!(bl.len(), 1);
    }

    #[test]
    fn expired_entries_pruned() {
        let bl = Blocklist::new();
        let ip: IpAddr = "10.0.0.2".parse().unwrap();
        bl.add(
            ip,
            BlockReason {
                source: BlockSource::CrowdSec,
                reason: "scan".into(),
                // Already expired.
                expires_at: Some(Instant::now() - std::time::Duration::from_secs(1)),
            },
        );
        // The check should prune the expired entry.
        assert!(bl.is_blocked(&ip).is_none());
    }

    #[test]
    fn load_from_json() {
        let dir = std::env::temp_dir().join("mobilecloud_shield_test");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("blocklist.json");
        let mut f = std::fs::File::create(&path).unwrap();
        writeln!(
            f,
            r#"[{{"ip":"1.2.3.4","reason":"bad","source":"crowdsec"}}]"#
        )
        .unwrap();
        let bl = Blocklist::new();
        let loaded = bl.load_from_file(&path).unwrap();
        assert_eq!(loaded, 1);
        assert!(bl.is_blocked(&"1.2.3.4".parse().unwrap()).is_some());
        std::fs::remove_dir_all(&dir).ok();
    }
}
