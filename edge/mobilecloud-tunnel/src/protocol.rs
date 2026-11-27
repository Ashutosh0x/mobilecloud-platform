//! Shared protocol types for the MobileCloud tunnel.
//!
//! Defines the handshake, control messages, and authentication primitives
//! used by both the tunnel client and the relay server.

use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Maps a named service to its local port on the client device.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServiceMapping {
    /// Human-readable service name (e.g. "console", "api", "ws").
    pub name: String,
    /// Local TCP port where the service is listening.
    pub local_port: u16,
}

/// Initial handshake sent by the client to the relay upon connection.
///
/// The relay verifies the signature before registering the client's services.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TunnelHandshake {
    /// Unique identifier for this tunnel client.
    pub client_id: String,
    /// Unix timestamp (seconds) of when this handshake was created.
    pub timestamp: u64,
    /// Services the client wants to expose through the tunnel.
    pub services: Vec<ServiceMapping>,
    /// Ed25519 signature over the handshake payload, hex-encoded.
    pub signature: String,
}

/// Control messages exchanged between client and relay over the control channel.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "payload")]
pub enum ControlMessage {
    /// Register a new service after the initial handshake.
    RegisterService(ServiceMapping),
    /// Heartbeat ping from the client.
    Heartbeat { seq: u64 },
    /// Heartbeat acknowledgement from the relay.
    HeartbeatAck { seq: u64 },
    /// Error message.
    Error(String),
}

/// Authentication token utilities for Ed25519-based handshake signing.
pub struct AuthToken;

impl AuthToken {
    /// Construct the canonical message bytes for signing.
    ///
    /// The message is: `SHA256(client_id || ":" || timestamp_string)`.
    fn message_bytes(client_id: &str, timestamp: u64) -> Vec<u8> {
        let mut hasher = Sha256::new();
        hasher.update(client_id.as_bytes());
        hasher.update(b":");
        hasher.update(timestamp.to_string().as_bytes());
        hasher.finalize().to_vec()
    }

    /// Sign a handshake payload with the given Ed25519 secret key.
    ///
    /// Returns the signature as a hex-encoded string.
    pub fn sign(signing_key: &SigningKey, client_id: &str, timestamp: u64) -> String {
        let msg = Self::message_bytes(client_id, timestamp);
        let sig = signing_key.sign(&msg);
        hex::encode(sig.to_bytes())
    }

    /// Verify a handshake signature against the given Ed25519 public key.
    ///
    /// Returns `Ok(())` if the signature is valid, or an error otherwise.
    pub fn verify(
        verifying_key: &VerifyingKey,
        client_id: &str,
        timestamp: u64,
        signature_hex: &str,
    ) -> anyhow::Result<()> {
        let msg = Self::message_bytes(client_id, timestamp);
        let sig_bytes = hex::decode(signature_hex)?;
        let sig = Signature::from_bytes(
            sig_bytes
                .as_slice()
                .try_into()
                .map_err(|_| anyhow::anyhow!("invalid signature length"))?,
        );
        verifying_key
            .verify(&msg, &sig)
            .map_err(|e| anyhow::anyhow!("signature verification failed: {e}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sign_and_verify_roundtrip() {
        let mut rng = rand::thread_rng();
        let signing_key = SigningKey::generate(&mut rng);
        let verifying_key = signing_key.verifying_key();

        let client_id = "test-client-001";
        let timestamp = 1700000000u64;

        let sig = AuthToken::sign(&signing_key, client_id, timestamp);
        assert!(AuthToken::verify(&verifying_key, client_id, timestamp, &sig).is_ok());

        // Tampered timestamp should fail
        assert!(AuthToken::verify(&verifying_key, client_id, timestamp + 1, &sig).is_err());
    }
}
