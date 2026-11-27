//! The HTTP surface of the console, as the CLI uses it.
//!
//! Every call goes to `<origin>/api/<path>`. The origin is normalised once, at
//! startup, and never derived from a response: a compromised or redirected
//! server response must not be able to move the client to another host.
//! Plain HTTP is accepted only for a loopback development server.

use std::fmt;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use reqwest::blocking::{Client, RequestBuilder, Response};
use reqwest::Url;
use serde_json::Value;

/// The registered OAuth client id for this binary.
pub const CLIENT_ID: &str = "mobilecloud-cli";
/// Sent on every request so the console can attribute CLI traffic.
pub const USER_AGENT: &str = concat!("mobilecloud-cli/", env!("CARGO_PKG_VERSION"));

/// A failed request: either an error the server described, or a transport
/// failure (status 0, code `network`).
#[derive(Debug)]
pub struct ApiError {
    pub status: u16,
    pub code: String,
    pub message: String,
}

impl ApiError {
    pub fn new(status: u16, code: impl Into<String>, message: impl Into<String>) -> Self {
        Self { status, code: code.into(), message: message.into() }
    }
}

impl fmt::Display for ApiError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for ApiError {}

impl From<reqwest::Error> for ApiError {
    fn from(error: reqwest::Error) -> Self {
        Self::new(0, "network", format!("Could not reach the server: {error}"))
    }
}

/// A client bound to one console origin.
pub struct Api {
    origin: String,
    http: Client,
}

impl Api {
    /// Builds a client for `server`, rejecting anything that is not a bare
    /// HTTPS origin (or a loopback HTTP origin for development).
    pub fn connect(server: &str) -> Result<Self> {
        let origin = normalize_server(server)?;
        let http = Client::builder()
            .user_agent(USER_AGENT)
            .timeout(Duration::from_secs(30))
            .build()
            .context("could not build the HTTP client")?;
        Ok(Self { origin, http })
    }

    pub fn origin(&self) -> &str {
        &self.origin
    }

    /// `GET /api/<path>`, optionally with a bearer credential.
    pub fn get(&self, path: &str, token: Option<&str>) -> Result<Value, ApiError> {
        let mut request = self.http.get(self.url(path));
        if let Some(token) = token {
            request = request.bearer_auth(token);
        }
        self.send(request)
    }

    /// `POST /api/<path>` with a JSON body.
    pub fn post(&self, path: &str, token: Option<&str>, body: &Value) -> Result<Value, ApiError> {
        let mut request = self.http.post(self.url(path)).json(body);
        if let Some(token) = token {
            request = request.bearer_auth(token);
        }
        self.send(request)
    }

    /// `DELETE /api/<path>`.
    pub fn delete(&self, path: &str, token: &str) -> Result<Value, ApiError> {
        self.send(self.http.delete(self.url(path)).bearer_auth(token))
    }

    fn url(&self, path: &str) -> String {
        format!("{}/api/{}", self.origin, path.trim_start_matches('/'))
    }

    fn send(&self, request: RequestBuilder) -> Result<Value, ApiError> {
        let response = request.send()?;
        if response.status().is_success() {
            decode_success(response)
        } else {
            Err(decode_error(response))
        }
    }
}

/// Reads a successful body. An empty body is `null`, which some endpoints
/// (logout, revoke) return on purpose.
fn decode_success(response: Response) -> Result<Value, ApiError> {
    let text = response.text()?;
    if text.trim().is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_str(&text)
        .map_err(|_| ApiError::new(502, "invalid_response", "The server returned a response this client could not read."))
}

/// Turns an error response into a message a person can act on. OAuth endpoints
/// answer `{"error": "...", "error_description": "..."}`; the rest of the API
/// answers `{"error": "..."}`.
fn decode_error(response: Response) -> ApiError {
    let status = response.status().as_u16();
    let text = response.text().unwrap_or_default();
    let value = serde_json::from_str::<Value>(&text).ok();
    let code = value
        .as_ref()
        .and_then(|value| value.get("error"))
        .and_then(Value::as_str)
        .unwrap_or("http_error")
        .to_string();
    let described = value.as_ref().and_then(|value| {
        value
            .get("error_description")
            .or_else(|| value.get("message"))
            .and_then(Value::as_str)
    });
    let message = match described {
        Some(message) if !message.trim().is_empty() => message.trim().to_string(),
        _ if text.trim().is_empty() => format!("The server returned HTTP {status}."),
        _ => format!("HTTP {status}: {}", summarize(text.trim())),
    };
    ApiError::new(status, code, message)
}

fn summarize(text: &str) -> String {
    let single_line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if single_line.chars().count() <= 200 {
        single_line
    } else {
        let mut short: String = single_line.chars().take(199).collect();
        short.push('…');
        short
    }
}

/// Validates and canonicalises a console address.
pub fn normalize_server(input: &str) -> Result<String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        bail!("A server URL is required, for example https://console.example.com");
    }
    let url = Url::parse(trimmed).with_context(|| format!("`{trimmed}` is not a valid URL"))?;
    if url.username() != "" || url.password().is_some() {
        bail!("Remove the username and password from the server URL.");
    }
    if url.query().is_some() || url.fragment().is_some() {
        bail!("The server URL cannot contain a query string or fragment.");
    }
    if url.path() != "/" && !url.path().is_empty() {
        bail!("Enter just the origin, for example https://console.example.com");
    }
    let loopback = matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "::1" | "[::1]"));
    match url.scheme() {
        "https" => {}
        "http" if loopback => {}
        "http" => bail!("The server must use HTTPS. Plain HTTP is only accepted for a loopback development server."),
        other => bail!("Unsupported URL scheme `{other}`; use https."),
    }
    Ok(url.origin().ascii_serialization())
}

#[cfg(test)]
mod tests {
    use super::normalize_server;

    #[test]
    fn accepts_https_origins_and_loopback_http() {
        assert_eq!(normalize_server("https://console.example.com").unwrap(), "https://console.example.com");
        assert_eq!(normalize_server("https://console.example.com/").unwrap(), "https://console.example.com");
        assert_eq!(normalize_server("http://127.0.0.1:3210").unwrap(), "http://127.0.0.1:3210");
        assert_eq!(normalize_server("http://localhost:3210/").unwrap(), "http://localhost:3210");
    }

    #[test]
    fn rejects_addresses_that_could_leak_or_redirect() {
        for input in [
            "http://console.example.com",
            "https://user:secret@console.example.com",
            "https://console.example.com/api",
            "https://console.example.com?next=https://evil.test",
            "ftp://console.example.com",
            "not a url",
            "",
        ] {
            assert!(normalize_server(input).is_err(), "{input} should be rejected");
        }
    }
}
