//! File transfer for the browser CloudShell (AWS CloudShell parity).
//!
//! The browser needs to move files between the phone's filesystem and the
//! operator's machine. Two designs were rejected:
//!
//! * base64 framing over the terminal WebSocket — it burns a third of the
//!   bandwidth and interleaves with shell output;
//! * a general "any path on the device" endpoint — that is a remote shell
//!   with a download button attached.
//!
//! Instead the transfer API is confined to the engine home directory, the
//! same tree the terminal session runs in. A path that resolves outside the
//! home is refused, symlinks included, so the endpoint cannot be used to read
//! `/data/data/com.mobilecloud/...` or another app's sandbox.

use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::time::UNIX_EPOCH;

use axum::{
    body::Body,
    extract::{Query, Request, State},
    http::{header, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
};
use serde::Deserialize;

use crate::AppState;

/// Largest file that can be uploaded or downloaded in one request.
pub const MAX_TRANSFER_BYTES: usize = 64 * 1024 * 1024;

/// Resolve a caller-supplied path inside the engine home directory.
///
/// Returns `None` when the path escapes the home, when it contains a
/// traversal component, or when it points at a symlink that leaves the home.
pub fn resolve_in_home(home: &Path, requested: &str) -> Option<PathBuf> {
    let requested = requested.trim();
    // Only a path is accepted, never a URL or a device node.
    if requested.contains('\0') {
        return None;
    }
    let relative = requested
        .strip_prefix("~/")
        .unwrap_or(requested.strip_prefix('~').unwrap_or(requested))
        .trim_start_matches('/');
    if relative.is_empty() {
        // An empty path means the workspace root.
        return home.canonicalize().ok();
    }
    // Reject traversal in the raw form; the canonical check below is the real
    // guard, this one keeps obviously hostile input out of the filesystem.
    if relative
        .split('/')
        .any(|part| part == ".." || part.chars().any(|c| c == '\\'))
    {
        return None;
    }
    let candidate = home.join(relative);
    let canonical_home = home.canonicalize().ok()?;
    let resolved = match candidate.canonicalize() {
        Ok(resolved) => resolved,
        // The file may not exist yet (an upload target). Canonicalize the
        // parent instead and re-attach the file name.
        Err(_) => {
            let parent = candidate.parent()?;
            let name = candidate.file_name()?;
            if name.is_empty() {
                return None;
            }
            parent.canonicalize().ok()?.join(name)
        }
    };
    if !resolved.starts_with(&canonical_home) {
        return None;
    }
    // Walk the path components to be sure nothing tries to escape via a
    // symlinked directory that canonicalize already resolved.
    let mut walked = canonical_home.clone();
    for component in relative.split('/') {
        if component.is_empty() || component == "." {
            continue;
        }
        walked.push(component);
        if let Ok(meta) = std::fs::symlink_metadata(&walked) {
            if meta.file_type().is_symlink() {
                let target = std::fs::canonicalize(&walked).ok()?;
                if !target.starts_with(&canonical_home) {
                    return None;
                }
            }
        }
    }
    Some(resolved)
}

/// Query parameters shared by the transfer endpoints.
#[derive(Deserialize)]
pub struct TransferQuery {
    #[serde(default)]
    pub path: String,
}

/// `GET /api/v1/terminal/files?path=<dir>` — list a directory.
pub async fn list_files(
    State(state): State<Arc<AppState>>,
    Query(query): Query<TransferQuery>,
) -> Response {
    let Some(dir) = resolve_in_home(&state.home, &query.path) else {
        return (StatusCode::BAD_REQUEST, "path is outside the workspace").into_response();
    };
    let entries = match std::fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(error) => {
            let status = match error.kind() {
                std::io::ErrorKind::NotFound => StatusCode::NOT_FOUND,
                std::io::ErrorKind::PermissionDenied => StatusCode::FORBIDDEN,
                _ => StatusCode::BAD_REQUEST,
            };
            return (status, "directory is not readable").into_response();
        }
    };

    let mut items = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') && name != ".cloudshell" {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        let modified = meta
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        items.push(serde_json::json!({
            "name": name,
            "directory": meta.is_dir(),
            "size": if meta.is_dir() { 0 } else { meta.len() },
            "modified": modified,
        }));
    }
    items.sort_by(|a, b| {
        let dir_a = a["directory"].as_bool().unwrap_or(false);
        let dir_b = b["directory"].as_bool().unwrap_or(false);
        let name_a = a["name"].as_str().unwrap_or("");
        let name_b = b["name"].as_str().unwrap_or("");
        dir_b
            .cmp(&dir_a)
            .then_with(|| name_a.to_lowercase().cmp(&name_b.to_lowercase()))
    });

    let parent = dir
        .parent()
        .and_then(|p| p.strip_prefix(state.home.canonicalize().ok()?).ok())
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();

    (
        [(header::CACHE_CONTROL, "no-store")],
        axum::Json(serde_json::json!({
            "path": query.path,
            "parent": parent,
            "entries": items,
        })),
    )
        .into_response()
}

