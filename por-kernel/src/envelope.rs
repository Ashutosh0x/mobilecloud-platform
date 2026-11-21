//! RFC 8785 (JSON Canonicalization Scheme) Evidence Envelope.
//!
//! Implements the standardized, versioned evidence envelope v2026.1
//! (`FURLPAY_INSTITUTIONAL_POR_PRODUCTION_SPECIFICATION_2026.md` §1 and
//! master blueprint §8.1). The canonical form produced by [`canonicalize`]
//! is the *exact byte string* hashed by every mesh node, so JCS compliance is
//! a security property, not a formatting preference.
//!
//! Supported JSON domain: objects, arrays, strings, booleans, `null`, and
//! integers that fit `i128`/`u64`. Per the envelope schema all monetary
//! amounts are transported as **strings of base units** (never IEEE-754
//! doubles), so canonical number formatting for floats is deliberately
//! rejected rather than approximated.

use serde_json::{Map, Number, Value};
use sha2::{Digest, Sha256};

use crate::PoRError;

/// Maximum envelope lifetime: 2 hours (master blueprint §8.1 `valid_until_utc`).
pub const MAX_ENVELOPE_TTL_SECS: i64 = 7_200;
/// Envelope schema version handled by this implementation.
pub const SCHEMA_VERSION: &str = "2026.1";

/// Canonical JSON serialization per RFC 8785 (JCS).
///
/// * Object keys sorted lexicographically by **UTF-16 code units** (§3.2.3).
/// * Strings escaped with the minimal JSON set; control chars use the
///   short forms `\b \t \n \f \r`, others `\u00xx` lowercase hex (§3.2.2.2).
/// * Non-ASCII emitted as raw UTF-8.
/// * Numbers restricted to integers in ECMAScript representation; IEEE-754
///   non-integral values are rejected (`PoRError::InvalidEvidence`) because
///   the financial domain mandates string base units.
pub fn canonicalize(value: &Value) -> Result<String, PoRError> {
    let mut out = String::new();
    write_canonical(value, &mut out)?;
    Ok(out)
}

fn write_canonical(value: &Value, out: &mut String) -> Result<(), PoRError> {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(true) => out.push_str("true"),
        Value::Bool(false) => out.push_str("false"),
        Value::Number(n) => write_number(n, out)?,
        Value::String(s) => write_escaped_string(s, out)?,
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_canonical(item, out)?;
            }
            out.push(']');
        }
        Value::Object(map) => {
            // Sort keys by UTF-16 code units, as RFC 8785 §3.2.3 mandates
            // (this differs from Unicode-scalar sorting for astral characters).
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_by(|a, b| {
                let a_utf16 = a.encode_utf16().collect::<Vec<u16>>();
                let b_utf16 = b.encode_utf16().collect::<Vec<u16>>();
                a_utf16.cmp(&b_utf16)
            });
            out.push('{');
            for (i, key) in keys.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_escaped_string(key, out)?;
                out.push(':');
                write_canonical(&map[*key], out)?;
            }
            out.push('}');
        }
    }
    Ok(())
}

fn write_number(n: &Number, out: &mut String) -> Result<(), PoRError> {
    if let Some(i) = n.as_i64() {
        out.push_str(&i.to_string());
        return Ok(());
    }
    if let Some(u) = n.as_u64() {
        out.push_str(&u.to_string());
        return Ok(());
    }
    // Integers beyond u64 but within i128 (transported via arbitrary-precision
    // JSON only if the caller enabled it; serde_json's default Value::Number
    // cannot hold these, so reaching here means a float).
    Err(PoRError::InvalidEvidence)
}

fn write_escaped_string(s: &str, out: &mut String) -> Result<(), PoRError> {
    out.push('"');
    // Iterate Unicode scalar values directly: a Rust `String` is UTF-8 and
    // therefore can never contain lone surrogates, so each scalar is either
    // an ASCII escape case or emitted as raw UTF-8 — exactly RFC 8785 §3.2.2.2.
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{08}' => out.push_str("\\b"),
            '\u{09}' => out.push_str("\\t"),
            '\u{0A}' => out.push_str("\\n"),
            '\u{0C}' => out.push_str("\\f"),
            '\u{0D}' => out.push_str("\\r"),
            c if (c as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => out.push(c),
        }
    }
    out.push('"');
    Ok(())
}

// ---------------------------------------------------------------------------
// Base64url (RFC 4648 §5, unpadded) — used by JWS / XMLDSig parsing.
// ---------------------------------------------------------------------------

const B64URL_ALPHABET: &[u8; 64] =
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

