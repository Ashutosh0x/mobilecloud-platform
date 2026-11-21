//! On-device CI/CD compilation engine: framework detection, libgit2 shallow
//! fetching, Bun/Turbopack execution, and atomic deployment promotion.

pub mod atomic_promoter;
pub mod bun_runner;
pub mod framework_detector;
pub mod git_cloner;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use crate::proxy::router::WorkerPool;

/// One immutable deployment (content-addressed; retained for instant
/// sub-15ms rollbacks).
#[derive(Debug, Clone)]
pub struct DeployRecord {
    pub project: String,
    pub deploy_id: String,
    pub commit: String,
    pub branch: String,
    pub framework: String,
    pub built_at: u64,
    pub ttfb_hint_ms: Option<u32>,
}

/// Content-addressed deployment store with live-pointer bookkeeping.
///
/// Layout under home:
/// `deployments/<project>/<deploy_id>/{output,meta.json}` (immutable) and
/// `live/<project>` → atomic symlink into it.
pub struct DeploymentStore {
    records: parking_free::RwLock<HashMap<String, Vec<DeployRecord>>>,
    /// deploy_id prefix (dpl-c4a89) → project, for preview URL resolution.
    prefixes: parking_free::RwLock<HashMap<String, String>>,
    live: parking_free::RwLock<HashMap<String, String>>, // project → deploy_id
    workers: WorkerPool,
}

/// Minimal std::sync::RwLock wrapper — avoids an extra dependency while
/// keeping call sites readable.
mod parking_free {
    pub struct RwLock<T>(std::sync::RwLock<T>);

    impl<T> RwLock<T> {
        pub fn new(value: T) -> Self {
            RwLock(std::sync::RwLock::new(value))
        }
        pub fn read(&self) -> std::sync::RwLockReadGuard<'_, T> {
            self.0.read().unwrap_or_else(|e| e.into_inner())
        }
        pub fn write(&self) -> std::sync::RwLockWriteGuard<'_, T> {
            self.0.write().unwrap_or_else(|e| e.into_inner())
        }
    }
}

impl DeploymentStore {
    pub fn new() -> Self {
        DeploymentStore {
            records: parking_free::RwLock::new(HashMap::new()),
            prefixes: parking_free::RwLock::new(HashMap::new()),
            live: parking_free::RwLock::new(HashMap::new()),
            workers: WorkerPool::new(),
        }
    }

    pub fn record(&self, record: DeployRecord) {
        // Register the preview prefix (first 6 hex chars of the deploy id).
        if let Some(prefix) = record.deploy_id.strip_prefix("dpl_").and_then(|h| h.get(..6)) {
            self.prefixes
                .write()
                .insert(prefix.to_string(), record.project.clone());
        }
        // Every promotion of the same deploy_id (rollback) refreshes liveness.
        self.live
            .write()
            .insert(record.project.clone(), record.deploy_id.clone());
        let mut records = self.records.write();
        records
            .entry(record.project.clone())
            .or_default()
            .retain(|r| r.deploy_id != record.deploy_id);
        records
            .get_mut(&record.project)
            .expect("entry just created")
            .push(record);
    }

    /// Point `live/<project>` at a previously recorded deployment (rollback).
    pub fn rollback(&self, project: &str, deploy_id: &str) -> Option<DeployRecord> {
        let records = self.records.read();
        let record = records
            .get(project)?
            .iter()
            .find(|r| r.deploy_id == deploy_id)?
            .clone();
        drop(records);
        self.record(record.clone());
        Some(record)
    }

    pub fn history(&self, project: &str) -> Vec<DeployRecord> {
        self.records
            .read()
            .get(project)
            .cloned()
            .unwrap_or_default()
    }

    pub fn project_for_prefix(&self, prefix: &str) -> Option<String> {
        self.prefixes.read().get(prefix).cloned()
    }

    pub fn live_count(&self) -> usize {
        self.live.read().len()
    }

    /// The output directory of the live deployment for a project.
    pub fn live_output_dir(&self, home: &std::path::Path, project: &str) -> Option<PathBuf> {
        let deploy_id = self.live.read().get(project).cloned()?;
        Some(
            home.join("deployments")
                .join(project)
                .join(deploy_id)
                .join("output"),
        )
    }

    pub fn worker_pool(&self) -> &WorkerPool {
        &self.workers
    }
}

impl Default for DeploymentStore {
    fn default() -> Self {
        Self::new()
    }
}