/// `POST /api/v1/terminal/upload?path=<file>` — store the request body.
///
/// The body is written to a sibling temporary file and renamed into place,
/// so an interrupted upload never leaves a half-written file behind.
pub async fn upload_file(
    State(state): State<Arc<AppState>>,
    Query(query): Query<TransferQuery>,
    request: Request<Body>,
) -> Response {
    let Some(target) = resolve_in_home(&state.home, &query.path) else {
        return (StatusCode::BAD_REQUEST, "path is outside the workspace").into_response();
    };
    if target.is_dir() {
        return (StatusCode::BAD_REQUEST, "target is a directory").into_response();
    }
    let bytes = match axum::body::to_bytes(request.into_body(), MAX_TRANSFER_BYTES).await {
        Ok(bytes) => bytes,
        Err(_) => {
            return (
                StatusCode::PAYLOAD_TOO_LARGE,
                "file exceeds the transfer limit",
            )
                .into_response()
        }
    };

    let Some(parent) = target.parent() else {
        return (StatusCode::BAD_REQUEST, "invalid upload path").into_response();
    };
    if std::fs::create_dir_all(parent).is_err() {
        return (StatusCode::FORBIDDEN, "directory is not writable").into_response();
    }

    let temporary = parent.join(format!(
        ".cloudshell-upload-{}-{}",
        std::process::id(),
        bytes.len()
    ));
    if std::fs::write(&temporary, &bytes).is_err() {
        return (StatusCode::FORBIDDEN, "file could not be written").into_response();
    }
    if std::fs::rename(&temporary, &target).is_err() {
        let _ = std::fs::remove_file(&temporary);
        return (StatusCode::FORBIDDEN, "file could not be stored").into_response();
    }

    (
        [(header::CACHE_CONTROL, "no-store")],
        axum::Json(serde_json::json!({
            "ok": true,
            "path": query.path,
            "bytes": bytes.len(),
        })),
    )
        .into_response()
}

/// `GET /api/v1/terminal/download?path=<file>` — read a file back.
pub async fn download_file(
    State(state): State<Arc<AppState>>,
    Query(query): Query<TransferQuery>,
) -> Response {
    let Some(target) = resolve_in_home(&state.home, &query.path) else {
        return (StatusCode::BAD_REQUEST, "path is outside the workspace").into_response();
    };
    let Ok(meta) = std::fs::metadata(&target) else {
        return (StatusCode::NOT_FOUND, "file not found").into_response();
    };
    if meta.is_dir() {
        return (StatusCode::BAD_REQUEST, "target is a directory").into_response();
    }
    if meta.len() > MAX_TRANSFER_BYTES as u64 {
        return (StatusCode::PAYLOAD_TOO_LARGE, "file exceeds the transfer limit").into_response();
    }
    let Ok(bytes) = std::fs::read(&target) else {
        return (StatusCode::FORBIDDEN, "file is not readable").into_response();
    };
    let name = target
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "download".to_owned());
    let disposition = format!("attachment; filename=\"{}\"", name.replace('"', ""));
    let disposition = HeaderValue::from_str(&disposition)
        .unwrap_or_else(|_| HeaderValue::from_static("attachment; filename=download"));

    let mut response = Response::new(Body::from(bytes));
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("application/octet-stream"));
    headers.insert(header::CONTENT_DISPOSITION, disposition);
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

/// `DELETE /api/v1/terminal/file?path=<file>` — remove a file.
pub async fn delete_file(
    State(state): State<Arc<AppState>>,
    Query(query): Query<TransferQuery>,
) -> Response {
    let Some(target) = resolve_in_home(&state.home, &query.path) else {
        return (StatusCode::BAD_REQUEST, "path is outside the workspace").into_response();
    };
    // Never remove the workspace root itself.
    let Ok(canonical_home) = state.home.canonicalize() else {
        return (StatusCode::INTERNAL_SERVER_ERROR, "workspace is unavailable").into_response();
    };
    if target == canonical_home || !is_within(&canonical_home, &target) {
        return (StatusCode::BAD_REQUEST, "refusing to remove the workspace root").into_response();
    }
    if !target.exists() {
        return (StatusCode::NOT_FOUND, "file not found").into_response();
    }
    let result = if target.is_dir() {
        std::fs::remove_dir_all(&target)
    } else {
        std::fs::remove_file(&target)
    };
    match result {
        Ok(()) => (
            [(header::CACHE_CONTROL, "no-store")],
            axum::Json(serde_json::json!({ "ok": true, "path": query.path })),
        )
            .into_response(),
        Err(_) => (StatusCode::FORBIDDEN, "file could not be removed").into_response(),
    }
}

/// `true` when `path` stays inside `root` without relying on `canonicalize`.
///
/// Used for paths that do not exist yet.
pub fn is_within(root: &Path, path: &Path) -> bool {
    if path
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return false;
    }
    path.starts_with(root)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn traversal_outside_the_workspace_is_refused() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(root.path().join("project")).unwrap();
        std::fs::write(root.path().join("project/file.txt"), "hello").unwrap();

        assert!(resolve_in_home(root.path(), "project/file.txt").is_some());
        assert!(resolve_in_home(root.path(), "project").is_some());
        assert!(resolve_in_home(root.path(), "").is_some());

        assert!(resolve_in_home(root.path(), "../../etc/passwd").is_none());
        assert!(resolve_in_home(root.path(), "project/../../etc/passwd").is_none());
        assert!(resolve_in_home(root.path(), "/etc/passwd").is_none());
    }

    #[test]
    #[cfg(unix)]
    fn a_symlink_out_of_the_workspace_is_refused() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret"), "classified").unwrap();

        std::os::unix::fs::symlink(outside.path(), root.path().join("escape")).unwrap();
        assert!(resolve_in_home(root.path(), "escape/secret").is_none());
    }

    #[test]
    fn path_prefix_walk_rejects_escapes() {
        let root = Path::new("/home/operator");
        assert!(is_within(root, Path::new("/home/operator/project")));
        assert!(!is_within(root, Path::new("/home/operator/../etc")));
        assert!(!is_within(root, Path::new("/etc")));
    }
}
