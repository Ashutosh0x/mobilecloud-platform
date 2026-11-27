//! CLI binary for the MobileCloud tunnel relay.
//!
//! Runs on a VPS, accepting tunnel client connections via WebSocket and
//! proxying public HTTP requests to the appropriate client's local services.
//!
//! # Usage
//!
//! ```sh
//! mc-tunnel-relay \
//!   --listen-tunnel 0.0.0.0:8443 \
//!   --listen-public 0.0.0.0:8080 \
//!   --domain furlpay.com \
//!   --authorized-key <hex-encoded-ed25519-public-key>
//! ```

use anyhow::{Context, Result};
use clap::Parser;
use ed25519_dalek::VerifyingKey;
use mobilecloud_tunnel::relay::{RelayConfig, TunnelRelay};
use std::net::SocketAddr;
use tracing_subscriber::EnvFilter;

/// MobileCloud Tunnel Relay — bridge public HTTP to phone-side services.
#[derive(Parser, Debug)]
#[command(name = "mc-tunnel-relay", version, about)]
struct Cli {
    /// Address to listen for tunnel client WebSocket connections.
    #[arg(long, default_value = "0.0.0.0:8443", env = "MC_TUNNEL_ADDR")]
    listen_tunnel: SocketAddr,

    /// Address to listen for public HTTP requests.
    #[arg(long, default_value = "0.0.0.0:8080", env = "MC_PUBLIC_ADDR")]
    listen_public: SocketAddr,

    /// Base domain for service routing (e.g. `furlpay.com`).
    /// Requests to `<service>.furlpay.com` route to service `<service>`.
    #[arg(short, long, env = "MC_DOMAIN")]
    domain: String,

    /// Authorized Ed25519 public keys (32-byte hex-encoded, can be repeated).
    #[arg(short = 'k', long = "authorized-key", value_parser = parse_verifying_key)]
    authorized_keys: Vec<VerifyingKey>,
}

/// Parse a hex-encoded Ed25519 public key.
fn parse_verifying_key(s: &str) -> Result<VerifyingKey, String> {
    let bytes = hex::decode(s)
        .map_err(|e| format!("invalid hex for public key: {e}"))?;

    let key_array: [u8; 32] = bytes
        .try_into()
        .map_err(|v: Vec<u8>| {
            format!(
                "public key must be 32 bytes (64 hex chars), got {} bytes",
                v.len()
            )
        })?;

    VerifyingKey::from_bytes(&key_array)
        .map_err(|e| format!("invalid Ed25519 public key: {e}"))
}

#[tokio::main]
async fn main() -> Result<()> {
    // Initialize tracing
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let cli = Cli::parse();

    if cli.authorized_keys.is_empty() {
        anyhow::bail!(
            "at least one --authorized-key is required; \
             generate a keypair with: mc-tunnel-keygen"
        );
    }

    let config = RelayConfig {
        tunnel_addr: cli.listen_tunnel,
        public_addr: cli.listen_public,
        domain: cli.domain.clone(),
        authorized_keys: cli.authorized_keys,
    };

    tracing::info!(
        tunnel_addr = %config.tunnel_addr,
        public_addr = %config.public_addr,
        domain = %config.domain,
        num_authorized_keys = config.authorized_keys.len(),
        "starting MobileCloud tunnel relay"
    );

    let relay = TunnelRelay::new(config);
    relay.run().await
}
