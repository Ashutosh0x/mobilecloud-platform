//! Publish immutable static artifacts, then atomically replace the single
//! manifest used by history, rollback and serving. One engine owns a home.

use std::fs::{self, File};
use std::io::{ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use sha2::{Digest, Sha256};

use super::{valid_deploy_id, valid_project, DeployRecord};
use crate::proxy::router::RouteTable;

pub const MAX_STATIC_FILE: u64 = 16 * 1024 * 1024;

#[derive(Default, serde::Serialize, serde::Deserialize)]
pub struct DeploymentSnapshot {
    pub active: Option<String>,
    pub history: Vec<DeployRecord>,
}

pub struct DeploymentStore {
    root: PathBuf,
    writers: Mutex<()>,
}

impl DeploymentStore {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            writers: Mutex::new(()),
        }
    }

    fn project_dir(&self, project: &str) -> anyhow::Result<PathBuf> {
        anyhow::ensure!(valid_project(project), "invalid project identifier");
        let path = self.root.join(project);
        match fs::symlink_metadata(&path) {
            Ok(meta) => anyhow::ensure!(meta.is_dir(), "project store is not a directory"),
            Err(e) if e.kind() == ErrorKind::NotFound => (),
            Err(e) => return Err(e.into()),
        }
        Ok(path)
    }

    pub fn read(&self, project: &str) -> anyhow::Result<DeploymentSnapshot> {
        let path = self.project_dir(project)?.join("state.json");
        match fs::symlink_metadata(&path) {
            Ok(meta) => anyhow::ensure!(meta.is_file(), "invalid deployment manifest"),
            Err(e) if e.kind() == ErrorKind::NotFound => return Ok(DeploymentSnapshot::default()),
            Err(e) => return Err(e.into()),
        }
        let snapshot: DeploymentSnapshot = serde_json::from_reader(File::open(path)?)?;
        anyhow::ensure!(
            snapshot
                .history
                .iter()
                .all(|r| r.project == project && valid_deploy_id(&r.deploy_id))
                && snapshot
                    .active
                    .as_ref()
                    .is_none_or(|id| snapshot.history.iter().any(|r| &r.deploy_id == id)),
            "invalid deployment manifest identifiers"
        );
        Ok(snapshot)
    }

    fn replace(&self, project: &str, snapshot: &DeploymentSnapshot) -> anyhow::Result<()> {
        let dir = self.project_dir(project)?;
        let mut temp = tempfile::NamedTempFile::new_in(&dir)?;
        serde_json::to_writer(&mut temp, snapshot)?;
        temp.flush()?;
        temp.as_file().sync_all()?;
        temp.persist(dir.join("state.json"))?;
        Ok(())
    }

    fn artifact(&self, project: &str, deploy_id: &str) -> anyhow::Result<Option<PathBuf>> {
        anyhow::ensure!(valid_deploy_id(deploy_id), "invalid deployment identifier");
        let deployment = self.project_dir(project)?.join(deploy_id);
        let output = deployment.join("output");
        for dir in [&deployment, &output] {
            match fs::symlink_metadata(dir) {
                Ok(meta) => anyhow::ensure!(meta.is_dir(), "invalid stored artifact directory"),
                Err(e) if e.kind() == ErrorKind::NotFound => return Ok(None),
                Err(e) => return Err(e.into()),
            }
        }
        Ok(Some(output))
    }

    pub fn active_output(&self, project: &str) -> anyhow::Result<Option<PathBuf>> {
        match self.read(project)?.active {
            Some(id) => self.artifact(project, &id),
            None => Ok(None),
        }
    }

    /// The active deployment id and its immutable output directory, if any.
    /// The id is content-addressed, so a caller may safely key caches on it.
    pub fn active(&self, project: &str) -> anyhow::Result<Option<(String, PathBuf)>> {
        match self.read(project)?.active {
            Some(id) => Ok(self.artifact(project, &id)?.map(|output| (id, output))),
            None => Ok(None),
        }
    }

    pub fn rollback(&self, project: &str, deploy_id: &str) -> anyhow::Result<Option<DeployRecord>> {
        anyhow::ensure!(valid_deploy_id(deploy_id), "invalid deployment identifier");
        let _guard = self
            .writers
            .lock()
            .map_err(|_| anyhow::anyhow!("deployment store unavailable"))?;
        let mut snapshot = self.read(project)?;
        let Some(record) = snapshot
            .history
            .iter()
            .find(|r| r.deploy_id == deploy_id)
            .cloned()
        else {
            return Ok(None);
        };
        let Some(output) = self.artifact(project, deploy_id)? else {
            return Ok(None);
        };
        validate_output(&output)?;
        snapshot.active = Some(record.deploy_id.clone());
        self.replace(project, &snapshot)?;
        Ok(Some(record))
    }
}

