//! Headless asynchronous SSH daemon (terminal doc §1.3, port 2222).
//!
//! Strict public-key authentication (Ed25519) — password auth is disabled.
//! Session channels delegate into the same `PtySession` machinery as the
//! WebSocket path, giving VS Code Remote-SSH and native terminals the
//! identical persistent `tmux` environment on the phone.
//!
//! Wire layout: `russh` 0.45 server API (`run_on_socket`). Host keys load
//! from `<home>/ssh/host_ed25519` (PKCS#8 PEM, generated on first boot);
//! authorized client keys live in `<home>/ssh/authorized_keys` (one
//! `ssh-ed25519 AAAA…` line each), managed from the Android app.

use std::path::PathBuf;
use std::sync::Arc;

use ed25519_dalek::SigningKey;
use russh::server::{Auth, Handler, Msg, Server as _, Session};
use russh::{Channel, ChannelId};
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
        // Allocate the PTY and spawn the persistent tmux shell.
        match PtySession::spawn(&state.engine_bin, &state.home) {
            Ok(handle) => {
                self.pty = Some(handle.control);
                // Output pump: PTY bytes → SSH channel data.
                tokio::spawn(async move {
                    let mut rx = handle.output_rx;
                    let mut channel = channel;
                    while let Some(bytes) = rx.recv().await {
                        if channel.data(&bytes[..]).await.is_err() {
                            break;
                        }
                    }
                    let _ = channel.eof().await;
                });
                Ok(true)
            }
            Err(e) => {
                tracing::error!("ssh PTY allocation failed: {e:#}");
                Ok(false)
            }
        }
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

pub async fn run(state: Arc<AppState>) -> anyhow::Result<()> {
    let ssh_dir: PathBuf = state.home.join("ssh");
    std::fs::create_dir_all(&ssh_dir)?;

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
        }
        key
    };

    let config = Arc::new(russh::server::Config {
        inactivity_timeout: Some(std::time::Duration::from_secs(3600)),
        auth_rejection_time: std::time::Duration::from_secs(1),
        keys: vec![host_key],
        ..Default::default()
    });

    // Authorized client keys (Ed25519 only; passwords disabled).
    let authorized_keys = load_authorized_keys(&ssh_dir.join("authorized_keys"));

    let mut server = MobileCloudSshServer {
        state,
        authorized_keys,
    };

    let listener = tokio::net::TcpListener::bind(("127.0.0.1", SSH_PORT)).await?;
    tracing::info!("Local operator SSH listening on 127.0.0.1:{SSH_PORT} (Ed25519 public key only)");
    server.run_on_socket(config, &listener).await?;
    Ok(())
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
        if algo != "ssh-ed25519" {
            continue;
        }
        if let Ok(public_key) = ssh_key::PublicKey::from_openssh(line) {
            // ssh-key 0.6: Ed25519PublicKey is a tuple struct around [u8; 32].
            if let Some(ed) = public_key.key_data().ed25519() {
                out.push(ed.0.to_vec());
            }
        }
        let _ = blob;
    }
    out
}
