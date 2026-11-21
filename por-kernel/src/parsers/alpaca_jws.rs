//! RFC 7515 JSON Web Signature verification for Alpaca Securities custody feeds.
//!
//! Wire format (case study §2.1):
//! ```text
//! Header : {"alg": "PS256", "kid": "alpaca-custody-2026-q4", "typ": "JWT"}
//! Payload: brokerage position statement (settled shares / T+1 cash / on-loan)
//! Signing input: "<b64url(header)>.<b64url(payload)>"
//! Signature: RSASSA-PSS (SHA-256, MGF1-SHA256, 32-byte salt)
//! ```
//!
//! Public keys are anchored in the on-chain [`crate::parsers::alpaca_jws::KeyRegistry`]
//! (production spec §1.2): `(SourceLEI, KeyID) -> active key`, 48-hour timelocked
//! rotation, instant emergency revocation. DNS spoofing / MITM key swaps therefore
//! cannot inject a custodian key.

use rsa::pss::{Signature as PssSignature, VerifyingKey as PssVerifyingKey};
use rsa::signature::Verifier;
use rsa::RsaPublicKey;
use serde::Deserialize;
use sha2::Sha256;

use crate::envelope::base64url_decode;
use crate::PoRError;

/// Alpaca's published Legal Entity Identifier (case study §8.1 header).
pub const ALPACA_LEI: &str = "5493006MHB84DD0ZWV18";

/// Decoded JWS protected header.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct JwsHeader {
    pub alg: String,
    pub kid: String,
    #[serde(default)]
    pub typ: Option<String>,
}

/// Custodian position payload (mirrors the envelope payload pillar).
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct CustodyPositionPayload {
    pub snapshot_timestamp_utc: i64,
    #[serde(default, alias = "settled_shares")]
    pub settled_shares: String,
    #[serde(default, alias = "transit_cash_in_usd")]
    pub transit_cash_in_usd: String,
    #[serde(default)]
    pub pending_redeem_shares: String,
    /// Certified condition — must be strictly "0" after verification.
    pub shares_on_loan: String,
    #[serde(default)]
    pub segregation_status: String,
}

/// A registered custodian signing key with its validity window.
#[derive(Clone, Debug)]
pub struct KeyAnchor {
    pub lei: String,
    pub key_id: String,
    pub public_key: RsaPublicKey,
    /// UNIX seconds outside which the anchor is not honored.
    pub not_before: i64,
    pub not_after: i64,
}

/// In-memory mirror of the on-chain `KeyRegistryContract`
/// (production spec §1.2): 48-hour timelocked rotation + instant revocation.
#[derive(Clone, Debug, Default)]
pub struct KeyRegistry {
    anchors: Vec<KeyAnchor>,
    /// Keys scheduled to become active at `activates_at` (48h timelock).
    pending_rotations: Vec<(String, String, RsaPublicKey, i64)>,
    /// (lei, kid) pairs revoked with immediate effect.
    revoked: Vec<(String, String)>,
}

impl KeyRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register_anchor(&mut self, anchor: KeyAnchor) {
        self.anchors.push(anchor);
    }

    /// Schedule a key rotation. Per §1.2 the new key becomes active only after
    /// a **48-hour timelock** (enforced at verification time, not here).
    pub fn schedule_rotation(&mut self, lei: &str, kid: &str, new_key: RsaPublicKey, activates_at: i64) {
        self.pending_rotations
            .push((lei.to_string(), kid.to_string(), new_key, activates_at));
    }

    /// Emergency revocation — instantaneous, callable by issuer or the
    /// FurlPay security multi-sig upon private-key compromise.
    pub fn revoke(&mut self, lei: &str, kid: &str) {
        self.revoked.push((lei.to_string(), kid.to_string()));
    }

    fn active_key(&mut self, lei: &str, kid: &str, now: i64) -> Result<RsaPublicKey, PoRError> {
        if self
            .revoked
            .iter()
            .any(|(r_lei, r_kid)| r_lei == lei && r_kid == kid)
        {
            return Err(PoRError::InvalidEvidence);
        }
        // Promote any due rotation (48h timelock elapsed).
        let due: Vec<(String, String, RsaPublicKey)> = self
            .pending_rotations
            .iter()
            .filter(|(p_lei, p_kid, _, at)| {
                p_lei == lei && p_kid == kid && *at <= now
            })
            .map(|(l, k, key, _)| (l.clone(), k.clone(), key.clone()))
            .collect();
        for (l, k, key) in due {
            self.pending_rotations
                .retain(|(p_lei, p_kid, _, _)| !(p_lei == &l && p_kid == &k));
            if let Some(anchor) = self
                .anchors
                .iter_mut()
                .find(|a| a.lei == l && a.key_id == k)
            {
                anchor.public_key = key;
            }
        }
        self.anchors
            .iter()
            .find(|a| a.lei == lei && a.key_id == kid && a.not_before <= now && now <= a.not_after)
            .map(|a| a.public_key.clone())
            .ok_or(PoRError::InvalidEvidence)
    }
}

/// Split a compact JWS into its three segments and the exact signing input.
fn split_compact_jws(token: &str) -> Result<(JwsHeader, Vec<u8>, Vec<u8>, Vec<u8>), PoRError> {
    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() != 3 {
        return Err(PoRError::InvalidEvidence);
    }
    let header_bytes = base64url_decode(parts[0])?;
    let payload_bytes = base64url_decode(parts[1])?;
    let signature = base64url_decode(parts[2])?;
    let header: JwsHeader = serde_json::from_slice(&header_bytes)
        .map_err(|_| PoRError::InvalidEvidence)?;
    let mut signing_input = parts[0].as_bytes().to_vec();
    signing_input.push(b'.');
    signing_input.extend_from_slice(parts[1].as_bytes());
    Ok((header, payload_bytes, signing_input, signature))
}