pub fn base64url_encode(data: &[u8]) -> String {
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(B64URL_ALPHABET[(triple >> 18) as usize & 0x3F] as char);
        out.push(B64URL_ALPHABET[(triple >> 12) as usize & 0x3F] as char);
        if chunk.len() > 1 {
            out.push(B64URL_ALPHABET[(triple >> 6) as usize & 0x3F] as char);
        }
        if chunk.len() > 2 {
            out.push(B64URL_ALPHABET[triple as usize & 0x3F] as char);
        }
    }
    out
}

pub fn base64url_decode(input: &str) -> Result<Vec<u8>, PoRError> {
    let mut out = Vec::with_capacity(input.len() * 3 / 4);
    let mut acc: u32 = 0;
    let mut bits = 0u32;
    for ch in input.chars() {
        if ch == '=' {
            break; // tolerate padded input
        }
        let v = match ch {
            'A'..='Z' => ch as u32 - 'A' as u32,
            'a'..='z' => ch as u32 - 'a' as u32 + 26,
            '0'..='9' => ch as u32 - '0' as u32 + 52,
            // Tolerate both the base64url alphabet (RFC 4648 §5) and the
            // standard alphabet emitted by some JWKS tooling.
            '-' | '+' => 62,
            '_' | '/' => 63,
            _ => return Err(PoRError::InvalidEvidence),
        };
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// SHA-256 helpers (canonical payload digesting).
// ---------------------------------------------------------------------------

pub fn sha256_hex(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    hex::encode(hasher.finalize())
}

/// Normalize a hash field that may carry a `0x` prefix and mixed case.
pub fn normalize_hash_field(field: &str) -> String {
    field
        .strip_prefix("0x")
        .or_else(|| field.strip_prefix("0X"))
        .unwrap_or(field)
        .to_ascii_lowercase()
}

// ---------------------------------------------------------------------------
// Evidence Envelope v2026.1 — schema, assembly, and validation.
// ---------------------------------------------------------------------------

/// `header` block per master blueprint §8.1.
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct EnvelopeHeader {
    pub schema_version: String,
    pub envelope_id: String,
    pub asset_identifier: AssetIdentifier,
    pub source_entity: SourceEntity,
    pub signature_algorithm: String,
}

#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct AssetIdentifier {
    pub cusip: String,
    pub isin: String,
    /// `symbol` (ANT, NVDA) or `ticker` (production-spec naming) accepted.
    #[serde(alias = "ticker")]
    pub symbol: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stellar_sac_address: Option<String>,
}

#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct SourceEntity {
    pub lei: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub swift_bic: Option<String>,
    pub sec_cik: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entity_type: Option<String>,
}

/// `payload` block — every monetary amount is a **string** of 18-decimal base units.
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct EnvelopePayload {
    pub snapshot_timestamp_utc: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accounting_epoch_id: Option<String>,
    pub settled_shares: String,
    #[serde(default, alias = "transit_cash_in_usd")]
    pub transit_cash_in_usd: String,
    #[serde(default, alias = "transit_redeem_shares")]
    pub pending_redeem_shares: String,
    /// Certified condition: must be strictly `"0"` (zero rehypothecation).
    pub shares_on_loan: String,
    /// e.g. `SEC_RULE_15C3_3_OMNIBUS`.
    pub segregation_status: String,
    pub currency: String,
}

/// `integrity` block.
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct EnvelopeIntegrity {
    pub sequence_number: u64,
    pub valid_until_utc: i64,
    pub canonical_payload_hash: String,
    pub source_signature: String,
}

#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct EvidenceEnvelope {
    pub header: EnvelopeHeader,
    pub payload: EnvelopePayload,
    pub integrity: EnvelopeIntegrity,
}

impl EvidenceEnvelope {
    /// Assemble a fresh envelope and seal it: compute the canonical payload
    /// digest (RFC 8785 + SHA-256) and apply the policy 2-hour TTL.
    pub fn seal(
        header: EnvelopeHeader,
        payload: EnvelopePayload,
        sequence_number: u64,
        source_signature: String,
        now_utc: i64,
    ) -> Result<EvidenceEnvelope, PoRError> {
        if now_utc < 0 {
            return Err(PoRError::InvalidTimestamp);
        }
        let payload_value = serde_json::to_value(&payload)
            .map_err(|_| PoRError::InvalidEvidence)?;
        let digest = sha256_hex(canonicalize(&payload_value)?.as_bytes());
        Ok(EvidenceEnvelope {
            header,
            payload,
            integrity: EnvelopeIntegrity {
                sequence_number,
                valid_until_utc: now_utc + MAX_ENVELOPE_TTL_SECS,
                canonical_payload_hash: format!("0x{digest}"),
                source_signature,
            },
        })
    }

