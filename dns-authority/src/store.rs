//! Zone and record storage.
//!
//! The authority talks to a [`DnsStore`], never to a database directly. The
//! shipped [`MemoryStore`] optionally mirrors itself to a JSON file so a single
//! node is durable; swapping in a replicated SQL store for a multi-PoP
//! deployment is a matter of implementing the same trait.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use tokio::sync::RwLock;

use crate::now_unix;
use crate::record::Record;
use crate::wire;

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("zone '{0}' already exists")]
    ZoneExists(String),
    #[error("zone '{0}' not found")]
    ZoneNotFound(String),
    #[error("record {id} not found in zone '{zone}'")]
    RecordNotFound { zone: String, id: u64 },
    #[error("store i/o error: {0}")]
    Io(String),
}

/// A zone of authority, e.g. `furlpay.com`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Zone {
    pub domain: String,
    pub owner_id: String,
    #[serde(default)]
    pub dnssec_enabled: bool,
    #[serde(default)]
    pub geo_routing_enabled: bool,
    pub created_at: i64,
}

impl Zone {
    pub fn new(domain: &str, owner_id: &str) -> Self {
        Self {
            domain: wire::canonical_name(domain),
            owner_id: owner_id.to_string(),
            dnssec_enabled: false,
            geo_routing_enabled: false,
            created_at: now_unix(),
        }
    }
}

#[async_trait]
pub trait DnsStore: Send + Sync {
    async fn list_zones(&self) -> Vec<Zone>;
    async fn get_zone(&self, domain: &str) -> Option<Zone>;
    async fn create_zone(&self, zone: Zone) -> Result<Zone, StoreError>;
    async fn delete_zone(&self, domain: &str) -> Result<Zone, StoreError>;

    async fn list_records(&self, zone: &str) -> Vec<Record>;
    /// Every record owned by `fqdn`, across all types.
    async fn find_records(&self, fqdn: &str) -> Vec<Record>;
    async fn get_record(&self, zone: &str, id: u64) -> Option<Record>;
    /// Insert a new record, or replace an existing one matched by id or by the
    /// natural key `(zone, name, type, value)`.
    async fn put_record(&self, record: Record) -> Result<Record, StoreError>;
    async fn delete_record(&self, zone: &str, id: u64) -> Result<Record, StoreError>;
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Snapshot {
    zones: BTreeMap<String, Zone>,
    records: Vec<Record>,
}

/// In-memory store with optional JSON-file durability.
pub struct MemoryStore {
    inner: RwLock<Snapshot>,
    persist_path: Option<PathBuf>,
}

impl Default for MemoryStore {
    fn default() -> Self {
        Self { inner: RwLock::new(Snapshot::default()), persist_path: None }
    }
}

impl MemoryStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// Open a store, loading any previously persisted snapshot.
    pub fn open(path: impl Into<PathBuf>) -> Result<Self, StoreError> {
        let path = path.into();
        let snapshot = if path.exists() {
            let raw = std::fs::read_to_string(&path).map_err(|e| StoreError::Io(e.to_string()))?;
            if raw.trim().is_empty() {
                Snapshot::default()
            } else {
                serde_json::from_str(&raw).map_err(|e| StoreError::Io(e.to_string()))?
            }
        } else {
            Snapshot::default()
        };
        Ok(Self { inner: RwLock::new(snapshot), persist_path: Some(path) })
    }

    fn persist(&self, snapshot: &Snapshot) -> Result<(), StoreError> {
        let Some(path) = &self.persist_path else {
            return Ok(());
        };
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent).map_err(|e| StoreError::Io(e.to_string()))?;
            }
        }
        let encoded =
            serde_json::to_vec_pretty(snapshot).map_err(|e| StoreError::Io(e.to_string()))?;
        // Write to a sibling temp file then rename, so a crash mid-write cannot
        // leave a truncated snapshot behind.
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, &encoded).map_err(|e| StoreError::Io(e.to_string()))?;
        std::fs::rename(&tmp, path).map_err(|e| StoreError::Io(e.to_string()))?;
        Ok(())
    }
}

#[async_trait]
impl DnsStore for MemoryStore {
    async fn list_zones(&self) -> Vec<Zone> {
        self.inner.read().await.zones.values().cloned().collect()
    }

    async fn get_zone(&self, domain: &str) -> Option<Zone> {
        self.inner.read().await.zones.get(&wire::canonical_name(domain)).cloned()
    }

    async fn create_zone(&self, zone: Zone) -> Result<Zone, StoreError> {
        let mut inner = self.inner.write().await;
        if inner.zones.contains_key(&zone.domain) {
            return Err(StoreError::ZoneExists(zone.domain));
        }
        inner.zones.insert(zone.domain.clone(), zone.clone());
        self.persist(&inner)?;
        Ok(zone)
    }

    async fn delete_zone(&self, domain: &str) -> Result<Zone, StoreError> {
        let domain = wire::canonical_name(domain);
        let mut inner = self.inner.write().await;
        let removed = inner.zones.remove(&domain).ok_or(StoreError::ZoneNotFound(domain.clone()))?;
        inner.records.retain(|record| record.zone != domain);
        self.persist(&inner)?;
        Ok(removed)
    }

