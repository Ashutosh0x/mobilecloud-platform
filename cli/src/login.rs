//! The two ways to sign in: a device code approved elsewhere, or a browser
//! callback protected by PKCE.
//!
//! Both end in the same place: a token pair for this machine and a [`Profile`]
//! saved under the chosen profile name. Neither flow ever asks for a password
//! in the terminal.

use std::io::{self, Write};
use std::net::TcpListener;
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use reqwest::Url;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::api::{Api, ApiError, CLIENT_ID};
use crate::config::Profile;
use crate::format::now_ms;
use crate::pkce::{wait_for_callback, Pkce};

/// How long the refresh token is good for, matching the control plane.
const REFRESH_LIFETIME_MS: u64 = 30 * 86_400_000;

#[derive(Debug, Deserialize)]
struct DeviceCode {
    device_code: String,
    user_code: String,
    verification_uri: String,
    #[serde(default)]
    verification_uri_complete: String,
    expires_in: u64,
    interval: u64,
}

#[derive(Debug, Deserialize)]
pub struct Tokens {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_in: u64,
    #[serde(default)]
    pub scope: String,
}

/// Runs the Device Authorization Grant (RFC 8628).
pub fn device(api: &Api, scope: &str, no_browser: bool) -> Result<Profile> {
    let started = api
        .post("oauth/device/code", None, &json!({ "client_id": CLIENT_ID, "scope": scope }))
        .map_err(|error| explain(error, "Could not start the login"))?;
    let code: DeviceCode = serde_json::from_value(started).context("the device code response was incomplete")?;

    println!();
    println!("  Sign in to MobileCloud on another device.");
    println!();
    println!("    Open:  {}", code.verification_uri);
    println!("    Code:  {}", code.user_code);
    println!();
    let target = if code.verification_uri_complete.is_empty() {
        code.verification_uri.clone()
    } else {
        code.verification_uri_complete.clone()
    };
    println!("    Direct link: {target}");
    if !no_browser {
        match open::that_detached(&target) {
            Ok(()) => println!("\n  Opened the page in your browser."),
            Err(_) => println!("\n  Open the link above in a browser to continue."),
        }
    }
    println!();
    print!("  Waiting for approval");
    let _ = io::stdout().flush();

    let deadline = Instant::now() + Duration::from_secs(code.expires_in.max(1));
    let mut interval = code.interval.max(1);
    loop {
        if Instant::now() >= deadline {
            println!();
            bail!("The code expired before it was approved. Run `mobilecloud login` again.");
        }
        std::thread::sleep(Duration::from_secs(interval));
        print!(".");
        let _ = io::stdout().flush();
        let body = json!({
            "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
            "device_code": code.device_code,
            "client_id": CLIENT_ID,
        });
        match api.post("oauth/token", None, &body) {
            Ok(value) => {
                println!(" approved");
                let tokens: Tokens = serde_json::from_value(value).context("the token response was incomplete")?;
                return profile_for(api, tokens);
            }
            Err(error) if error.code == "authorization_pending" => continue,
            // RFC 8628 §3.5: back off by five seconds and keep waiting.
            Err(error) if error.code == "slow_down" || error.status == 429 => {
                interval += 5;
                continue;
            }
            Err(error) if error.code == "access_denied" => {
                println!();
                bail!("The request was denied on the approving device.");
            }
            Err(error) if error.code == "expired_token" => {
                println!();
                bail!("The code expired before it was approved. Run `mobilecloud login` again.");
            }
            Err(error) => {
                println!();
                return Err(explain(error, "Login failed"));
            }
        }
    }
}

/// Runs the Authorization Code grant with PKCE over a loopback redirect.
pub fn browser(api: &Api, scope: &str, no_browser: bool) -> Result<Profile> {
    let pkce = Pkce::new();
    let listener = TcpListener::bind("127.0.0.1:0").context("could not open a local callback port")?;
    let port = listener.local_addr().context("could not read the local callback address")?.port();
    let redirect = format!("http://127.0.0.1:{port}/callback");

    let mut url = Url::parse(&format!("{}/authorize", api.origin())).context("could not build the sign-in URL")?;
    url.query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", CLIENT_ID)
        .append_pair("redirect_uri", &redirect)
        .append_pair("code_challenge", &pkce.challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", &pkce.state)
        .append_pair("scope", scope);

    println!();
    println!("  Opening your browser to finish signing in.");
    println!();
    println!("  If nothing opens, visit:");
    println!("    {url}");
    println!();
    println!("  Waiting on http://127.0.0.1:{port}/callback");
    if !no_browser {
        let _ = open::that_detached(url.as_str());
    }

    let code = wait_for_callback(listener, &pkce.state, Duration::from_secs(300))?;
    let response = api
        .post(
            "oauth/token",
            None,
            &json!({
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": redirect,
                "client_id": CLIENT_ID,
                "code_verifier": pkce.verifier,
            }),
        )
        .map_err(|error| explain(error, "Could not finish the browser login"))?;
    let tokens: Tokens = serde_json::from_value(response).context("the token response was incomplete")?;
    profile_for(api, tokens)
}

/// Exchanges tokens for the account they belong to and builds a profile.
pub fn profile_for(api: &Api, tokens: Tokens) -> Result<Profile> {
    let me = api
        .get("auth/me", Some(&tokens.access_token))
        .map_err(|error| explain(error, "Signed in, but the account could not be read"))?;
    let user = me.get("user").cloned().unwrap_or(Value::Null);
    let text = |key: &str| user.get(key).and_then(Value::as_str).unwrap_or_default().to_string();
    let user_id = text("id");
    if user_id.is_empty() {
        bail!("The server did not return an account for this sign-in.");
    }
    let now = now_ms();
    Ok(Profile {
        server: api.origin().to_string(),
        user_id,
        email: text("email"),
        name: text("name"),
        role: text("role"),
        plan: text("plan"),
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        token_expires_at: now.saturating_add(tokens.expires_in.saturating_mul(1_000)),
        refresh_expires_at: now.saturating_add(REFRESH_LIFETIME_MS),
        scope: if tokens.scope.is_empty() { "cli:full".to_string() } else { tokens.scope },
        client_type: "cli".to_string(),
        authenticated_at: now,
        token_id: me
            .get("token")
            .and_then(|token| token.get("id"))
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}

/// Adds the "run `mobilecloud login`" hint the server's wording lacks.
fn explain(error: ApiError, context: &str) -> anyhow::Error {
    if error.code == "invalid_grant" {
        anyhow::anyhow!("{context}: {error}. Run `mobilecloud login` again.")
    } else {
        anyhow::anyhow!("{context}: {error}")
    }
}
