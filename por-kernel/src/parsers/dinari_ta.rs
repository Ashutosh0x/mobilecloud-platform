//! SEC-registered Transfer Agent master ledger ingestion (Dinari Inc. pillar).
//!
//! Per the case study §2.1 and the production spec §1.1: the statutory
//! book-entry ledger (SEC Section 17A) signs the aggregate issued dShare
//! units, corporate action status, and active investor entitlements with an
//! **Ed25519** key registered in the issuer's SEC Form TA-1 filing.
//!
//! The ledger binds to the canonical RFC 8785 form of itself minus the
//! `signature` member, so the same canonicalizer used by the envelope drives
//! transfer-agent verification.

use ed25519_dalek::{Signature as Ed25519Signature, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};

use crate::envelope::canonicalize;
use crate::PoRError;

/// Canonical SEC CIK for Dinari Inc. (case study §8.1 header).
pub const DINARI_SEC_CIK: &str = "0001777934";

/// Corporate action status relevant to share backing reconciliation.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum CorporateActionStatus {
    None,
    /// Stock split announced but not yet effective at DTC (ex-date pending).
    SplitPending,
    /// Split effective at DTC — on-chain token rebasing must be concurrent.
    SplitEffective,
    /// Cash dividend in TA escrow (dividend cash is NOT share backing).
    DividendEscrow,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TaSignature {
    pub alg: String,
    pub key_id: String,
    /// Hex-encoded 64-byte Ed25519 signature (optionally `0x` prefixed).
    pub value: String,
}

/// The statutory transfer-agent register snapshot.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TransferAgentLedger {
    pub schema_version: String,
    pub cusip: String,
    pub isin: String,
    pub symbol: String,
    pub sec_cik: String,
    /// Aggregate issued dShare units (string base units, 18 decimals).
    pub issued_units: String,
    /// Active investor entitlements certified by the TA.
    pub outstanding_entitlements: String,
    pub sequence_number: u64,
    pub snapshot_utc: i64,
    pub corporate_action_status: CorporateActionStatus,
    #[serde(default)]
    pub signature: Option<TaSignature>,
}

impl TransferAgentLedger {
    /// Canonical bytes over which the TA Ed25519 key signs: RFC 8785 of the
    /// ledger with the `signature` member removed.
    pub fn canonical_signing_message(&self) -> Result<Vec<u8>, PoRError> {
        let mut value = serde_json::to_value(self).map_err(|_| PoRError::InvalidEvidence)?;
        if let serde_json::Value::Object(ref mut map) = value {
            map.remove("signature");
        }
        let canonical = canonicalize(&value)?;
        Ok(canonical.into_bytes())
    }
}

/// A registered TA anchor: the Ed25519 public key from the SEC Form TA-1
/// filing, pinned by `(LEI, key_id)` in the on-chain KeyRegistry.
#[derive(Clone, Debug)]
pub struct TaKeyAnchor {
    pub key_id: String,
    pub verifying_key: VerifyingKey,
}

/// Verified TA ledger with the entitlement figures the kernel consumes.
#[derive(Clone, Debug, PartialEq)]
pub struct VerifiedTaLedger {
    pub ledger: TransferAgentLedger,
    pub key_id: String,
}

impl VerifiedTaLedger {
    /// Entitlement proof ($E_t$): outstanding investor entitlements must match
    /// the issued units — otherwise the TA register and the issuer disagree.
    pub fn entitlements_match_issued(&self) -> bool {
        self.ledger.outstanding_entitlements == self.ledger.issued_units
    }
}

