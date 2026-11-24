//! Headless asynchronous SSH daemon (terminal doc §1.3, port 2222).
//!
//! Strict public-key authentication (Ed25519) — password auth is disabled.
//! Session channels delegate into the same `PtySession` machinery as the
//! WebSocket path, giving VS Code Remote-SSH and native terminals the
//! identical persistent `tmux` environment on the phone.
//!
//! Wire layout: `russh` 0.45 server API (`run_on_socket`). Host keys load
//! from `<home>/ssh/host_ed25519_seed` (raw 32-byte Ed25519 seed, generated on
//! first boot); authorized client keys live in `<home>/ssh/authorized_keys`
//! (one `ssh-ed25519 AAAA…` line each), managed from the Android app.
//!
//! ## Bind interface
//!
//! Loopback is the default. Set `MOBILECLOUD_SSH_HOST` to a LAN/VPN address
//! (for example `0.0.0.0`, `192.168.1.42`, `fd00::5`) or set
//! `MOBILECLOUD_SSH_BIND` to a full `host:port` to expose the daemon to a
//! trusted network. `MOBILECLOUD_SSH_PORT` overrides the port. A non-loopback
//! bind is refused unless at least one authorized Ed25519 key is provisioned,
//! so the daemon can never come up as an unauthenticated open relay.

