//! POSIX atomic symlink promotion (`ln -sfn` semantics, < 15 ms rollback —
//! research report §8.3).
//!
//! Promoting a build is a **single atomic filesystem operation**: write a
//! temporary symlink then `rename()` it over the `live/<project>` pointer.
//! Readers never observe a missing or half-written target, and rollback to
//! any previous immutable deployment is the identical 15-millisecond swap
//! with zero recompilation and zero network fetch.

use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::builder::DeploymentStore;
use crate::AppState;

/// Validate the Build Output API v3 contract of a build output directory
/// (research report §3.1: `config.json`, `static/`, `functions/`).
pub fn validate_output(output_dir: &Path) -> anyhow::Result<()> {
    if !output_dir.exists() {
        anyhow::bail!("build output missing: {}", output_dir.display());
    }
    let has_static = output_dir.join("static").is_dir();
    let has_functions = output_dir.join("functions").is_dir();
    let has_config = output_dir.join("config.json").is_file();
    if !has_static && !has_functions {
        anyhow::bail!(
            "invalid Build Output v3: need static/ or functions/ in {}",
            output_dir.display()
        );
    }
    if !has_config {
        // Legal but rare; the router synthesizes an empty table.
        tracing::warn!("deployment output has no config.json — static-only serving");
    }
    Ok(())
}

/// Package the validated output into the content-addressed store and swap
/// the live pointer. Returns the generated `dpl_…` deployment id.
pub fn promote(
    state: &std::sync::Arc<AppState>,
    project: &str,
    output_dir: &Path,
) -> anyhow::Result<String> {
    validate_output(output_dir)?;

    // Immutable deployment id: sha256(project || content fingerprint) —
    // identical builds deduplicate to the same id.
    let fingerprint = fingerprint_tree(output_dir)?;
    let deploy_id = format!("dpl_{}", hex::encode(&fingerprint[..12]));

    let target = state
        .home
        .join("deployments")
        .join(project)
        .join(&deploy_id)
        .join("output");
    std::fs::create_dir_all(&target)?;
    copy_tree(output_dir, &target)?;

    // Atomic promotion: temp symlink → rename over live pointer.
    atomic_swap(state, project, &deploy_id)?;

    state.deployments.record(crate::builder::DeployRecord {
        project: project.to_string(),
        deploy_id: deploy_id.clone(),
        commit: String::new(),
        branch: String::new(),
        framework: String::new(),
        built_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
        ttfb_hint_ms: None,
        trigger_source: None,
    });
    Ok(deploy_id)
}

/// One-shot rollback to a previously recorded deployment (< 15 ms).
pub fn rollback(
    state: &std::sync::Arc<AppState>,
    project: &str,
    deploy_id: &str,
) -> anyhow::Result<crate::builder::DeployRecord> {
    let started = std::time::Instant::now();
    let record = state
        .deployments
        .rollback(project, deploy_id)
        .ok_or_else(|| anyhow::anyhow!("unknown deployment {deploy_id} for {project}"))?;
    let target = state
        .home
        .join("deployments")
        .join(project)
        .join(deploy_id)
        .join("output");
    if !target.exists() {
        anyhow::bail!("deployment artifact {deploy_id} no longer stored");
    }
    atomic_swap(state, project, deploy_id)?;
    tracing::info!(
        "rollback of {project} → {deploy_id} completed in {:.2}ms",
        started.elapsed().as_secs_f64() * 1000.0
    );
    Ok(record)
}

/// The atomic swap itself: `symlink(temp) → rename(temp, live)`.
/// `rename` over an existing symlink is POSIX-atomic.
pub fn atomic_swap(state: &std::sync::Arc<AppState>, project: &str, deploy_id: &str) -> anyhow::Result<()> {
    let live_dir = state.home.join("live");
    std::fs::create_dir_all(&live_dir)?;
    let live = live_dir.join(project);
    let temp = live_dir.join(format!(
        ".{project}.{}.tmp",
        std::process::id()
    ));
    // Relative target keeps the symlink valid when `home` moves (AVF mounts).
    let relative_target = PathBuf::from("..")
        .join("deployments")
        .join(project)
        .join(deploy_id)
        .join("output");
    let _ = std::fs::remove_file(&temp);
    #[cfg(unix)]
    std::os::unix::fs::symlink(&relative_target, &temp)?;
    #[cfg(not(unix))]
    std::fs::write(&temp, &relative_target.to_string_lossy().as_bytes())?;
    std::fs::rename(&temp, &live)?;
    Ok(())
}

/// Deterministic tree fingerprint (stable ordering; metadata-free).
fn fingerprint_tree(root: &Path) -> anyhow::Result<[u8; 32]> {
    let mut hasher = Sha256::new();
    let mut paths: Vec<PathBuf> = Vec::new();
    collect(root, root, &mut paths)?;
    paths.sort();
    for path in paths {
        let relative = path.strip_prefix(root)?.to_string_lossy();
        hasher.update(relative.as_bytes());
        let meta = std::fs::metadata(&path)?;
        if meta.is_file() {
            let bytes = std::fs::read(&path)?;
            hasher.update(&bytes);
        }
    }
    let mut out = [0u8; 32];
    out.copy_from_slice(&hasher.finalize());
    Ok(out)
}

fn collect(root: &Path, dir: &Path, out: &mut Vec<PathBuf>) -> anyhow::Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() {
            collect(root, &path, out)?;
        } else {
            out.push(path);
        }
    }
    Ok(())
}

/// Recursive copy preserving the Build Output v3 layout.
fn copy_tree(source: &Path, destination: &Path) -> anyhow::Result<()> {
    std::fs::create_dir_all(destination)?;
    for entry in std::fs::read_dir(source)? {
        let entry = entry?;
        let from = entry.path();
        let to = destination.join(entry.file_name());
        if from.is_dir() {
            copy_tree(&from, &to)?;
        } else {
            std::fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_output_without_static_or_functions() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("config.json"), "{}").unwrap();
        assert!(validate_output(dir.path()).is_err());
    }

    #[test]
    fn accepts_static_only_output() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("static")).unwrap();
        std::fs::write(dir.path().join("static/index.html"), "<html/>").unwrap();
        assert!(validate_output(dir.path()).is_ok());
    }

    #[test]
    fn fingerprint_is_order_stable() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("static")).unwrap();
        std::fs::write(dir.path().join("static/a.txt"), "a").unwrap();
        std::fs::write(dir.path().join("static/b.txt"), "b").unwrap();
        let a = fingerprint_tree(dir.path()).unwrap();
        let b = fingerprint_tree(dir.path()).unwrap();
        assert_eq!(a, b);
    }
}
