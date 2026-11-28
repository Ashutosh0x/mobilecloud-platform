//! Tunnel client — runs on the Android phone / edge device.
//!
//! Connects to the relay server via WebSocket, authenticates with an Ed25519
//! signed handshake, registers local services, and proxies yamux streams to
//! local TCP ports.

use crate::mux::{TunnelMux, WebSocketAdapter, YamuxMode};
use crate::protocol::{AuthToken, ControlMessage, ServiceMapping, TunnelHandshake};

use ed25519_dalek::SigningKey;
use futures_util::{SinkExt, StreamExt};
use rand::RngCore;
use std::collections::HashMap;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::AsyncReadExt;
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_util::compat::FuturesAsyncReadCompatExt;
use tracing::{error, info, warn};

/// Configuration for the tunnel client.
#[derive(Debug, Clone)]
pub struct ClientConfig {
    /// WebSocket URL of the relay server (e.g. `wss://relay.furlpay.com:8443`).
    pub relay_url: String,
    /// Unique identifier for this client.
    pub client_id: String,
    /// Identifier of the relay this client targets. Bound into the handshake
    /// signature; defaults to empty.
    pub relay_id: String,
    /// Ed25519 signing key for authentication.
    pub signing_key: SigningKey,
    /// Map of service name → local port.
    pub services: HashMap<String, u16>,
    /// Initial reconnect delay.
    pub initial_delay: Duration,
    /// Maximum reconnect delay.
    pub max_delay: Duration,
    /// Heartbeat interval.
    pub heartbeat_interval: Duration,
    /// Heartbeat timeout (consider peer dead after this).
    pub heartbeat_timeout: Duration,
}

impl ClientConfig {
    /// Create a config with sensible defaults.
    pub fn new(relay_url: String, client_id: String, signing_key: SigningKey) -> Self {
        Self {
            relay_url,
            client_id,
            relay_id: String::new(),
            signing_key,
            services: HashMap::new(),
            initial_delay: Duration::from_secs(1),
            max_delay: Duration::from_secs(60),
            heartbeat_interval: Duration::from_secs(30),
            heartbeat_timeout: Duration::from_secs(90),
        }
    }

    /// Register a local service to expose through the tunnel.
    pub fn add_service(mut self, name: &str, port: u16) -> Self {
        self.services.insert(name.to_string(), port);
        self
    }
}

/// The tunnel client. Call `run()` to start the persistent connection loop.
pub struct TunnelClient {
    config: ClientConfig,
}

impl TunnelClient {
    pub fn new(config: ClientConfig) -> Self {
        Self { config }
    }

    /// Run the tunnel client with automatic reconnection.
    ///
    /// This method never returns under normal operation. On disconnect,
    /// it retries with exponential backoff and jitter.
    pub async fn run(&self) -> anyhow::Result<()> {
        let mut delay = self.config.initial_delay;

        loop {
            info!(
                relay = %self.config.relay_url,
                client_id = %self.config.client_id,
                "connecting to relay"
            );

            match self.connect_and_serve().await {
                Ok(()) => {
                    info!("tunnel closed gracefully");
                    delay = self.config.initial_delay; // Reset delay
                }
                Err(e) => {
                    error!(%e, "tunnel connection lost");
                }
            }

            // Exponential backoff with jitter
            let jitter = Duration::from_millis(rand::random::<u64>() % 500);
            let wait = delay + jitter;
            warn!(delay_ms = wait.as_millis() as u64, "reconnecting after delay");
            tokio::time::sleep(wait).await;

            delay = std::cmp::min(delay * 2, self.config.max_delay);
        }
    }

