//! Saved credentials.
//!
//! One JSON file holds every profile. The file is written atomically (temporary
//! file + rename) with mode 0600 on Unix, and an existing file that other users
//! can read is refused rather than silently trusted. On Windows the file relies
//! on the user profile's own ACLs, which is what `dirs::config_dir` returns.
//!
//! Nothing here ever prints a token: [`Profile::masked_token`] is the only
//! rendering the commands use.

use std::collections::BTreeMap;
use std::env;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
#[cfg(unix)]
use std::path::Path;

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

/// Where `MOBILECLOUD_CONFIG_DIR` sends the credentials, for tests and for a
/// portable install. Otherwise the platform config directory is used.
pub fn config_dir() -> PathBuf {
    match env::var_os("MOBILECLOUD_CONFIG_DIR") {
        Some(dir) if !dir.is_empty() => PathBuf::from(dir),
        _ => dirs::config_dir()
            .map(|dir| dir.join("mobilecloud"))
            .unwrap_or_else(|| PathBuf::from(".mobilecloud")),
    }
}

pub fn credentials_path() -> PathBuf {
    config_dir().join("credentials.json")
}

/// One signed-in server.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Profile {
    pub server: String,
    pub user_id: String,
    pub email: String,
    pub name: String,
    pub role: String,
    pub plan: String,
    pub access_token: String,
    pub refresh_token: String,
    /// Unix milliseconds.
    pub token_expires_at: u64,
    #[serde(default)]
    pub refresh_expires_at: u64,
    pub scope: String,
    #[serde(default = "default_client_type")]
    pub client_type: String,
    pub authenticated_at: u64,
    #[serde(default)]
    pub token_id: Option<String>,
}

fn default_client_type() -> String {
    "cli".to_string()
}

