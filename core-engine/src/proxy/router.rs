//! Static subset of Build Output API v3; never forks deployment code.

use std::collections::HashMap;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use axum::body::Body;
use axum::http::{header, HeaderMap, HeaderName, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;

use crate::{builder::atomic_promoter::MAX_STATIC_FILE, AppState};

#[derive(Debug, thiserror::Error)]
pub enum RouterError {
    #[error("no live deployment for project")]
    NoDeployment,
    #[error("invalid static route configuration")]
    InvalidConfig,
    #[error("deployment store unavailable")]
    Store(#[source] anyhow::Error),
    #[error("static request task failed")]
    Task(#[from] tokio::task::JoinError),
    #[error("io error")]
    Io(#[from] std::io::Error),
}

#[derive(Debug, Deserialize)]
pub struct BuildOutputConfig {
    version: u32,
    #[serde(default)]
    routes: Vec<RouteRule>,
    #[serde(default)]
    overrides: HashMap<String, OverrideRule>,
    #[serde(default)]
    pub crons: Vec<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
struct RouteRule {
    src: Option<String>,
    dest: Option<String>,
    status: Option<u16>,
    headers: Option<HashMap<String, String>>,
    methods: Option<Vec<String>>,
    #[serde(default, rename = "continue")]
    continue_: bool,
    handle: Option<String>,
    #[serde(default)]
    check: bool,
}

#[derive(Debug, Deserialize)]
struct OverrideRule {
    #[serde(rename = "contentType", alias = "content_type")]
    content_type: Option<String>,
}

pub struct RouteTable {
    output: PathBuf,
    pub config: BuildOutputConfig,
    compiled: Vec<Option<regex::Regex>>,
}

impl RouteTable {
    pub fn compile(output: PathBuf) -> Result<Self, RouterError> {
        const CONFIG_LIMIT: u64 = 256 * 1024;
        let path = output.join("config.json");
        let config: BuildOutputConfig = match std::fs::symlink_metadata(&path) {
            Ok(meta) if meta.is_file() && meta.len() <= CONFIG_LIMIT => {
                let mut raw = Vec::new();
                std::fs::File::open(path)?
                    .take(CONFIG_LIMIT + 1)
                    .read_to_end(&mut raw)?;
                if raw.len() as u64 > CONFIG_LIMIT {
                    return Err(RouterError::InvalidConfig);
                }
                serde_json::from_slice(&raw).map_err(|_| RouterError::InvalidConfig)?
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => BuildOutputConfig {
                version: 3,
                routes: Vec::new(),
                overrides: HashMap::new(),
                crons: Vec::new(),
            },
            Err(e) => return Err(e.into()),
            _ => return Err(RouterError::InvalidConfig),
        };
        if config.version != 3 || config.routes.len() > 128 {
            return Err(RouterError::InvalidConfig);
        }
        let compiled = config
            .routes
            .iter()
            .map(|rule| {
                rule.src
                    .as_ref()
                    .map(|src| regex::RegexBuilder::new(src).size_limit(64 * 1024).build())
                    .transpose()
                    .map_err(|_| RouterError::InvalidConfig)
            })
            .collect::<Result<_, _>>()?;
        Ok(Self {
            output,
            config,
            compiled,
        })
    }
}

pub async fn route_request(
    state: &Arc<AppState>,
    project: &str,
    request: axum::extract::Request<Body>,
    permit: tokio::sync::OwnedSemaphorePermit,
) -> Result<Response, RouterError> {
    // Deployment routing never consumes request bodies or forwards request
    // headers to a process. Disk I/O runs off the async request executor.
    let method = request.method().clone();
    let path = request.uri().path().to_owned();
    let encoding = request
        .headers()
        .get(header::ACCEPT_ENCODING)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_owned();
    drop(request);
    let state = state.clone();
    let project = project.to_owned();
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let (deploy_id, output) = state
            .deployments
            .active(&project)
            .map_err(RouterError::Store)?
            .ok_or(RouterError::NoDeployment)?;
        // The active id is content-addressed, so the compiled table can be
        // reused until the deployment changes instead of on every request.
        let table = state.route_table(&project, &deploy_id, output)?;
        dispatch(&table, method, path, &encoding)
    })
    .await?
}

fn dispatch(
    table: &RouteTable,
    method: Method,
    mut path: String,
    encoding: &str,
) -> Result<Response, RouterError> {
    let mut stacked = HeaderMap::new();
    for (regex, rule) in table.compiled.iter().zip(&table.config.routes) {
        if rule.methods.as_ref().is_some_and(|methods| {
            !methods.is_empty()
                && !methods
                    .iter()
                    .any(|m| m.eq_ignore_ascii_case(method.as_str()))
        }) {
            continue;
        }
        if rule.handle.as_deref() == Some("filesystem") {
            if let Some(response) = serve_destination(table, &path, &method, encoding)? {
                return Ok(with_route_headers(response, &stacked));
            }
            continue;
        }
        let Some(caps) = regex.as_ref().and_then(|re| re.captures(&path)) else {
            continue;
        };
        if let Some(headers) = &rule.headers {
            for (key, value) in headers {
                if let (Ok(name), Ok(value)) = (
                    HeaderName::try_from(key.as_str()),
                    HeaderValue::from_str(value),
                ) {
                    stacked.insert(name, value);
                }
            }
        }
        let dest = rule.dest.as_ref().map(|dest| expand_dest(dest, &caps));
        if let Some(status @ 300..=399) = rule.status {
            let response = Response::builder()
                .status(status)
                .header(header::LOCATION, dest.as_deref().unwrap_or(&path))
                .body(Body::empty())
                .map_err(|_| RouterError::InvalidConfig)?;
            return Ok(with_route_headers(response, &stacked));
        }
        if let Some(dest) = dest {
            if rule.continue_ {
                path = dest;
            } else if let Some(response) = serve_destination(table, &dest, &method, encoding)? {
                return Ok(with_route_headers(response, &stacked));
            } else if !rule.check {
                return Ok(with_route_headers(
                    StatusCode::NOT_FOUND.into_response(),
                    &stacked,
                ));
            }
        }
    }
    let response = serve_destination(table, &path, &method, encoding)?
        .unwrap_or_else(|| StatusCode::NOT_FOUND.into_response());
    Ok(with_route_headers(response, &stacked))
}

fn with_route_headers(mut response: Response, stacked: &HeaderMap) -> Response {
    for (name, value) in stacked {
        if !matches!(
            name.as_str(),
            "content-length"
                | "content-encoding"
                | "transfer-encoding"
                | "connection"
                | "upgrade"
                | "vary"
                | "set-cookie"
                | "cache-control"
        ) {
            response.headers_mut().insert(name, value.clone());
        }
    }
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

fn expand_dest(dest: &str, caps: &regex::Captures<'_>) -> String {
    let mut out = String::new();
    let mut chars = dest.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '$' {
            if let Some(index) = chars.peek().and_then(|c| c.to_digit(10)) {
                chars.next();
                if let Some(value) = caps.get(index as usize) {
                    out.push_str(value.as_str());
                }
                continue;
            }
        }
        out.push(ch);
    }
    out
}

fn serve_destination(
    table: &RouteTable,
    path: &str,
    method: &Method,
    encoding: &str,
) -> Result<Option<Response>, RouterError> {
    let path = path.split('?').next().unwrap_or(path);
    // A rewrite may be repository-controlled. It must still be a local path.
    let Some(relative) = path.strip_prefix('/') else {
        return Ok(None);
    };
    if relative.starts_with('/')
        || relative.contains(['\\', ':'])
        || relative.split('/').any(|part| part == "." || part == "..")
        || !Path::new(relative)
            .components()
            .all(|part| matches!(part, Component::Normal(_)))
    {
        return Ok(None);
    }
    if *method == Method::GET || *method == Method::HEAD {
        let root = table.output.join("static");
        let relative = if relative.is_empty() {
            "index.html"
        } else {
            relative
        };
        let candidate = root.join(relative);
        if std::fs::symlink_metadata(&root).is_ok_and(|meta| meta.is_dir()) {
            if let Ok(root_canonical) = root.canonicalize() {
                if let Ok(file) = candidate.canonicalize() {
                    let meta = std::fs::metadata(&file)?;
                    if file.starts_with(&root_canonical) && meta.is_file() {
                        if meta.len() > MAX_STATIC_FILE {
                            return Ok(Some(StatusCode::PAYLOAD_TOO_LARGE.into_response()));
                        }
                        let mime = table
                            .config
                            .overrides
                            .get(relative)
                            .and_then(|rule| rule.content_type.as_deref())
                            .unwrap_or_else(|| mime_for(&file));
                        // Prefer a build-time precompressed sidecar when the
                        // client accepts it, avoiding repeat compression work.
                        if let Some((bytes, used)) =
                            sidecar_bytes(&file, &root_canonical, encoding)?
                        {
                            return Ok(Some(sidecar_response(mime, bytes, used, method)?));
                        }
                        let mut bytes = Vec::new();
                        std::fs::File::open(&file)?
                            .take(MAX_STATIC_FILE + 1)
                            .read_to_end(&mut bytes)?;
                        if bytes.len() as u64 > MAX_STATIC_FILE {
                            return Ok(Some(StatusCode::PAYLOAD_TOO_LARGE.into_response()));
                        }
                        let (bytes, used) =
                            super::compression::compress_if_worthwhile(&bytes, encoding, mime);
                        let mut builder = Response::builder()
                            .header(header::CONTENT_TYPE, mime)
                            .header(header::CONTENT_LENGTH, bytes.len())
                            .header(header::VARY, "Accept-Encoding");
                        if let Some(used) = used {
                            builder = builder.header(header::CONTENT_ENCODING, used);
                        }
                        return Ok(Some(
                            builder
                                .body(if *method == Method::HEAD {
                                    Body::empty()
                                } else {
                                    Body::from(bytes)
                                })
                                .map_err(|_| RouterError::InvalidConfig)?,
                        ));
                    }
                }
            }
        }
    }
    // Defensive response for any manually retained legacy function artifact.
    let functions = table.output.join("functions");
    if !relative.is_empty()
        && functions
            .join(format!("{}.func", relative.trim_end_matches('/')))
            .is_dir()
    {
        return Ok(Some(
            (
                StatusCode::NOT_IMPLEMENTED,
                "function runtimes are not supported",
            )
                .into_response(),
        ));
    }
    Ok(None)
}

/// Read a build-time precompressed sidecar (`<file>.br` / `<file>.gz`) for
/// `file` when the client accepts that encoding. The sidecar must resolve to a
/// regular file inside the artifact root, so a repository cannot point it at a
/// file outside the artifact.
fn sidecar_bytes(
    file: &Path,
    root: &Path,
    encoding: &str,
) -> Result<Option<(Vec<u8>, &'static str)>, RouterError> {
    let Some(used) = super::compression::sidecar_encoding(encoding) else {
        return Ok(None);
    };
    let mut name = file.as_os_str().to_owned();
    name.push(if used == "br" { ".br" } else { ".gz" });
    let Ok(real) = PathBuf::from(name).canonicalize() else {
        return Ok(None);
    };
    if !real.starts_with(root) {
        return Ok(None);
    }
    let meta = std::fs::metadata(&real)?;
    if !meta.is_file() || meta.len() > MAX_STATIC_FILE {
        return Ok(None);
    }
    let mut bytes = Vec::new();
    std::fs::File::open(&real)?
        .take(MAX_STATIC_FILE + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_STATIC_FILE {
        return Ok(None);
    }
    Ok(Some((bytes, used)))
}

fn sidecar_response(
    mime: &str,
    bytes: Vec<u8>,
    used: &'static str,
    method: &Method,
) -> Result<Response, RouterError> {
    Response::builder()
        .header(header::CONTENT_TYPE, mime)
        .header(header::CONTENT_ENCODING, used)
        .header(header::CONTENT_LENGTH, bytes.len())
        .header(header::VARY, "Accept-Encoding")
        .body(if *method == Method::HEAD {
            Body::empty()
        } else {
            Body::from(bytes)
        })
        .map_err(|_| RouterError::InvalidConfig)
}

fn mime_for(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "html" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "json" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "wasm" => "application/wasm",
        "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn static_routes_and_unsupported_functions_do_not_spawn_code() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(root.path().join("functions/ssr.func")).unwrap();
        std::fs::create_dir(root.path().join("static")).unwrap();
        std::fs::write(root.path().join("static/index.html"), "preview").unwrap();
        std::fs::write(
            root.path().join("config.json"),
            r#"{"version":3,"routes":[
            {"src":"^/preview$","dest":"/index.html"},{"src":"^/dynamic$","dest":"/ssr"}
        ]}"#,
        )
        .unwrap();
        let table = RouteTable::compile(root.path().into()).unwrap();
        let head = dispatch(&table, Method::HEAD, "/preview".into(), "identity").unwrap();
        assert_eq!(head.status(), StatusCode::OK);
        assert_eq!(head.headers()[header::CONTENT_LENGTH], "7");
        assert_eq!(
            dispatch(&table, Method::POST, "/dynamic".into(), "identity")
                .unwrap()
                .status(),
            StatusCode::NOT_IMPLEMENTED
        );
    }

    #[test]
    fn serves_precompressed_sidecar_when_client_accepts_it() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("static")).unwrap();
        std::fs::write(root.path().join("static/app.js"), "console.log('hi');").unwrap();
        std::fs::write(root.path().join("static/app.js.br"), "BROTLI-BYTES").unwrap();
        let table = RouteTable::compile(root.path().into()).unwrap();

        let brotli = dispatch(&table, Method::GET, "/app.js".into(), "br").unwrap();
        assert_eq!(brotli.status(), StatusCode::OK);
        assert_eq!(brotli.headers()[header::CONTENT_ENCODING], "br");
        assert_eq!(brotli.headers()[header::CONTENT_LENGTH], "12");
        assert_eq!(
            brotli.headers()[header::CONTENT_TYPE],
            "text/javascript; charset=utf-8"
        );

        // A client without brotli support receives the raw file unchanged.
        let raw = dispatch(&table, Method::GET, "/app.js".into(), "identity").unwrap();
        assert!(raw.headers().get(header::CONTENT_ENCODING).is_none());
        assert_eq!(raw.headers()[header::CONTENT_LENGTH], "18");
    }

    #[cfg(unix)]
    #[test]
    fn ignores_sidecar_that_escapes_the_artifact_root() {
        let root = tempfile::tempdir().unwrap();
        let external = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("static")).unwrap();
        std::fs::write(root.path().join("static/app.js"), "small").unwrap();
        std::fs::write(external.path().join("evil.br"), "outside-content").unwrap();
        std::os::unix::fs::symlink(
            external.path().join("evil.br"),
            root.path().join("static/app.js.br"),
        )
        .unwrap();
        let table = RouteTable::compile(root.path().into()).unwrap();
        let response = dispatch(&table, Method::GET, "/app.js".into(), "br").unwrap();
        assert!(
            response.headers().get(header::CONTENT_ENCODING).is_none(),
            "a sidecar resolving outside the artifact root must be ignored"
        );
    }
}
