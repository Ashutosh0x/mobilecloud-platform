//! Ed25519 device identity, signature verification, and enrollment tokens.
//!
//! Device keys are used to authenticate heartbeats and to bind a physical
//! device to a stable [`crate::node::NodeId`] during enrollment.  All parsing
//! paths fail closed: any malformed input results in a negative verification
//! result rather than a panic.

use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use sha2::{Digest, Sha256};

/// An Ed25519 device identity (signing key) with helper accessors.
#[derive(Clone)]
pub struct DeviceIdentity {
    signing: SigningKey,
}

impl DeviceIdentity {
    /// Generate a fresh random identity from the operating system CSPRNG.
    pub fn generate() -> Self {
        let mut rng = rand::rngs::OsRng;
        Self {
            signing: SigningKey::generate(&mut rng),
        }
    }

    /// Deterministically construct an identity from a 32-byte seed.
    pub fn from_seed(seed: [u8; 32]) -> Self {
        Self {
            signing: SigningKey::from_bytes(&seed),
        }
    }

    /// Lowercase hex encoding of the 32-byte public (verifying) key.
    pub fn public_key_hex(&self) -> String {
        hex::encode(self.verifying_key_bytes())
    }

    /// Lowercase hex encoding of the SHA-256 digest of the verifying key bytes.
    ///
    /// This yields a stable 64-hex-character fingerprint suitable for display
    /// and out-of-band comparison.
    pub fn fingerprint(&self) -> String {
        let digest = Sha256::digest(self.verifying_key_bytes());
        hex::encode(digest)
    }

    /// Sign `msg`, returning the raw 64-byte Ed25519 signature.
    pub fn sign(&self, msg: &[u8]) -> [u8; 64] {
        self.signing.sign(msg).to_bytes()
    }

    fn verifying_key_bytes(&self) -> [u8; 32] {
        self.signing.verifying_key().to_bytes()
    }
}

/// Verify an Ed25519 signature against a hex-encoded public key.
///
/// Returns `false` on any parse or verification error (fail closed).
pub fn verify_signature(public_key_hex: &str, msg: &[u8], signature: &[u8; 64]) -> bool {
    let key_bytes: [u8; 32] = match hex::decode(public_key_hex) {
        Ok(bytes) => match bytes.try_into() {
            Ok(arr) => arr,
            Err(_) => return false,
        },
        Err(_) => return false,
    };

    let Ok(verifying_key) = VerifyingKey::from_bytes(&key_bytes) else {
        return false;
    };

    let signature = Signature::from_bytes(signature);
    verifying_key.verify_strict(msg, &signature).is_ok()
}

/// A shared secret presented by a device during enrollment.
#[derive(Debug, Clone)]
pub struct EnrollmentToken(pub String);

impl EnrollmentToken {
    pub fn new(s: String) -> Self {
        Self(s)
    }

    /// Constant-time comparison of the stored token against `presented`.
    ///
    /// The comparison avoids data-dependent early returns: the length
    /// difference is folded into the accumulator and every byte of the shorter
    /// input is always visited.
    pub fn matches(&self, presented: &str) -> bool {
        ct_eq(&self.0, presented)
    }
}

/// Constant-time string equality.
///
/// Length differences and byte differences are accumulated into a single value
/// that is only inspected once at the end, so no early exit leaks where the
/// first mismatch occurred.
pub fn ct_eq(a: &str, b: &str) -> bool {
    let a = a.as_bytes();
    let b = b.as_bytes();

    let mut diff: u8 = (a.len() ^ b.len()) as u8;
    let n = a.len().min(b.len());
    for i in 0..n {
        diff |= a[i] ^ b[i];
    }
    diff == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sign_verify_roundtrip() {
        let identity = DeviceIdentity::from_seed([7u8; 32]);
        let msg = b"enroll:node-1:1";
        let sig = identity.sign(msg);
        assert!(verify_signature(&identity.public_key_hex(), msg, &sig));
    }

    #[test]
    fn tampered_message_fails() {
        let identity = DeviceIdentity::from_seed([7u8; 32]);
        let sig = identity.sign(b"enroll:node-1:1");
        assert!(!verify_signature(
            &identity.public_key_hex(),
            b"enroll:node-1:2",
            &sig
        ));
    }

    #[test]
    fn fingerprint_is_deterministic_and_64_hex_chars() {
        let a = DeviceIdentity::from_seed([9u8; 32]);
        let b = DeviceIdentity::from_seed([9u8; 32]);
        assert_eq!(a.fingerprint(), b.fingerprint());
        assert_eq!(a.fingerprint().len(), 64);
        assert!(a.fingerprint().chars().all(|c| c.is_ascii_hexdigit()));
        // Different seed -> different fingerprint.
        let c = DeviceIdentity::from_seed([10u8; 32]);
        assert_ne!(a.fingerprint(), c.fingerprint());
    }

    #[test]
    fn malformed_public_key_fails_closed() {
        let identity = DeviceIdentity::from_seed([7u8; 32]);
        let sig = identity.sign(b"hello");
        assert!(!verify_signature("not-hex", b"hello", &sig));
        assert!(!verify_signature("00", b"hello", &sig));
    }

    #[test]
    fn enrollment_token_matches() {
        let token = EnrollmentToken::new("s3cret".into());
        assert!(token.matches("s3cret"));
        assert!(!token.matches("s3cre"));
        assert!(!token.matches("s3cretx"));
        assert!(!token.matches(""));
        assert!(!token.matches("S3CRET"));
    }

    #[test]
    fn ct_eq_basic() {
        assert!(ct_eq("abc", "abc"));
        assert!(!ct_eq("abc", "abd"));
        assert!(!ct_eq("abc", "ab"));
        assert!(ct_eq("", ""));
    }
}