impl Profile {
    /// The access token as it is safe to show: the prefix the server also
    /// stores for display, never enough to replay.
    pub fn masked_token(&self) -> String {
        let visible: String = self.access_token.chars().take(10).collect();
        format!("{visible}…")
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Credentials {
    pub version: u32,
    #[serde(default)]
    pub profiles: BTreeMap<String, Profile>,
    #[serde(default = "default_profile_name")]
    pub current_profile: String,
}

fn default_profile_name() -> String {
    "default".to_string()
}

impl Default for Credentials {
    fn default() -> Self {
        Self { version: 1, profiles: BTreeMap::new(), current_profile: default_profile_name() }
    }
}

impl Credentials {
    /// Reads the credentials file. A missing file is an empty store, not an
    /// error: that is simply "not logged in yet".
    pub fn load() -> Result<Self> {
        let path = credentials_path();
        let text = match fs::read_to_string(&path) {
            Ok(text) => text,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Self::default()),
            Err(error) => return Err(error).with_context(|| format!("could not read {}", path.display())),
        };
        #[cfg(unix)]
        ensure_private(&path)?;
        let credentials = serde_json::from_str(&text)
            .with_context(|| format!("{} is not a valid credentials file", path.display()))?;
        Ok(credentials)
    }

    /// Writes the file atomically. A crash can leave the temporary file behind,
    /// but never a half-written credentials file.
    pub fn save(&self) -> Result<()> {
        let path = credentials_path();
        let directory = path.parent().context("the credentials path has no parent directory")?;
        fs::create_dir_all(directory)
            .with_context(|| format!("could not create {}", directory.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(directory, fs::Permissions::from_mode(0o700));
        }
        let body = serde_json::to_vec_pretty(self).context("could not encode the credentials")?;
        let temporary = path.with_extension(format!("json.{}.tmp", std::process::id()));
        {
            let mut options = OpenOptions::new();
            options.write(true).create(true).truncate(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options
                .open(&temporary)
                .with_context(|| format!("could not write {}", temporary.display()))?;
            file.write_all(&body)?;
            file.write_all(b"\n")?;
            file.sync_all()?;
        }
        if let Err(error) = fs::rename(&temporary, &path) {
            let _ = fs::remove_file(&temporary);
            return Err(error).with_context(|| format!("could not replace {}", path.display()));
        }
        Ok(())
    }

    pub fn profile(&self, name: &str) -> Option<&Profile> {
        self.profiles.get(name)
    }

    /// The profile, or a message telling the user how to create one.
    pub fn require(&self, name: &str) -> Result<&Profile> {
        self.profile(name).with_context(|| {
            format!("No saved login for profile `{name}`. Run `mobilecloud login` first.")
        })
    }

    pub fn require_mut(&mut self, name: &str) -> Result<&mut Profile> {
        if !self.profiles.contains_key(name) {
            bail!("No saved login for profile `{name}`. Run `mobilecloud login` first.");
        }
        Ok(self.profiles.get_mut(name).expect("checked above"))
    }

    /// Stores a profile and makes it current.
    pub fn put(&mut self, name: &str, profile: Profile) {
        self.profiles.insert(name.to_string(), profile);
        self.current_profile = name.to_string();
    }

    /// Removes a profile and returns whether it existed. When the current
    /// profile is removed, the first remaining one becomes current.
    pub fn remove(&mut self, name: &str) -> bool {
        let existed = self.profiles.remove(name).is_some();
        if self.current_profile == name {
            if let Some(next) = self.profiles.keys().next() {
                self.current_profile = next.clone();
            }
        }
        existed
    }

    /// The profile a command should use: the requested one, or the current one
    /// when the requested name was not given explicitly.
    pub fn resolve_name(&self, requested: &str) -> String {
        if self.profiles.contains_key(requested) {
            return requested.to_string();
        }
        if requested == default_profile_name() && self.profiles.contains_key(&self.current_profile) {
            return self.current_profile.clone();
        }
        requested.to_string()
    }
}

#[cfg(unix)]
fn ensure_private(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let mode = fs::metadata(path)?.permissions().mode() & 0o777;
    if mode & 0o077 != 0 {
        bail!(
            "{} is readable by other users (mode {:o}). Run `chmod 600 {}` and try again.",
            path.display(),
            mode,
            path.display()
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile() -> Profile {
        Profile {
            server: "https://console.example.test".into(),
            user_id: "0123456789abcdef0123456789abcdef".into(),
            email: "alice@example.test".into(),
            name: "Alice".into(),
            role: "owner".into(),
            plan: "community".into(),
            access_token: format!("mc_{}", "a".repeat(48)),
            refresh_token: format!("mcr_{}", "b".repeat(64)),
            token_expires_at: 1_800_000_000_000,
            refresh_expires_at: 1_802_000_000_000,
            scope: "cli:full".into(),
            client_type: "cli".into(),
            authenticated_at: 1_799_000_000_000,
            token_id: Some("token-id".into()),
        }
    }

    #[test]
    fn round_trips_through_the_credentials_file() {
        let directory = std::env::temp_dir().join(format!("mc-cli-config-{}", std::process::id()));
        let _ = fs::remove_dir_all(&directory);
        std::env::set_var("MOBILECLOUD_CONFIG_DIR", &directory);

        let mut credentials = Credentials::default();
        credentials.put("default", profile());
        credentials.save().expect("save");

        let loaded = Credentials::load().expect("load");
        assert_eq!(loaded.profiles.len(), 1);
        assert_eq!(loaded.current_profile, "default");
        assert_eq!(loaded.require("default").unwrap().email, "alice@example.test");
        assert!(loaded.require("missing").is_err());
        assert!(loaded.profiles["default"].masked_token().ends_with('…'));

        let mut removed = loaded;
        assert!(removed.remove("default"));
        assert!(!removed.remove("default"));
        assert!(removed.profiles.is_empty());

        let _ = fs::remove_dir_all(&directory);
        std::env::remove_var("MOBILECLOUD_CONFIG_DIR");
    }
}