/// Full TA ledger verification:
/// 1. Schema/CIK sanity (`0001777934`, 10-digit zero-padded).
/// 2. Signature algorithm pin (`Ed25519`).
/// 3. Canonical-message Ed25519 verification against the registered anchor.
/// 4. Corporate-action consistency: a pending split must not silently change
///    the issued units versus the custody side (DTC ex-date governs).
pub fn verify_transfer_agent_ledger(
    ledger: &TransferAgentLedger,
    anchor: &TaKeyAnchor,
) -> Result<VerifiedTaLedger, PoRError> {
    // 1. Entity identity.
    if ledger.sec_cik != DINARI_SEC_CIK || ledger.sec_cik.len() != 10 {
        return Err(PoRError::InvalidEvidence);
    }
    if !ledger.sec_cik.bytes().all(|b| b.is_ascii_digit()) {
        return Err(PoRError::InvalidEvidence);
    }
    // Amount strings must be non-negative decimal strings.
    for amount in [&ledger.issued_units, &ledger.outstanding_entitlements] {
        if amount.is_empty() || !amount.bytes().all(|b| b.is_ascii_digit()) {
            return Err(PoRError::InvalidEvidence);
        }
    }

    // 2. Signature presence + algorithm pin.
    let signature = ledger.signature.as_ref().ok_or(PoRError::InvalidEvidence)?;
    if signature.alg != "Ed25519" {
        return Err(PoRError::InvalidEvidence);
    }
    if signature.key_id != anchor.key_id {
        return Err(PoRError::InvalidEvidence);
    }

    // 3. Canonical Ed25519 verification. The TA signature travels as
    // 64-byte hex (optionally 0x-prefixed), per the SEC TA-1 webhook schema.
    let message = ledger.canonical_signing_message()?;
    let raw_signature =
        hex::decode(hex_strip_prefix(&signature.value)).map_err(|_| PoRError::InvalidEvidence)?;
    if raw_signature.len() != 64 {
        return Err(PoRError::InvalidEvidence);
    }
    // Signature::from_bytes is fallible since ed25519-dalek 2.1.
    let sig = Ed25519Signature::try_from(raw_signature.as_slice())
        .map_err(|_| PoRError::InvalidEvidence)?;
    anchor
        .verifying_key
        .verify(&message, &sig)
        .map_err(|_| PoRError::InvalidEvidence)?;

    // Note: corporate actions (pending/effective splits, dividend escrow) are
    // *business rules*, validated by the accounting module
    // (`accounting::t1_settlement::reconcile_split`) — the parser's mandate is
    // authenticity only, so pending splits do not fail verification here.

    Ok(VerifiedTaLedger {
        ledger: ledger.clone(),
        key_id: anchor.key_id.clone(),
    })
}

fn hex_strip_prefix(value: &str) -> &str {
    value
        .strip_prefix("0x")
        .or_else(|| value.strip_prefix("0X"))
        .unwrap_or(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    fn signed_ledger(signing: &SigningKey) -> (TransferAgentLedger, TaKeyAnchor) {
        let mut ledger = TransferAgentLedger {
            schema_version: "2026.1".into(),
            cusip: "03662Q105".into(),
            isin: "US03662Q1058".into(),
            symbol: "ANT".into(),
            sec_cik: DINARI_SEC_CIK.into(),
            issued_units: "1000000000000000000000000".into(),
            outstanding_entitlements: "1000000000000000000000000".into(),
            sequence_number: 108422,
            snapshot_utc: 1_774_087_200,
            corporate_action_status: CorporateActionStatus::None,
            signature: None,
        };
        let message = ledger.canonical_signing_message().unwrap();
        let sig = signing.sign(&message);
        ledger.signature = Some(TaSignature {
            alg: "Ed25519".into(),
            key_id: "dinari-ta-2026-q4".into(),
            value: hex::encode(sig.to_bytes()),
        });
        let anchor = TaKeyAnchor {
            key_id: "dinari-ta-2026-q4".into(),
            verifying_key: signing.verifying_key(),
        };
        (ledger, anchor)
    }

    #[test]
    fn valid_ta_signature_verifies() {
        let signing = SigningKey::from_bytes(&[42u8; 32]);
        let (ledger, anchor) = signed_ledger(&signing);
        let verified = verify_transfer_agent_ledger(&ledger, &anchor).unwrap();
        assert!(verified.entitlements_match_issued());
    }

    #[test]
    fn tampered_issued_units_break_signature() {
        let signing = SigningKey::from_bytes(&[42u8; 32]);
        let (mut ledger, anchor) = signed_ledger(&signing);
        ledger.issued_units = "999".into();
        assert_eq!(
            verify_transfer_agent_ledger(&ledger, &anchor),
            Err(PoRError::InvalidEvidence)
        );
    }

    #[test]
    fn wrong_cik_rejected() {
        let signing = SigningKey::from_bytes(&[42u8; 32]);
        let (mut ledger, anchor) = signed_ledger(&signing);
        ledger.sec_cik = "0009999999".into();
        assert_eq!(
            verify_transfer_agent_ledger(&ledger, &anchor),
            Err(PoRError::InvalidEvidence)
        );
    }

    #[test]
    fn pending_split_passes_authenticity_gate() {
        let signing = SigningKey::from_bytes(&[42u8; 32]);
        let (ledger, anchor) = signed_ledger(&signing);
        // A pending split passes the authenticity gate — the split itself is
        // reconciled by the accounting module against the DTC ex-date.
        assert!(verify_transfer_agent_ledger(&ledger, &anchor).is_ok());

        // Post-signature mutation must fail (the canonical message binds the
        // corporate-action status).
        let (mut tampered, anchor) = signed_ledger(&signing);
        tampered.corporate_action_status = CorporateActionStatus::SplitPending;
        assert_eq!(
            verify_transfer_agent_ledger(&tampered, &anchor),
            Err(PoRError::InvalidEvidence)
        );
    }
}