    async fn list_records(&self, zone: &str) -> Vec<Record> {
        let zone = wire::canonical_name(zone);
        let mut records: Vec<Record> =
            self.inner.read().await.records.iter().filter(|r| r.zone == zone).cloned().collect();
        records.sort_by(|a, b| (a.name.as_str(), a.rtype(), a.id).cmp(&(b.name.as_str(), b.rtype(), b.id)));
        records
    }

    async fn find_records(&self, fqdn: &str) -> Vec<Record> {
        let fqdn = wire::canonical_name(fqdn);
        self.inner
            .read()
            .await
            .records
            .iter()
            .filter(|record| record.fqdn() == fqdn)
            .cloned()
            .collect()
    }

    async fn get_record(&self, zone: &str, id: u64) -> Option<Record> {
        let zone = wire::canonical_name(zone);
        self.inner
            .read()
            .await
            .records
            .iter()
            .find(|record| record.zone == zone && record.id == id)
            .cloned()
    }

    async fn put_record(&self, record: Record) -> Result<Record, StoreError> {
        let mut inner = self.inner.write().await;
        let position = inner.records.iter().position(|existing| {
            (existing.zone == record.zone && existing.id == record.id)
                || (existing.zone == record.zone
                    && existing.name == record.name
                    && existing.record_type == record.record_type
                    && existing.value == record.value)
        });
        let stored = match position {
            Some(index) => {
                let mut merged = record;
                merged.id = inner.records[index].id;
                inner.records[index] = merged.clone();
                merged
            }
            None => {
                inner.records.push(record.clone());
                record
            }
        };
        self.persist(&inner)?;
        Ok(stored)
    }

    async fn delete_record(&self, zone: &str, id: u64) -> Result<Record, StoreError> {
        let zone = wire::canonical_name(zone);
        let mut inner = self.inner.write().await;
        let position = inner
            .records
            .iter()
            .position(|record| record.zone == zone && record.id == id)
            .ok_or_else(|| StoreError::RecordNotFound { zone: zone.clone(), id })?;
        let removed = inner.records.remove(position);
        self.persist(&inner)?;
        Ok(removed)
    }
}

/// Build a store backed by `path`, creating the file's parent if needed.
pub fn open_store(path: impl AsRef<Path>) -> Result<MemoryStore, StoreError> {
    MemoryStore::open(path.as_ref())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::record::RecordType;

    fn a_record(name: &str, value: &str) -> Record {
        Record::new("furlpay.com", name, RecordType::A, value, 300, None, false).unwrap()
    }

    #[tokio::test]
    async fn zones_are_unique() {
        let store = MemoryStore::new();
        store.create_zone(Zone::new("FurlPay.com", "ashutosh0x")).await.unwrap();
        assert_eq!(store.get_zone("furlpay.com").await.unwrap().domain, "furlpay.com");
        assert!(store.create_zone(Zone::new("furlpay.com", "other")).await.is_err());
        assert_eq!(store.list_zones().await.len(), 1);
    }

    #[tokio::test]
    async fn records_are_upserted_by_natural_key() {
        let store = MemoryStore::new();
        store.create_zone(Zone::new("furlpay.com", "owner")).await.unwrap();
        let first = store.put_record(a_record("@", "203.0.113.10")).await.unwrap();
        let second = store.put_record(a_record("@", "203.0.113.10")).await.unwrap();
        assert_eq!(first.id, second.id, "same natural key must update in place");
        assert_eq!(store.list_records("furlpay.com").await.len(), 1);

        let third = store.put_record(a_record("@", "203.0.113.11")).await.unwrap();
        assert_ne!(third.id, first.id);
        assert_eq!(store.list_records("furlpay.com").await.len(), 2);
    }

    #[tokio::test]
    async fn find_records_matches_on_the_fully_qualified_name() {
        let store = MemoryStore::new();
        store.create_zone(Zone::new("furlpay.com", "owner")).await.unwrap();
        store.put_record(a_record("api", "203.0.113.10")).await.unwrap();
        store.put_record(a_record("@", "203.0.113.20")).await.unwrap();
        assert_eq!(store.find_records("api.furlpay.com").await.len(), 1);
        assert_eq!(store.find_records("furlpay.com").await.len(), 1);
        assert!(store.find_records("nope.furlpay.com").await.is_empty());
    }

    #[tokio::test]
    async fn deleting_a_zone_removes_its_records() {
        let store = MemoryStore::new();
        store.create_zone(Zone::new("furlpay.com", "owner")).await.unwrap();
        store.put_record(a_record("@", "203.0.113.10")).await.unwrap();
        store.delete_zone("furlpay.com").await.unwrap();
        assert!(store.list_records("furlpay.com").await.is_empty());
        assert!(store.delete_zone("furlpay.com").await.is_err());
    }

    #[tokio::test]
    async fn json_store_survives_a_reopen() {
        let path = std::env::temp_dir().join(format!("mc-dns-test-{}.json", std::process::id()));
        let _ = std::fs::remove_file(&path);
        {
            let store = MemoryStore::open(&path).unwrap();
            store.create_zone(Zone::new("furlpay.com", "owner")).await.unwrap();
            store.put_record(a_record("@", "203.0.113.10")).await.unwrap();
        }
        let reopened = MemoryStore::open(&path).unwrap();
        assert_eq!(reopened.list_zones().await.len(), 1);
        assert_eq!(reopened.list_records("furlpay.com").await.len(), 1);
        let _ = std::fs::remove_file(&path);
    }
}