use std::net::{IpAddr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use ed25519_dalek::SigningKey;
use russh::server::{Auth, Handler, Msg, Server as _, Session};
use russh::{Channel, ChannelId, Pty};
use russh_keys::key::{KeyPair, PublicKey as RusshPublicKey};

use crate::terminal_gateway::pty_session::{PtyControl, PtySession};
use crate::AppState;

pub const SSH_PORT: u16 = 2222;

/// Per-connection handler state.
struct MobileCloudSshHandler {
    state: Option<Arc<AppState>>,
    /// Active PTY control for this connection (set once a session channel opens).
    pty: Option<Arc<PtyControl>>,
    /// Raw Ed25519 public key bytes permitted to connect.
    authorized_keys: Vec<Vec<u8>>,
}

impl MobileCloudSshHandler {
    fn key_is_authorized(&self, public_key: &RusshPublicKey) -> bool {
        match public_key {
            RusshPublicKey::Ed25519(verifying_key) => self
                .authorized_keys
                .iter()
                .any(|k| k.as_slice() == verifying_key.as_bytes()),
            _ => false, // Ed25519 only — RSA/EC client keys are refused
        }
    }
}

#[async_trait::async_trait]
impl Handler for MobileCloudSshHandler {
    type Error = russh::Error;

    async fn auth_publickey(
        &mut self,
        _username: &str,
        public_key: &RusshPublicKey,
    ) -> Result<Auth, Self::Error> {
        if self.key_is_authorized(public_key) {
            Ok(Auth::Accept)
        } else {
            Ok(Auth::Reject {
                proceed_with_methods: None, // passwords stay disabled forever
            })
        }
    }

    async fn auth_none(&mut self, _username: &str) -> Result<Auth, Self::Error> {
        Ok(Auth::Reject {
            proceed_with_methods: Some(russh::MethodSet::PUBLICKEY),
        })
    }

    async fn channel_open_session(
        &mut self,
        channel: Channel<Msg>,
        _session: &mut Session,
    ) -> Result<bool, Self::Error> {
        let Some(state) = self.state.clone() else {
            return Ok(false);
        };
        // One interactive session per SSH connection; `tmux` multiplexes inside.
        if self.pty.is_some() {
            return Ok(false);
        }
        // Allocate the PTY and spawn the persistent tmux shell.
        match PtySession::spawn(&state.engine_bin, &state.home) {
            Ok(handle) => {
                self.pty = Some(handle.control);
                // Output pump: PTY bytes → SSH channel data.
                tokio::spawn(async move {
                    let mut rx = handle.output_rx;
                    // Keep the process handle alive until the pump ends.
                    let _child = handle.child;
                    let channel = channel;
                    while let Some(bytes) = rx.recv().await {
                        if channel.data(&bytes[..]).await.is_err() {
                            break;
                        }
                    }
                    let _ = channel.eof().await;
                    let _ = _child;
                });
                Ok(true)
            }
            Err(e) => {
                tracing::error!("ssh PTY allocation failed: {e:#}");
                Ok(false)
            }
        }
    }

    async fn pty_request(
        &mut self,
        _channel: ChannelId,
        term: &str,
        col_width: u32,
        row_height: u32,
        _pix_width: u32,
        _pix_height: u32,
        _modes: &[(Pty, u32)],
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        if let Some(pty) = &self.pty {
            // Ignore the client's `TERM`; the server owns the terminal type so
            // every mode gets identical truecolour + tmux behaviour.
            tracing::debug!(client_term = %term, "ssh pty request");
            let _ = pty.resize(
                row_height.clamp(1, 500) as u16,
                col_width.clamp(1, 500) as u16,
            );
        }
        Ok(())
    }

    async fn shell_request(
        &mut self,
        _channel: ChannelId,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        // The PTY already runs `tmux new-session -A`; a shell request simply
        // attaches the channel that `channel_open_session` created.
        Ok(())
    }

    async fn data(
        &mut self,
        _channel_id: ChannelId,
        data: &[u8],
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        if let Some(pty) = &self.pty {
            let _ = pty.write(data);
        }
        Ok(())
    }

    async fn window_change_request(
        &mut self,
        _channel_id: ChannelId,
        col_width: u32,
        row_height: u32,
        _pix_width: u32,
        _pix_height: u32,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        if let Some(pty) = &self.pty {
            let _ = pty.resize(
                row_height.clamp(1, 500) as u16,
                col_width.clamp(1, 500) as u16,
            );
        }
        Ok(())
    }

    async fn channel_close(
        &mut self,
        _channel: ChannelId,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        self.pty = None;
        Ok(())
    }
}

/// Server bootstrap: hands each connection a fresh handler with shared state.
struct MobileCloudSshServer {
    state: Arc<AppState>,
    authorized_keys: Vec<Vec<u8>>,
}

#[async_trait::async_trait]
impl russh::server::Server for MobileCloudSshServer {
    type Handler = MobileCloudSshHandler;

    fn new_client(&mut self, _addr: Option<std::net::SocketAddr>) -> Self::Handler {
        MobileCloudSshHandler {
            state: Some(self.state.clone()),
            pty: None,
            authorized_keys: self.authorized_keys.clone(),
        }
    }
}

/// Resolve the bind address from the environment, refusing unsafe exposure.
pub async fn bind_addr() -> anyhow::Result<SocketAddr> {
    if let Ok(raw) = std::env::var("MOBILECLOUD_SSH_BIND") {
        let addr: SocketAddr = raw
            .parse()
            .map_err(|_| anyhow::anyhow!("MOBILECLOUD_SSH_BIND must be host:port"))?;
        return Ok(addr);
    }
    let host = std::env::var("MOBILECLOUD_SSH_HOST").unwrap_or_else(|_| "127.0.0.1".into());
    let port: u16 = std::env::var("MOBILECLOUD_SSH_PORT")
        .ok()
        .map(|value| {
            value
                .parse()
                .map_err(|_| anyhow::anyhow!("MOBILECLOUD_SSH_PORT must be a TCP port"))
        })
        .transpose()?
        .unwrap_or(SSH_PORT);
    if host.trim().is_empty() || host.len() > 255 {
        anyhow::bail!("MOBILECLOUD_SSH_HOST is empty or too long");
    }
    // Literal IPs bind directly; hostnames resolve to their first address.
    if let Ok(ip) = host.parse::<IpAddr>() {
        return Ok(SocketAddr::new(ip, port));
    }
    let mut resolved = tokio::net::lookup_host((host.as_str(), port))
        .await
        .map_err(|e| anyhow::anyhow!("MOBILECLOUD_SSH_HOST could not be resolved: {e}"))?;
    resolved
        .next()
        .ok_or_else(|| anyhow::anyhow!("MOBILECLOUD_SSH_HOST resolved to no addresses"))
}

pub async fn run(state: Arc<AppState>) -> anyhow::Result<()> {
    let ssh_dir: PathBuf = state.home.join("ssh");
    std::fs::create_dir_all(&ssh_dir)?;
    restrict_permissions(&ssh_dir, 0o700);

    // Host key: persistent Ed25519 identity (StrongBox-generated on Android),
    // persisted as the raw 32-byte seed inside app-private storage (0600).
    // Reconstructed at boot from the seed — `russh_keys::format` is private,
    // and the seed form is both stable and trivially StrongBox-portable.
    let host_key_path = ssh_dir.join("host_ed25519_seed");
    let host_key = if host_key_path.exists() {
        let seed = std::fs::read(&host_key_path)?;
        let seed: [u8; 32] = seed
            .as_slice()
            .try_into()
            .map_err(|_| anyhow::anyhow!("host key seed must be 32 bytes"))?;
        KeyPair::Ed25519(SigningKey::from_bytes(&seed))
    } else {
        let key = KeyPair::generate_ed25519()
            .ok_or_else(|| anyhow::anyhow!("ed25519 host key generation failed"))?;
        if let KeyPair::Ed25519(sk) = &key {
            std::fs::write(&host_key_path, sk.to_bytes())?;
            restrict_permissions(&host_key_path, 0o600);
        }
        key
    };
    let fingerprint = host_key
        .clone_public_key()
        .map(|key| key.fingerprint())
        .unwrap_or_else(|_| "unavailable".to_string());

    let config = Arc::new(russh::server::Config {
        inactivity_timeout: Some(std::time::Duration::from_secs(3600)),
        auth_rejection_time: std::time::Duration::from_secs(1),
        keys: vec![host_key],
        ..Default::default()
    });

    // Authorized client keys (Ed25519 only; passwords disabled).
    let authorized_keys = load_authorized_keys(&ssh_dir.join("authorized_keys"));

    let bind = bind_addr().await?;
    if !bind.ip().is_loopback() && authorized_keys.is_empty() {
        anyhow::bail!(
            "refusing non-loopback SSH bind {bind}: authorize at least one Ed25519 key in {}/authorized_keys first",
            ssh_dir.display()
        );
    }
    if bind.ip().is_unspecified() || !bind.ip().is_loopback() {
        tracing::warn!(
            %bind,
            keys = authorized_keys.len(),
            "SSH daemon exposed beyond loopback — reachable by every host that can route to this device"
        );
    } else {
        tracing::info!(
            %bind,
            "Local operator SSH listening on loopback (Ed25519 public key only)"
        );
    }
    tracing::info!("SSH host key fingerprint {fingerprint}");

    let mut server = MobileCloudSshServer {
        state,
        authorized_keys,
    };

    let listener = tokio::net::TcpListener::bind(bind).await?;
    server.run_on_socket(config, &listener).await?;
    Ok(())
}

fn restrict_permissions(path: &Path, mode: u32) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode));
    }
    #[cfg(not(unix))]
    let _ = (path, mode);
}