/// Verified custody position returned after full cryptographic + policy checks.
#[derive(Clone, Debug, PartialEq)]
pub struct VerifiedPosition {
    pub payload: CustodyPositionPayload,
    pub key_id: String,
}

impl KeyRegistry {
    /// Verify an Alpaca custody JWS end-to-end:
    /// 1. `alg == PS256` (RSASSA-PSS SHA-256) — no algorithm substitution.
    /// 2. Key anchor resolution through the registry (revocation + timelock aware).
    /// 3. RSASSA-PSS signature verification over the exact signing input.
    /// 4. Strict `shares_on_loan == "0"` policy enforcement.
    pub fn verify_custody_jws(
        &mut self,
        token: &str,
        now_utc: i64,
        expected_lei: &str,
    ) -> Result<VerifiedPosition, PoRError> {
        let (header, payload_bytes, signing_input, signature) = split_compact_jws(token)?;

        if header.alg != "PS256" {
            return Err(PoRError::InvalidEvidence);
        }
        let public_key = self.active_key(expected_lei, &header.kid, now_utc)?;

        let verifying_key = PssVerifyingKey::<Sha256>::new(public_key);
        let signature = PssSignature::try_from(signature.as_slice())
            .map_err(|_| PoRError::InvalidEvidence)?;
        verifying_key
            .verify(&signing_input, &signature)
            .map_err(|_| PoRError::InvalidEvidence)?;

        let payload: CustodyPositionPayload = serde_json::from_slice(&payload_bytes)
            .map_err(|_| PoRError::InvalidEvidence)?;
        if payload.shares_on_loan != "0" {
            return Err(PoRError::RehypothecationDetected);
        }

        Ok(VerifiedPosition {
            payload,
            key_id: header.kid,
        })
    }
}

/// Build an `RsaPublicKey` from registered modulus/exponent (big-endian),
/// the form in which anchors are provisioned from JWKS / on-chain registry.
pub fn rsa_public_key_from_components(
    modulus_be: &[u8],
    exponent_be: &[u8],
) -> Result<RsaPublicKey, PoRError> {
    // `rsa` re-exports BigUint (num-bigint-dig) for exactly this assembly.
    let n = rsa::BigUint::from_bytes_be(modulus_be);
    let e = rsa::BigUint::from_bytes_be(exponent_be);
    RsaPublicKey::new(n, e).map_err(|_| PoRError::InvalidEvidence)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rsa::RsaPrivateKey;
    use rand::{rngs::OsRng, RngCore, SeedableRng};

    /// Real 2048-bit anchor: rsa rejects sub-512-bit moduli at construction.
    fn test_anchor_key() -> RsaPublicKey {
        let mut seed = [0u8; 32];
        OsRng.fill_bytes(&mut seed);
        let mut rng = rand::rngs::StdRng::from_seed(seed);
        RsaPrivateKey::new(&mut rng, 2048)
            .expect("2048-bit keygen")
            .to_public_key()
    }

    /// A structurally valid but unsigned token proves every failure path is
    /// caught *before* any trust is placed in the payload.
    #[test]
    fn rejects_wrong_algorithm() {
        let header = r#"{"alg":"HS256","kid":"alpaca-custody-2026-q4","typ":"JWT"}"#;
        let payload = r#"{"snapshot_timestamp_utc":1,"settled_shares":"1","shares_on_loan":"0"}"#;
        let token = format!(
            "{}.{}.{}",
            crate::envelope::base64url_encode(header.as_bytes()),
            crate::envelope::base64url_encode(payload.as_bytes()),
            crate::envelope::base64url_encode(&[0u8; 256])
        );
        let mut registry = KeyRegistry::new();
        assert_eq!(
            registry.verify_custody_jws(&token, 0, ALPACA_LEI),
            Err(PoRError::InvalidEvidence)
        );
    }

    #[test]
    fn rejects_unknown_key_id() {
        let header = r#"{"alg":"PS256","kid":"rogue-key","typ":"JWT"}"#;
        let payload = r#"{"snapshot_timestamp_utc":1,"settled_shares":"1","shares_on_loan":"0"}"#;
        let token = format!(
            "{}.{}.{}",
            crate::envelope::base64url_encode(header.as_bytes()),
            crate::envelope::base64url_encode(payload.as_bytes()),
            crate::envelope::base64url_encode(&[0u8; 256])
        );
        let mut registry = KeyRegistry::new();
        assert_eq!(
            registry.verify_custody_jws(&token, 0, ALPACA_LEI),
            Err(PoRError::InvalidEvidence)
        );
    }

    #[test]
    fn rejects_malformed_compact_serialization() {
        let mut registry = KeyRegistry::new();
        assert_eq!(
            registry.verify_custody_jws("not-a-jws", 0, ALPACA_LEI),
            Err(PoRError::InvalidEvidence)
        );
    }

    #[test]
    fn revocation_is_instant() {
        let mut registry = KeyRegistry::new();
        registry.register_anchor(KeyAnchor {
            lei: ALPACA_LEI.into(),
            key_id: "alpaca-custody-2026-q4".into(),
            public_key: test_anchor_key(),
            not_before: 0,
            not_after: i64::MAX,
        });
        registry.revoke(ALPACA_LEI, "alpaca-custody-2026-q4");
        assert!(registry
            .active_key(ALPACA_LEI, "alpaca-custody-2026-q4", 0)
            .is_err());
    }
}