fn require_dir(path: &Path, message: &str) -> anyhow::Result<()> {
    anyhow::ensure!(
        fs::symlink_metadata(path).is_ok_and(|m| m.is_dir()),
        "{message}"
    );
    Ok(())
}

fn validate_output(output: &Path) -> anyhow::Result<()> {
    require_dir(
        &output.join("static"),
        "static preview requires an output/static directory",
    )?;
    match fs::symlink_metadata(output.join("functions")) {
        Err(e) if e.kind() == ErrorKind::NotFound => (),
        Err(e) => return Err(e.into()),
        Ok(_) => anyhow::bail!("function runtimes are not supported in static preview"),
    }
    let table = RouteTable::compile(output.to_owned())?;
    anyhow::ensure!(
        table.config.crons.is_empty(),
        "scheduled jobs are not supported in static preview"
    );
    Ok(())
}

pub fn promote(
    store: &DeploymentStore,
    mut record: DeployRecord,
    checkout: &tempfile::TempDir,
    preset_output: &str,
) -> anyhow::Result<String> {
    let project_dir = store.project_dir(&record.project)?;
    fs::create_dir_all(&project_dir)?;
    let stage = tempfile::tempdir_in(&project_dir)?;
    let output = stage.path().join("output");
    let source = checkout.path();
    let configured = source.join(".mobilecloud");
    let explicit = match fs::symlink_metadata(&configured) {
        Ok(meta) => {
            anyhow::ensure!(meta.is_dir(), ".mobilecloud must be a real directory");
            let path = configured.join("output");
            match fs::symlink_metadata(&path) {
                Ok(meta) => {
                    anyhow::ensure!(meta.is_dir(), "output must be a real directory");
                    Some(path)
                }
                Err(e) if e.kind() == ErrorKind::NotFound => None,
                Err(e) => return Err(e.into()),
            }
        }
        Err(e) if e.kind() == ErrorKind::NotFound => None,
        Err(e) => return Err(e.into()),
    };
    let mut hasher = Sha256::new();
    frame(&mut hasher, b"mobilecloud static artifact v1");
    frame(&mut hasher, record.project.as_bytes());
    if let Some(explicit) = explicit {
        package(&explicit, &output, "", &mut hasher)?;
    } else {
        // Do not expose a whole checkout (including .git and build inputs).
        anyhow::ensure!(
            preset_output == "dist",
            "static source must provide .mobilecloud/output/static or a supported dist build"
        );
        let dist = source.join("dist");
        require_dir(&dist, "static build did not produce a dist directory")?;
        fs::create_dir(&output)?;
        hasher.update(b"D");
        frame(&mut hasher, b"");
        package(&dist, &output.join("static"), "static", &mut hasher)?;
    }
    validate_output(&output)?;
    record.deploy_id = format!("dpl_{}", hex::encode(&hasher.finalize()[..12]));

    let _guard = store
        .writers
        .lock()
        .map_err(|_| anyhow::anyhow!("deployment store unavailable"))?;
    let mut snapshot = store.read(&record.project)?;
    let deploy_id = record.deploy_id.clone();
    let project = record.project.clone();
    if store.artifact(&project, &deploy_id)?.is_none() {
        fs::rename(stage.path(), project_dir.join(&deploy_id))?;
    }
    // Do not write through an already published deployment directory. Rebuilds
    // of identical bytes replace metadata once, not the artifact itself.
    snapshot.history.retain(|r| r.deploy_id != deploy_id);
    snapshot.history.push(record);
    snapshot.active = Some(deploy_id.clone());
    store.replace(&project, &snapshot)?;
    Ok(deploy_id)
}

fn frame(hasher: &mut Sha256, data: &[u8]) {
    hasher.update((data.len() as u64).to_be_bytes());
    hasher.update(data);
}