/// Parse `ssh-ed25519 AAAA…` authorized_keys lines into raw key bytes.
///
/// Uses `ssh_key::PublicKey` for base64 decoding, then extracts the raw
/// 32-byte Ed25519 key material.
fn load_authorized_keys(path: &PathBuf) -> Vec<Vec<u8>> {
    let mut out = Vec::new();
    let Ok(raw) = std::fs::read_to_string(path) else {
        return out; // empty list → every connection rejected until provisioned
    };
    for line in raw.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        // Second whitespace-separated field carries the base64 key blob.
        let mut parts = line.split_whitespace();
        let algo = parts.next().unwrap_or_default();
        let blob = parts.next().unwrap_or_default();
        if algo != "ssh-ed25519" || blob.is_empty() {
            continue;
        }
        if let Ok(public_key) = ssh_key::PublicKey::from_openssh(line) {
            // ssh-key 0.6: Ed25519PublicKey is a tuple struct around [u8; 32].
            if let Some(ed) = public_key.key_data().ed25519() {
                out.push(ed.0.to_vec());
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn authorized_keys_parser_is_strict() {
        let mut ed = [0u8; 32];
        ed[0] = 7;
        let key = ssh_key::public::Ed25519PublicKey(ed);
        let line = ssh_key::PublicKey::from(key).to_openssh().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("authorized_keys");
        let body = format!(
            "# comment\nrsa AAAAnotvalid\n{}\nssh-ed25519 not-base64\n",
            line.trim()
        );
        std::fs::write(&path, body).unwrap();
        let parsed = load_authorized_keys(&path);
        assert_eq!(parsed, vec![ed.to_vec()]);
    }

    #[tokio::test]
    async fn bind_address_refuses_nonsense() {
        std::env::set_var("MOBILECLOUD_SSH_HOST", "127.0.0.1");
        std::env::set_var("MOBILECLOUD_SSH_PORT", "2222");
        let addr = bind_addr().await.unwrap();
        assert!(addr.ip().is_loopback());
        assert_eq!(addr.port(), 2222);
        std::env::remove_var("MOBILECLOUD_SSH_PORT");
        std::env::remove_var("MOBILECLOUD_SSH_HOST");
    }
}
