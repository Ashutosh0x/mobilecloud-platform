//! The commands that run against a signed-in account.
//!
//! Every authenticated call goes through [`Session`], which retries exactly once
//! after rotating an expired access token. The rotated pair is written back to
//! disk immediately, so a crash cannot leave the saved refresh token stale.

use std::io::{self, Write};

use anyhow::{bail, Context, Result};
use serde_json::{json, Value};

use crate::api::{Api, CLIENT_ID};
use crate::config::{Credentials, Profile};
use crate::format::{now_ms, relative, remaining, truncate, Table};
use crate::login::Tokens;

const REFRESH_LIFETIME_MS: u64 = 30 * 86_400_000;

#[derive(Clone, Copy)]
enum Method {
    Get,
    Delete,
}

/// An authenticated API session bound to one saved profile.
pub struct Session {
    pub api: Api,
    pub credentials: Credentials,
    pub name: String,
}

impl Session {
    /// Opens the saved profile, using `server` when the caller overrode it.
    pub fn open(server: Option<&str>, profile: &str) -> Result<Self> {
        let credentials = Credentials::load()?;
        let name = credentials.resolve_name(profile);
        let server = match server {
            Some(server) => server.to_string(),
            None => credentials.require(&name)?.server.clone(),
        };
        Ok(Self { api: Api::connect(&server)?, credentials, name })
    }

    pub fn profile(&self) -> Result<&Profile> {
        self.credentials.require(&self.name)
    }

    fn token(&self) -> Result<String> {
        Ok(self.profile()?.access_token.clone())
    }

    pub fn get(&mut self, path: &str) -> Result<Value> {
        self.call(Method::Get, path)
    }

    pub fn delete(&mut self, path: &str) -> Result<Value> {
        self.call(Method::Delete, path)
    }

    fn call(&mut self, method: Method, path: &str) -> Result<Value> {
        let token = self.token()?;
        let first = match method {
            Method::Get => self.api.get(path, Some(&token)),
            Method::Delete => self.api.delete(path, &token),
        };
        match first {
            Ok(value) => Ok(value),
            Err(error) if error.status == 401 => {
                self.refresh().with_context(|| {
                    "Your session expired and could not be renewed. Run `mobilecloud login` again."
                })?;
                let token = self.token()?;
                match method {
                    Method::Get => self.api.get(path, Some(&token)),
                    Method::Delete => self.api.delete(path, &token),
                }
                .map_err(anyhow::Error::from)
            }
            Err(error) => Err(error.into()),
        }
    }

    /// Rotates the refresh token. A replayed or revoked token fails here, which
    /// is exactly when the user has to sign in again.
    fn refresh(&mut self) -> Result<()> {
        let refresh_token = self.profile()?.refresh_token.clone();
        let response = self
            .api
            .post(
                "oauth/token",
                None,
                &json!({
                    "grant_type": "refresh_token",
                    "refresh_token": refresh_token,
                    "client_id": CLIENT_ID,
                }),
            )
            .map_err(anyhow::Error::from)?;
        let tokens: Tokens = serde_json::from_value(response).context("the refresh response was incomplete")?;
        let now = now_ms();
        {
            let profile = self.credentials.require_mut(&self.name)?;
            profile.access_token = tokens.access_token;
            profile.refresh_token = tokens.refresh_token;
            if !tokens.scope.is_empty() {
                profile.scope = tokens.scope;
            }
            profile.token_expires_at = now.saturating_add(tokens.expires_in.saturating_mul(1_000));
            profile.refresh_expires_at = now.saturating_add(REFRESH_LIFETIME_MS);
        }
        self.credentials.save()?;
        Ok(())
    }
}

pub fn whoami(session: &mut Session, json_output: bool) -> Result<()> {
    let me = session.get("auth/me")?;
    let user = me.get("user").cloned().unwrap_or(Value::Null);
    let token = me.get("token").cloned().unwrap_or(Value::Null);
    if json_output {
        println!(
            "{}",
            serde_json::to_string_pretty(&json!({
                "user": user,
                "token": token,
                "server": session.api.origin(),
            }))?
        );
        return Ok(());
    }

    let stored = session.profile()?.clone();
    let scope = string_or(&token, "scope", &stored.scope);
    let expires_at = token.get("expires_at").and_then(Value::as_u64).unwrap_or(stored.token_expires_at);
    println!("Account:  {} ({})", string_or(&user, "email", &stored.email), string_or(&user, "name", &stored.name));
    println!("User ID:  {}", string_or(&user, "id", &stored.user_id));
    println!("Role:     {}", string_or(&user, "role", &stored.role));
    println!("Plan:     {}", string_or(&user, "plan", &stored.plan));
    println!("Server:   {}", session.api.origin());
    println!("Client:   {scope} · CLI ({})", stored.client_type);
    println!("Session:  {} (expires {})", remaining(expires_at, now_ms()), crate::format::utc(expires_at));
    println!("Token:    {}", stored.masked_token());
    Ok(())
}

pub fn devices(session: &mut Session, json_output: bool, include_revoked: bool) -> Result<()> {
    let value = session.get("devices")?;
    let devices = filter_devices(array(value.get("devices")), include_revoked);
    if json_output {
        println!("{}", serde_json::to_string_pretty(&json!({ "devices": devices }))?);
        return Ok(());
    }
    if devices.is_empty() {
        println!("No linked devices.");
        return Ok(());
    }
    let now = now_ms();
    let mut table = Table::new(&["DEVICE ID", "NAME", "PLATFORM", "METHOD", "LINKED", "LAST ACTIVE", "STATUS"]);
    for device in &devices {
        table.push(vec![
            truncate(&text(device, "id"), 12),
            truncate(&text(device, "name"), 28),
            text(device, "platform"),
            text(device, "method"),
            relative(number(device, "pairedAt"), now),
            relative(number(device, "lastActive"), now),
            if flag(device, "revoked") { "revoked".to_string() } else { "active".to_string() },
        ]);
    }
    print!("{}", table.render());
    Ok(())
}