fn package(source: &Path, dest: &Path, relative: &str, hasher: &mut Sha256) -> anyhow::Result<()> {
    let meta = fs::symlink_metadata(source)?;
    if meta.is_dir() {
        hasher.update(b"D");
        frame(hasher, relative.as_bytes());
        fs::create_dir(dest)?;
        let mut entries = fs::read_dir(source)?.collect::<Result<Vec<_>, _>>()?;
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            let name = entry.file_name();
            let name = name
                .to_str()
                .ok_or_else(|| anyhow::anyhow!("non-UTF-8 artifact filename"))?;
            let path = if relative.is_empty() {
                name.to_owned()
            } else {
                format!("{relative}/{name}")
            };
            package(&entry.path(), &dest.join(name), &path, hasher)?;
        }
    } else if meta.is_file() {
        anyhow::ensure!(
            meta.len() <= MAX_STATIC_FILE,
            "preview artifact file exceeds size limit"
        );
        hasher.update(b"F");
        frame(hasher, relative.as_bytes());
        // Frame the file by its declared length, then hash and copy it in
        // bounded chunks so a 16 MiB asset never sits fully in memory.
        hasher.update(meta.len().to_be_bytes());
        let mut source_file = File::open(source)?;
        let mut dest_file = File::create_new(dest)?;
        let mut buffer = [0u8; 64 * 1024];
        let mut total: u64 = 0;
        loop {
            let read = source_file.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            total += read as u64;
            anyhow::ensure!(
                total <= MAX_STATIC_FILE,
                "preview artifact file exceeds size limit"
            );
            hasher.update(&buffer[..read]);
            dest_file.write_all(&buffer[..read])?;
        }
        // A short or long read means the source changed mid-packaging; refuse
        // rather than publish an artifact whose hash omits bytes.
        anyhow::ensure!(
            total == meta.len(),
            "preview artifact file changed while packaging"
        );
    } else {
        anyhow::bail!("preview artifacts must not contain symlinks or special files");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn build(store: &DeploymentStore, project: &str, html: &str) -> String {
        let checkout = tempfile::tempdir().unwrap();
        fs::create_dir(checkout.path().join("dist")).unwrap();
        fs::write(checkout.path().join("dist/index.html"), html).unwrap();
        promote(
            store,
            DeployRecord {
                project: project.into(),
                deploy_id: String::new(),
                commit: "commit".into(),
                branch: "main".into(),
                framework: "static".into(),
                built_at: 1,
                ttfb_hint_ms: None,
                trigger_source: Some("test".into()),
            },
            &checkout,
            "dist",
        )
        .unwrap()
    }

    #[test]
    fn promotion_and_rollback_share_durable_active_state() {
        let dir = tempfile::tempdir().unwrap();
        let store = DeploymentStore::new(dir.path().into());
        let first = build(&store, "one", "one v1");
        let second = build(&store, "one", "one v2");
        let other = build(&store, "two", "one v1");
        assert_ne!(first, other);
        assert!(store.rollback("one", &other).unwrap().is_none());
        assert_eq!(
            store.read("one").unwrap().active.as_deref(),
            Some(second.as_str())
        );
        assert_eq!(build(&store, "one", "one v2"), second);
        assert_eq!(store.read("one").unwrap().history.len(), 2);
        assert!(store.rollback("one", &first).unwrap().is_some());
        let restarted = DeploymentStore::new(dir.path().into());
        assert_eq!(
            fs::read_to_string(
                restarted
                    .active_output("one")
                    .unwrap()
                    .unwrap()
                    .join("static/index.html")
            )
            .unwrap(),
            "one v1"
        );
        fs::remove_dir_all(dir.path().join("one").join(&second)).unwrap();
        assert!(store.rollback("one", &second).unwrap().is_none());
        assert_eq!(
            restarted.read("one").unwrap().active.as_deref(),
            Some(first.as_str())
        );
    }

    #[test]
    fn rejected_dynamic_output_does_not_replace_live_static_artifact() {
        let dir = tempfile::tempdir().unwrap();
        let store = DeploymentStore::new(dir.path().into());
        let active = build(&store, "preview", "working preview");
        let record = store.read("preview").unwrap().history.pop().unwrap();
        let checkout = tempfile::tempdir().unwrap();
        let explicit = checkout.path().join(".mobilecloud/output");
        fs::create_dir_all(explicit.join("static")).unwrap();
        fs::create_dir(explicit.join("functions")).unwrap();
        assert!(promote(&store, record, &checkout, "dist").is_err());
        let snapshot = store.read("preview").unwrap();
        assert_eq!(snapshot.active.as_deref(), Some(active.as_str()));
        assert_eq!(snapshot.history.len(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn publishing_does_not_follow_artifact_links() {
        let stage = tempfile::tempdir().unwrap();
        let external = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(external.path(), stage.path().join("link")).unwrap();
        assert!(package(
            stage.path(),
            &external.path().join("output"),
            "",
            &mut Sha256::new()
        )
        .is_err());
    }
}