    /// Single connection attempt: connect, authenticate, serve streams.
    async fn connect_and_serve(&self) -> anyhow::Result<()> {
        // 1. Establish WebSocket connection
        let (ws_stream, _) = tokio_tungstenite::connect_async(&self.config.relay_url).await?;
        info!("websocket connected");

        // Convert to our adapter and split for the handshake
        let (mut ws_write, mut ws_read) = ws_stream.split();

        // 2. Send handshake
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();

        let services: Vec<ServiceMapping> = self
            .config
            .services
            .iter()
            .map(|(name, port)| ServiceMapping {
                name: name.clone(),
                local_port: *port,
            })
            .collect();

        // Fresh random anti-replay nonce for this handshake.
        let nonce = generate_nonce();

        let signature = AuthToken::sign(
            &self.config.signing_key,
            &self.config.client_id,
            timestamp,
            &nonce,
            &self.config.relay_id,
        );

        let handshake = TunnelHandshake {
            client_id: self.config.client_id.clone(),
            timestamp,
            services: services.clone(),
            signature,
            nonce,
            relay_id: self.config.relay_id.clone(),
        };

        let handshake_json = serde_json::to_string(&handshake)?;
        ws_write.send(Message::Text(handshake_json.into())).await?;
        info!("handshake sent, awaiting ack");

        // 3. Wait for handshake ack
        match ws_read.next().await {
            Some(Ok(Message::Text(text))) => {
                let msg: ControlMessage = serde_json::from_str(&text)?;
                match msg {
                    ControlMessage::HeartbeatAck { .. } => {
                        info!("handshake accepted by relay");
                    }
                    ControlMessage::Error(e) => {
                        return Err(anyhow::anyhow!("relay rejected handshake: {e}"));
                    }
                    _ => {
                        info!("received initial message, proceeding");
                    }
                }
            }
            Some(Err(e)) => return Err(anyhow::anyhow!("handshake error: {e}")),
            None => return Err(anyhow::anyhow!("connection closed during handshake")),
            _ => {}
        }

        // 4. Reunite the stream and set up yamux
        //    We reunite the split halves back into a single WebSocketStream
        //    and wrap it with our AsyncRead+AsyncWrite adapter for yamux.
        //    No raw socket extraction needed — the reunited stream works directly.
        let ws_stream = ws_write.reunite(ws_read)?;
        let adapter = WebSocketAdapter::new_from_reunited(ws_stream);

        let (mut _mux, mut connection) = TunnelMux::new(adapter, YamuxMode::Client);

        // 5. Accept incoming yamux streams from the relay and proxy to local services
        let services = self.config.services.clone();

        info!(
            services = ?services.keys().collect::<Vec<_>>(),
            "tunnel active, waiting for streams"
        );

        // Drive the yamux connection — accept streams as they come
        loop {
            match connection.next_stream().await {
                Ok(Some(stream)) => {
                    let services = services.clone();
                    tokio::spawn(async move {
                        if let Err(e) = handle_inbound_stream(stream, &services).await {
                            warn!(%e, "stream handler error");
                        }
                    });
                }
                Ok(None) => {
                    info!("yamux connection closed");
                    return Ok(());
                }
                Err(e) => {
                    return Err(anyhow::anyhow!("yamux connection error: {e}"));
                }
            }
        }
    }
}

/// Generate a fresh random anti-replay nonce (128 bits), hex-encoded.
fn generate_nonce() -> String {
    let mut bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    hex::encode(bytes)
}

/// Handle a single inbound yamux stream from the relay.
///
/// The relay sends the target service name as the first line, followed by
/// the full HTTP request. We connect to the local service and proxy both ways.
async fn handle_inbound_stream(
    stream: yamux::Stream,
    services: &HashMap<String, u16>,
) -> anyhow::Result<()> {
    // yamux 0.10 streams use `futures-io` traits; adapt to tokio I/O so we
    // can use `AsyncReadExt` / `copy_bidirectional` directly.
    let mut stream = stream.compat();

    // Read the service name header (first line, newline-terminated)
    let mut header_buf = vec![0u8; 256];
    let mut header_len = 0;

    loop {
        let n = stream.read(&mut header_buf[header_len..header_len + 1]).await?;
        if n == 0 {
            return Err(anyhow::anyhow!("stream closed before service header"));
        }
        if header_buf[header_len] == b'\n' {
            break;
        }
        header_len += 1;
        if header_len >= 255 {
            return Err(anyhow::anyhow!("service header too long"));
        }
    }

    let service_name = String::from_utf8_lossy(&header_buf[..header_len])
        .trim()
        .to_string();

    let port = services
        .get(&service_name)
        .ok_or_else(|| anyhow::anyhow!("unknown service: {service_name}"))?;

    tracing::debug!(service = %service_name, port, "proxying to local service");

    // Connect to the local service
    let mut local = TcpStream::connect(format!("127.0.0.1:{port}")).await?;

    // Bidirectional proxy
    tokio::io::copy_bidirectional(&mut stream, &mut local).await?;

    Ok(())
}
