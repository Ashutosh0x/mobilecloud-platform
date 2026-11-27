//! CLI binary for the MobileCloud tunnel client.
//!
//! Runs on the phone or edge device, connecting to a relay server and
//! exposing local services through the tunnel.
//!
//! # Usage
//!
//! ```sh
//! mc-tunnel-client \
//!   --relay wss://relay.furlpay.com:8443 \
//!   --client-id my-phone-01 \
//!   --signing-key <hex-encoded-ed25519-secret-key> \
//!   --service console=3210 \
//!   --service api=3211 \
//!   --service ws=3212
//! ```

use anyhow::{Context, Result};
use clap::Parser;
use ed25519_dalek::SigningKey;
use mobilecloud_tunnel::client::{ClientConfig, TunnelClient};
use std::time::Duration;
use tracing_subscriber::EnvFilter;

/// MobileCloud Tunnel Client — expose local services through an encrypted tunnel.
#[derive(Parser, Debug)]
#[command(name = "mc-tunnel-client", version, about)]
struct Cli {
    /// WebSocket URL of the relay server.
    #[arg(short, long, env = "MC_RELAY_URL")]
    relay: String,

    /// Unique identifier for this client.
    #[arg(short, long, env = "MC_CLIENT_ID")]
    client_id: String,

    /// Ed25519 signing key (64-byte hex-encoded secret key).
    #[arg(short, long, env = "MC_SIGNING_KEY")]
    signing_key: String,

    /// Service mappings in the form `name=port` (can be repeated).
    #[arg(short = 'S', long = "service", value_parser = parse_service)]
    services: Vec<(String, u16)>,

    /// Heartbeat interval in seconds.
    #[arg(long, default_value = "30")]
    heartbeat_interval: u64,

    /// Heartbeat timeout in seconds.
    #[arg(long, default_value = "90")]
    heartbeat_timeout: u64,

    /// Initial reconnect delay in seconds.
    #[arg(long, default_value = "1")]
    initial_delay: u64,

    /// Maximum reconnect delay in seconds.
    #[arg(long, default_value = "60")]
    max_delay: u64,
}

/// Parse a "name=port" string into a (String, u16) tuple.
fn parse_service(s: &str) -> Result<(String, u16), String> {
    let (name, port_str) = s
        .split_once('=')
        .ok_or_else(|| format!("invalid service mapping '{}', expected name=port", s))?;

    let port: u16 = port_str
        .parse()
        .map_err(|_| format!("invalid port '{}' in service mapping", port_str))?;

    if name.is_empty() {
        return Err("service name cannot be empty".to_string());
    }

    Ok((name.to_string(), port))
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

    // Decode the signing key
    let key_bytes = hex::decode(&cli.signing_key)
        .context("signing key must be hex-encoded")?;

    let key_array: [u8; 32] = key_bytes
        .try_into()
        .map_err(|v: Vec<u8>| anyhow::anyhow!(
            "signing key must be 32 bytes (64 hex chars), got {} bytes",
            v.len()
        ))?;

    let signing_key = SigningKey::from_bytes(&key_array);

    // Build the client config
    let mut config = ClientConfig::new(cli.relay, cli.client_id, signing_key);
    config.heartbeat_interval = Duration::from_secs(cli.heartbeat_interval);
    config.heartbeat_timeout = Duration::from_secs(cli.heartbeat_timeout);
    config.initial_delay = Duration::from_secs(cli.initial_delay);
    config.max_delay = Duration::from_secs(cli.max_delay);

    for (name, port) in cli.services {
        config = config.add_service(&name, port);
    }

    tracing::info!(
        relay = %config.relay_url,
        client_id = %config.client_id,
        services = ?config.services.keys().collect::<Vec<_>>(),
        "starting MobileCloud tunnel client"
    );

    // Run the tunnel client (never returns normally)
    let client = TunnelClient::new(config);
    client.run().await
}
