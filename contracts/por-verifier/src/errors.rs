//! Typed error enums for the Proof-of-Reserve contract.
//!
//! Discriminants are part of the on-chain ABI and the audit trail; they must
//! never be renumbered or reordered after deployment.
//!
//! Reference: `FURLPAY_INSTITUTIONAL_POR_PRODUCTION_SPECIFICATION_2026.md` §2.

use soroban_sdk::contracterror;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, Hash)]
#[repr(u32)]
pub enum PoRError {
    /// `initialize` was already called; the signer set is immutable
    /// except through the 48-hour timelocked rotation path.
    AlreadyInitialized = 1,
    /// A submitted signature belongs to a key outside the authorized registry.
    UnauthorizedSigner = 2,
    /// Submitted signatures are not in strictly ascending public-key order.
    /// This both blocks duplicate signers in O(N) and pins the canonical
    /// signature ordering to make the digest unambiguous.
    SignerOrderInvalid = 3,
    /// Fewer valid signatures than the configured M-of-N threshold.
    ThresholdNotMet = 4,
    /// Sequence number is not exactly `last + 1` — replay / gap / reorder.
    InvalidSequenceNumber = 5,
    /// `valid_until` has passed relative to the current ledger timestamp.
    AttestationExpired = 6,
    /// Checked 256-bit math overflowed during the independent ratio calculation.
    ArithmeticOverflow = 7,
    /// Threshold or signer-set arguments are self-inconsistent.
    InvalidConfiguration = 8,
    /// Asset is under an issuer-governance freeze; attestations are refused.
    AssetFrozen = 9,
    /// Governance call (freeze / unfreeze / rotation) not signed by the admin.
    UnauthorizedGovernance = 10,
    /// Evidence epoch is older than the staleness bound relative to `epoch_timestamp`.
    EvidenceStale = 11,
    /// Governance policy arguments violate `0 < warning_floor < healthy <= 10_000`.
    InvalidPolicyParams = 12,
}