pub fn sessions(session: &mut Session, json_output: bool) -> Result<()> {
    let value = session.get("auth/sessions")?;
    let sessions = array(value.get("sessions"));
    if json_output {
        println!("{}", serde_json::to_string_pretty(&json!({ "sessions": sessions }))?);
        return Ok(());
    }
    if sessions.is_empty() {
        println!("No active sessions.");
        return Ok(());
    }
    let now = now_ms();
    let mut table = Table::new(&["SESSION ID", "KIND", "CLIENT", "DEVICE", "CREATED", "EXPIRES", "CURRENT"]);
    for entry in &sessions {
        let device = {
            let id = text(entry, "deviceId");
            if id.is_empty() { truncate(&text(entry, "userAgent"), 28) } else { truncate(&id, 12) }
        };
        table.push(vec![
            truncate(&text(entry, "id"), 12),
            text(entry, "kind"),
            text(entry, "clientType"),
            device,
            relative(number(entry, "createdAt"), now),
            remaining(number(entry, "expiresAt"), now),
            if flag(entry, "current") { "yes".to_string() } else { String::new() },
        ]);
    }
    print!("{}", table.render());
    Ok(())
}

pub fn revoke_device(session: &mut Session, id: &str, assume_yes: bool) -> Result<()> {
    let value = session.get("devices")?;
    let devices = filter_devices(array(value.get("devices")), true);
    let matched = matching(&devices, id, "device")?;
    let device = &matched[0];
    let name = text(device, "name");
    let platform = text(device, "platform");
    let linked = relative(number(device, "pairedAt"), now_ms());
    let prompt = format!("Revoke \"{name}\" ({platform}, linked {linked})?\nThis ends every session on this device.");
    if !confirm(&prompt, assume_yes)? {
        println!("Cancelled.");
        return Ok(());
    }
    session.delete(&format!("devices/{}", text(device, "id")))?;
    println!("Device revoked.");
    Ok(())
}

pub fn revoke_session(session: &mut Session, id: &str, assume_yes: bool) -> Result<()> {
    let value = session.get("auth/sessions")?;
    let sessions = array(value.get("sessions"));
    let matched = matching(&sessions, id, "session")?;
    let entry = &matched[0];
    let client = text(entry, "clientType");
    let created = relative(number(entry, "createdAt"), now_ms());
    let prompt = format!(
        "Revoke this {client} session (started {created}, expires {})?",
        remaining(number(entry, "expiresAt"), now_ms())
    );
    if !confirm(&prompt, assume_yes)? {
        println!("Cancelled.");
        return Ok(());
    }
    session.delete(&format!("auth/sessions/{}", text(entry, "id")))?;
    println!("Session revoked.");
    Ok(())
}

pub fn logout(session: &mut Session) -> Result<()> {
    if session.credentials.profile(&session.name).is_none() {
        bail!("Not logged in.");
    }
    let token = session.profile()?.access_token.clone();
    let server_note = match session.api.post("auth/logout", Some(&token), &json!({})) {
        Ok(_) => None,
        Err(error) if error.status == 401 => None,
        Err(error) => Some(error.to_string()),
    };
    let name = session.name.clone();
    session.credentials.remove(&name);
    session.credentials.save()?;
    match server_note {
        Some(note) => println!("Signed out on this machine. The server said: {note}"),
        None => println!("Signed out. The token and its refresh chain were revoked."),
    }
    Ok(())
}

/// Splits a JSON array into owned objects, tolerating a missing field.
fn array(value: Option<&Value>) -> Vec<Value> {
    value.and_then(Value::as_array).cloned().unwrap_or_default()
}

fn filter_devices(mut devices: Vec<Value>, include_revoked: bool) -> Vec<Value> {
    if include_revoked {
        return devices;
    }
    devices.retain(|device| !flag(device, "revoked"));
    devices
}

/// Resolves an id or unique prefix, explaining ambiguity rather than guessing.
fn matching(entries: &[Value], needle: &str, kind: &str) -> Result<Vec<Value>> {
    let needle = needle.trim();
    if needle.is_empty() {
        bail!("A {kind} id is required.");
    }
    let matched: Vec<Value> = entries
        .iter()
        .filter(|entry| text(entry, "id").starts_with(needle))
        .cloned()
        .collect();
    match matched.len() {
        0 => bail!("No {kind} matches `{needle}`."),
        1 => Ok(matched),
        _ => {
            let candidates: Vec<String> = matched.iter().map(|entry| truncate(&text(entry, "id"), 12)).collect();
            bail!("`{needle}` matches more than one {kind}: {}", candidates.join(", "));
        }
    }
}

fn confirm(prompt: &str, assume_yes: bool) -> Result<bool> {
    if assume_yes {
        println!("{prompt}");
        println!("[y/N]: y");
        return Ok(true);
    }
    print!("{prompt}\n[y/N]: ");
    io::stdout().flush()?;
    let mut line = String::new();
    io::stdin().read_line(&mut line)?;
    Ok(matches!(line.trim().to_ascii_lowercase().as_str(), "y" | "yes"))
}

fn text(value: &Value, key: &str) -> String {
    value.get(key).and_then(Value::as_str).unwrap_or_default().to_string()
}

fn string_or(value: &Value, key: &str, fallback: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .unwrap_or(fallback)
        .to_string()
}

fn number(value: &Value, key: &str) -> u64 {
    value.get(key).and_then(Value::as_u64).unwrap_or(0)
}

fn flag(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool).unwrap_or(false)
}