    /// Full machine validation of an ingested envelope against the v2026.1
    /// policy: schema version, TTL, digest recomputation, and the strict
    /// `shares_on_loan == 0` rehypothecation ban.
    pub fn validate(&self, now_utc: i64) -> Result<(), PoRError> {
        // 1. Schema version pin.
        if self.header.schema_version != SCHEMA_VERSION {
            return Err(PoRError::InvalidEvidence);
        }
        // 2. TTL bounds: valid_until must be within [now, snapshot + 7200].
        if self.integrity.valid_until_utc < now_utc {
            return Err(PoRError::StaleEvidence);
        }
        if self.integrity.valid_until_utc - self.payload.snapshot_timestamp_utc
            > MAX_ENVELOPE_TTL_SECS
        {
            return Err(PoRError::InvalidEvidence);
        }
        if self.payload.snapshot_timestamp_utc < 0 {
            return Err(PoRError::InvalidTimestamp);
        }
        // 3. Recompute the canonical payload digest — any byte-level drift
        //    (field reordering, float formatting) invalidates the envelope.
        let payload_value = serde_json::to_value(&self.payload)
            .map_err(|_| PoRError::InvalidEvidence)?;
        let recomputed = sha256_hex(canonicalize(&payload_value)?.as_bytes());
        if normalize_hash_field(&self.integrity.canonical_payload_hash) != recomputed {
            return Err(PoRError::InvalidEvidence);
        }
        // 4. Strict zero rehypothecation (Four Proofs: legal entitlement).
        if self.payload.shares_on_loan != "0" {
            return Err(PoRError::RehypothecationDetected);
        }
        // 5. Amount strings must parse as non-negative integers.
        for (amount, _) in [
            (&self.payload.settled_shares, "settled_shares"),
            (&self.payload.transit_cash_in_usd, "transit_cash_in_usd"),
            (&self.payload.pending_redeem_shares, "pending_redeem_shares"),
            (&self.payload.shares_on_loan, "shares_on_loan"),
        ] {
            if amount.is_empty() || !amount.bytes().all(|b| b.is_ascii_digit()) {
                return Err(PoRError::InvalidEvidence);
            }
            let _ = amount;
        }
        Ok(())
    }

    /// Enforce monotonic sequence numbers against the previously consumed
    /// envelope for this asset (replay defense; on-chain contract re-checks).
    pub fn validate_monotonic(&self, last_sequence: u64) -> Result<(), PoRError> {
        if self.integrity.sequence_number != last_sequence.wrapping_add(1) || last_sequence == u64::MAX {
            return Err(PoRError::NonMonotonicSequence);
        }
        Ok(())
    }

    /// The canonical bytes over which the source entity's cryptographic
    /// signature is computed (header.digest binding).
    pub fn canonical_source_message(&self) -> Result<Vec<u8>, PoRError> {
        let mut map = Map::new();
        map.insert("canonical_payload_hash".into(), Value::String(self.integrity.canonical_payload_hash.clone()));
        map.insert("sequence_number".into(), Value::from(self.integrity.sequence_number));
        map.insert("snapshot_timestamp_utc".into(), Value::from(self.payload.snapshot_timestamp_utc));
        let canonical = canonicalize(&Value::Object(map))?;
        Ok(canonical.into_bytes())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonicalizes_keys_by_utf16_code_units() {
        let mut obj = Map::new();
        obj.insert("z".into(), Value::from(1));
        obj.insert("Z".into(), Value::from(2));
        obj.insert("aa".into(), Value::from(3));
        obj.insert("a".into(), Value::from(4));
        let canon = canonicalize(&Value::Object(obj)).unwrap();
        // RFC 8785 sorts by UTF-16 code units: 'Z' (0x5A) < 'a' (0x61).
        assert_eq!(canon, r#"{"Z":2,"a":4,"aa":3,"z":1}"#);
    }

    #[test]
    fn canonicalizes_string_escapes() {
        let v = Value::String("a\"b\\c\nd\te\u{1}ok".into());
        assert_eq!(
            canonicalize(&v).unwrap(),
            "\"a\\\"b\\\\c\\nd\\te\\u0001ok\""
        );
    }

    #[test]
    fn canonical_form_is_byte_stable_across_field_order() {
        let a: Value = serde_json::from_str(r#"{"b":1,"a":{"y":true,"x":null}}"#).unwrap();
        let b: Value = serde_json::from_str(r#"{"a":{"x":null,"y":true},"b":1}"#).unwrap();
        assert_eq!(canonicalize(&a).unwrap(), canonicalize(&b).unwrap());
    }

    #[test]
    fn base64url_roundtrip() {
        let data: Vec<u8> = (0u8..=255).collect();
        let encoded = base64url_encode(&data);
        assert_eq!(base64url_decode(&encoded).unwrap(), data);
        assert!(!encoded.contains('+') && !encoded.contains('/'));
    }

    fn sample_header() -> EnvelopeHeader {
        EnvelopeHeader {
            schema_version: "2026.1".into(),
            envelope_id: "urn:uuid:f81d4fae-7dec-11d0-a765-00a0c91e6bf6".into(),
            asset_identifier: AssetIdentifier {
                cusip: "03662Q105".into(),
                isin: "US03662Q1058".into(),
                symbol: "ANT".into(),
                stellar_sac_address: None,
            },
            source_entity: SourceEntity {
                lei: "5493006MHB84DD0ZWV18".into(),
                swift_bic: Some("ALPACU33XXX".into()),
                sec_cik: "0001777934".into(),
                entity_type: Some("QUALIFIED_CUSTODIAN".into()),
            },
            signature_algorithm: "RSA_PSS_SHA256".into(),
        }
    }

    fn sample_payload() -> EnvelopePayload {
        EnvelopePayload {
            snapshot_timestamp_utc: 1_774_087_200,
            accounting_epoch_id: Some("20261119-16".into()),
            settled_shares: "850000000000000000000000".into(),
            transit_cash_in_usd: "52500000000000000000000000".into(),
            pending_redeem_shares: "0".into(),
            shares_on_loan: "0".into(),
            segregation_status: "SEC_RULE_15C3_3_OMNIBUS".into(),
            currency: "USD".into(),
        }
    }

    #[test]
    fn seal_then_validate_roundtrip() {
        let env = EvidenceEnvelope::seal(sample_header(), sample_payload(), 108422, "sig".into(), 1_774_087_200)
            .unwrap();
        assert_eq!(env.integrity.sequence_number, 108422);
        assert_eq!(
            env.integrity.valid_until_utc - env.payload.snapshot_timestamp_utc,
            MAX_ENVELOPE_TTL_SECS
        );
        env.validate(1_774_087_300).unwrap();
    }

    #[test]
    fn tampered_payload_fails_digest_check() {
        let mut env =
            EvidenceEnvelope::seal(sample_header(), sample_payload(), 1, "sig".into(), 1_774_087_200).unwrap();
        env.payload.settled_shares = "1".into();
        assert_eq!(env.validate(1_774_087_300), Err(PoRError::InvalidEvidence));
    }

    #[test]
    fn expired_envelope_is_stale() {
        let env =
            EvidenceEnvelope::seal(sample_header(), sample_payload(), 1, "sig".into(), 1_774_087_200).unwrap();
        let late = env.integrity.valid_until_utc + 1;
        assert_eq!(env.validate(late), Err(PoRError::StaleEvidence));
    }

    #[test]
    fn rehypothecated_payload_rejected() {
        let mut payload = sample_payload();
        payload.shares_on_loan = "5000".into();
        let env = EvidenceEnvelope::seal(sample_header(), payload, 1, "sig".into(), 1_774_087_200).unwrap();
        assert_eq!(
            env.validate(1_774_087_300),
            Err(PoRError::RehypothecationDetected)
        );
    }

    #[test]
    fn monotonic_sequence_enforced() {
        let env = EvidenceEnvelope::seal(sample_header(), sample_payload(), 5, "sig".into(), 1_774_087_200).unwrap();
        assert!(env.validate_monotonic(4).is_ok());
        assert_eq!(env.validate_monotonic(6), Err(PoRError::NonMonotonicSequence));
        assert_eq!(env.validate_monotonic(4), Ok(()));
        // Replay of an already-consumed sequence must fail.
        assert_eq!(env.validate_monotonic(5), Err(PoRError::NonMonotonicSequence));
    }

    #[test]
    fn master_blueprint_example_envelope_parses() {
        // The exact §8.1 schema shape from the master blueprint.
        let raw = r#"{
          "header": {
            "schema_version": "2026.1",
            "envelope_id": "urn:uuid:f81d4fae-7dec-11d0-a765-00a0c91e6bf6",
            "asset_identifier": { "cusip": "03662Q105", "isin": "US03662Q1058", "symbol": "ANT" },
            "source_entity": { "lei": "5493006MHB84DD0ZWV18", "sec_cik": "0001777934" },
            "signature_algorithm": "RSA_PSS_SHA256"
          },
          "payload": {
            "snapshot_timestamp_utc": 1774087200,
            "settled_shares": "850000000000000000000000",
            "transit_cash_in_usd": "52500000000000000000000000",
            "shares_on_loan": "0",
            "segregation_status": "SEC_RULE_15C3_3_OMNIBUS",
            "currency": "USD"
          },
          "integrity": {
            "sequence_number": 108422,
            "valid_until_utc": 1774094400,
            "canonical_payload_hash": "0xdeadbeef",
            "source_signature": "0x89ab"
          }
        }"#;
        let env: EvidenceEnvelope = serde_json::from_str(raw).unwrap();
        assert_eq!(env.header.asset_identifier.symbol, "ANT");
        // Digest check fails (example placeholder hash), which proves the
        // validation path actively recomputes rather than trusting input.
        assert_eq!(env.validate(1_774_087_300), Err(PoRError::InvalidEvidence));
    }
}
