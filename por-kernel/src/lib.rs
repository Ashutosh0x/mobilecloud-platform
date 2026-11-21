//! FurlPay Deterministic Reconciliation Kernel.
//!
//! This crate is the **single source of financial truth** for FurlPay Proof-of-Reserve
//! mathematics. Every Acurast mesh node, the FurlPay relayer, and the AWS Nitro
//! spot-checker all execute *this exact kernel*, so identical inputs are guaranteed
//! to produce bit-identical outputs — the precondition for 3-of-5 quorum consensus.
//!
//! Design invariants (per `FURLPAY_INSTITUTIONAL_PROOF_OF_RESERVE_10_OUT_OF_10_BLUEPRINT_2026.md`):
//! 1. **No floating point.** All amounts are unsigned 128-bit integers in 18-decimal
//!    base units (ERC-20 / dShare convention); ratios are computed with checked
//!    256-bit fixed-point arithmetic in [`U256`].
//! 2. **No saturation silently.** Every arithmetic path is `checked_*`; overflow,
//!    underflow and division-by-zero are typed errors — never wrapped-around values.
//! 3. **Strictly non-negative inputs.** Liabilities and backing are `u128`; a
//!    "negative reserve" is representable only as a *classification*, not a number.
//! 4. **Explicit zero-liability handling.** Zero circulating supply is a distinct
//!    [`ReserveStatus::ZeroSupply`] state, never a `1_0000 / 0` trap.
//! 5. **RFC 8785 canonical packing.** All hashed payloads go through
//!    [`envelope::canonicalize`] so every node hashes identical bytes.

pub mod accounting;
pub mod envelope;
pub mod parsers;

use serde::{Deserialize, Serialize};

/// Basis points representing 100.00% reserve backing.
pub const HEALTHY_BPS: u32 = 10_000;
/// Basis points floor below which a reserve deficit is *confirmed* (CRITICAL).
pub const WARNING_FLOOR_BPS: u32 = 9_950;
/// Maximum evidence age (seconds) for the `HEALTHY` tier (2 hours).
pub const FRESH_MAX_SECS: u64 = 7_200;
/// Evidence age (seconds) beyond which any state degrades to `STALE` (4 hours).
pub const STALE_AFTER_SECS: u64 = 14_400;

/// Typed error space for the reconciliation kernel. `#[repr(u32)]` values are
/// part of the cross-node ABI: they must never be renumbered or reordered.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[repr(u32)]
pub enum PoRError {
    ArithmeticOverflow = 1,
    ArithmeticUnderflow = 2,
    DivisionByZero = 3,
    InvalidTimestamp = 4,
    InvalidSettlementState = 5,
    /// Custodian reports shares on loan: strictly prohibited (zero rehypothecation).
    RehypothecationDetected = 6,
    /// Evidence envelope failed canonical/digest/schema validation.
    InvalidEvidence = 7,
    /// Evidence is older than the policy TTL.
    StaleEvidence = 8,
    /// Envelope sequence number is not exactly `previous + 1` (replay attack).
    NonMonotonicSequence = 9,
}

/// The five-tier institutional reserve state machine
/// (`MOBILECLOUD_AND_FURLPAY_COMPLETE_MASTER_BLUEPRINT_2026.md`, §3 Screen 4) merged
/// with the governance rules of the 10/10 blueprint (§5).
///
/// Precedence (highest first): `FROZEN` > `CRITICAL` > `STALE` > `WARNING` > `HEALTHY`.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[repr(u32)]
pub enum ReserveStatus {
    /// Reserves >= 100.00% and evidence age < 2 hours. Unrestricted mint/burn.
    Healthy = 1,
    /// Backing 99.50%–99.99%, T+1 clearing transit active, or evidence age in
    /// [2h, 4h]. Alerts issuer treasury & custody ops; issuance continues.
    Warning = 2,
    /// Source data older than 4 hours. Automated minting restricted.
    Stale = 3,
    /// Confirmed deficit (< 99.50%). Formal regulatory notice initiated.
    Critical = 4,
    /// Contractually paused by Issuer Governance. Only issuer keys may freeze.
    Frozen = 5,
    /// Zero circulating supply with non-zero backing (freshly deployed asset).
    ZeroSupply = 6,
}

/// Checked 256-bit unsigned integer ([u64; 4] limbs, little-endian).
///
/// Ratio mathematics `backing * 10_000 / supply` overflow `u128` for realistic
/// base-unit values (an u128 backing of `3.4e38 * 10_000` wraps), hence 256 bits.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub struct U256([u64; 4]);

impl U256 {
    pub const ZERO: U256 = U256([0; 4]);

    #[inline]
    pub const fn from_u128(value: u128) -> U256 {
        U256([
            value as u64,
            (value >> 64) as u64,
            0,
            0,
        ])
    }

    #[inline]
    pub const fn from_u64(value: u64) -> U256 {
        U256([value, 0, 0, 0])
    }

    #[inline]
    pub const fn is_zero(&self) -> bool {
        // Const fn: iterator::all is not const-stable, so check limbs directly.
        self.0[0] == 0 && self.0[1] == 0 && self.0[2] == 0 && self.0[3] == 0
    }

    /// Checked addition. Returns `None` on 256-bit overflow.
    pub fn checked_add(&self, other: &U256) -> Option<U256> {
        let mut out = [0u64; 4];
        let mut carry = 0u64;
        for i in 0..4 {
            let sum = self.0[i] as u128 + other.0[i] as u128 + carry as u128;
            out[i] = sum as u64;
            carry = (sum >> 64) as u64;
        }
        if carry != 0 {
            None
        } else {
            Some(U256(out))
        }
    }

    /// Checked subtraction. Returns `None` on underflow.
    pub fn checked_sub(&self, other: &U256) -> Option<U256> {
        let mut out = [0u64; 4];
        let mut borrow = 0u128;
        for i in 0..4 {
            let lhs = self.0[i] as u128;
            let rhs = other.0[i] as u128 + borrow;
            if lhs >= rhs {
                out[i] = (lhs - rhs) as u64;
                borrow = 0;
            } else {
                out[i] = ((1u128 << 64) + lhs - rhs) as u64;
                borrow = 1;
            }
        }
        if borrow != 0 {
            None
        } else {
            Some(U256(out))
        }
    }

    /// Checked schoolbook multiplication (4x4 limbs, carry-propagating).
    /// Any product spilling beyond limb 3 is a 256-bit overflow.
    pub fn checked_mul(&self, other: &U256) -> Option<U256> {
        let mut wide = [0u64; 8];
        for i in 0..4 {
            let mut carry = 0u128;
            for j in 0..4 {
                let prod = self.0[i] as u128 * other.0[j] as u128
                    + wide[i + j] as u128
                    + carry;
                wide[i + j] = prod as u64;
                carry = prod >> 64;
            }
            wide[4 + i] = carry as u64;
        }
        if wide[4..].iter().any(|&limb| limb != 0) {
            None
        } else {
            Some(U256([wide[0], wide[1], wide[2], wide[3]]))
        }
    }

    /// Checked division. Returns `None` when `other` is zero.
    pub fn checked_div(&self, other: &U256) -> Option<U256> {
        if other.is_zero() {
            return None;
        }
        if other == &U256::from_u64(1) {
            return Some(*self);
        }
        // Binary long division, MSB-first, 256 shift-subtract steps.
        let mut quotient = U256::ZERO;
        let mut remainder = U256::ZERO;
        for bit in (0..256).rev() {
            // remainder = remainder << 1 | self.bit(bit)
            remainder = shl1(&remainder);
            let limb = bit / 64;
            let offset = bit % 64;
            if (self.0[limb as usize] >> offset) & 1 == 1 {
                remainder.0[0] |= 1;
            }
            if remainder >= *other {
                remainder = remainder.checked_sub(other).expect("remainder >= divisor");
                quotient.0[limb as usize] |= 1u64 << offset;
            }
        }
        Some(quotient)
    }

    /// Convert to `u32` if (and only if) the value fits — used for basis points.
    pub fn as_u32_checked(&self) -> Option<u32> {
        if self.0[1] != 0 || self.0[2] != 0 || self.0[3] != 0 || self.0[0] > u32::MAX as u64 {
            None
        } else {
            Some(self.0[0] as u32)
        }
    }

    /// Low 128 bits unconditionally (caller must have bounds-checked).
    #[inline]
    pub fn low_u128(&self) -> u128 {
        ((self.0[1] as u128) << 64) | self.0[0] as u128
    }

    /// Big-endian limb access: index 0 is the most significant limb.
    #[inline]
    pub fn limb_be(&self, index: usize) -> u64 {
        self.0[3 - index]
    }

    /// Construct from big-endian-ordered limbs.
    #[inline]
    pub fn from_limbs_be(limbs: [u64; 4]) -> U256 {
        U256([limbs[3], limbs[2], limbs[1], limbs[0]])
    }

    /// Convert to `u128` if (and only if) the value fits.
    pub fn as_u128_checked(&self) -> Option<u128> {
        if self.0[2] != 0 || self.0[3] != 0 {
            None
        } else {
            Some(self.low_u128())
        }
    }
}

impl PartialOrd for U256 {
    fn partial_cmp(&self, other: &Self) -> Option<core::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for U256 {
    fn cmp(&self, other: &Self) -> core::cmp::Ordering {
        for i in (0..4).rev() {
            match self.0[i].cmp(&other.0[i]) {
                core::cmp::Ordering::Equal => continue,
                non_eq => return non_eq,
            }
        }
        core::cmp::Ordering::Equal
    }
}

#[inline]
fn shl1(value: &U256) -> U256 {
    let mut out = [0u64; 4];
    let mut carry = 0u64;
    for i in 0..4 {
        out[i] = (value.0[i] << 1) | carry;
        carry = value.0[i] >> 63;
    }
    U256(out)
}

/// Inputs to the reconciliation kernel. All amounts are **base units with 18
/// decimals** (e.g. `850_000` shares = `850_000_000_000_000_000_000_000`).
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub struct ReconciliationInput {
    /// Circulating token supply summed across all 5 chains (Arbitrum, Base,
    /// Ethereum, Avalanche, Plume), net of treasury/escrow/bridge locks.
    pub onchain_supply: u128,
    /// Settled common shares at DTC / brokerage omnibus custody.
    pub settled_custody_shares: u128,
    /// Settled cash in T+1 clearing transit (shares-equivalent, confirmed NSCC).
    pub pending_deposits_transit: u128,
    /// Tokens burned on-chain whose cash wire has not yet been released.
    pub pending_redeem_transit: u128,
}

/// Deterministic reconciliation output. Every mesh node must derive the exact
/// same struct for the same input — this struct is what gets signed.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub struct ReconciliationOutput {
    pub status: ReserveStatus,
    /// Basis points: `10_000` = 100.00%.
    pub reserve_ratio_bps: u32,
    pub total_backing_base: u128,
    pub total_liabilities_base: u128,
    pub net_difference_base: u128,
}

/// The core deterministic reconciliation function (10/10 blueprint §3).
///
/// ```text
/// Total Backing     = Settled Custody Shares + Pending Deposits In Transit
/// Total Liabilities = On-chain Supply         + Pending Redemptions In Transit
/// Ratio (bps)       = Total Backing * 10_000 / Total Liabilities   (256-bit checked)
/// ```
pub fn execute_reconciliation(
    input: &ReconciliationInput,
) -> Result<ReconciliationOutput, PoRError> {
    // 1. Total backing = settled + transit deposits (checked).
    let total_backing = input
        .settled_custody_shares
        .checked_add(input.pending_deposits_transit)
        .ok_or(PoRError::ArithmeticOverflow)?;

    // 2. Total liabilities = supply + pending redemptions (checked).
    let total_liabilities = input
        .onchain_supply
        .checked_add(input.pending_redeem_transit)
        .ok_or(PoRError::ArithmeticOverflow)?;

    // 3. Explicit zero-liability boundary condition.
    if total_liabilities == 0 {
        return Ok(ReconciliationOutput {
            status: ReserveStatus::ZeroSupply,
            reserve_ratio_bps: HEALTHY_BPS,
            total_backing_base: total_backing,
            total_liabilities_base: 0,
            net_difference_base: total_backing,
        });
    }

    // 4. Basis points via checked 256-bit arithmetic:
    //    (backing * 10_000) / liabilities.
    let backing_u256 = U256::from_u128(total_backing);
    let scaled_backing = backing_u256
        .checked_mul(&U256::from_u64(HEALTHY_BPS as u64))
        .ok_or(PoRError::ArithmeticOverflow)?;
    let ratio_u256 = scaled_backing
        .checked_div(&U256::from_u128(total_liabilities))
        .ok_or(PoRError::DivisionByZero)?;

    // A ratio exceeding u32::MAX means backing > 429,496x liabilities —
    // treated as a data-integrity fault, not silently clamped.
    let reserve_ratio_bps = ratio_u256.as_u32_checked().ok_or(PoRError::ArithmeticOverflow)?;

    // 5. State classification.
    let status = if reserve_ratio_bps >= HEALTHY_BPS {
        ReserveStatus::Healthy
    } else if reserve_ratio_bps >= WARNING_FLOOR_BPS {
        ReserveStatus::Warning
    } else {
        ReserveStatus::Critical
    };

    // 6. Net difference (absolute), plain u128 — both sides already checked.
    let net_difference = if total_backing >= total_liabilities {
        total_backing - total_liabilities
    } else {
        total_liabilities - total_backing
    };

    Ok(ReconciliationOutput {
        status,
        reserve_ratio_bps,
        total_backing_base: total_backing,
        total_liabilities_base: total_liabilities,
        net_difference_base: net_difference,
    })
}

/// Applies the full **five-tier institutional state machine** on top of the raw
/// ratio, layering evidence freshness and issuer governance freeze
/// (master blueprint §3 Screen 4 + 10/10 blueprint §5).
///
/// * `frozen` — Issuer Governance contractual pause (only issuer keys may set).
/// * `evidence_age_seconds` — age of the newest source snapshot at evaluation time.
/// * `transit_active` — T+1 clearing transit counted in eligible backing.
pub fn classify_reserve_state(
    reconciliation: &ReconciliationOutput,
    evidence_age_seconds: u64,
    transit_active: bool,
    frozen: bool,
) -> ReserveStatus {
    if frozen {
        return ReserveStatus::Frozen;
    }
    // Confirmed deficit outranks staleness: a real deficit is never masked by old data.
    if reconciliation.reserve_ratio_bps < WARNING_FLOOR_BPS {
        return ReserveStatus::Critical;
    }
    if evidence_age_seconds > STALE_AFTER_SECS {
        return ReserveStatus::Stale;
    }
    if reconciliation.reserve_ratio_bps < HEALTHY_BPS
        || transit_active
        || evidence_age_seconds >= FRESH_MAX_SECS
    {
        return ReserveStatus::Warning;
    }
    ReserveStatus::Healthy
}

/// Canonical worked example from the Dinari × Anthropic case study:
/// 850,000 settled + 150,000 T+1 transit − 0 redeems = 1,000,000 backing
/// against 1,000,000 circulating dShares ⇒ 10,000 bps (HEALTHY).
pub fn ant_case_study_reference() -> (ReconciliationInput, ReconciliationOutput) {
    const SHARE: u128 = 1_000_000_000_000_000_000; // 18 decimals
    let input = ReconciliationInput {
        onchain_supply: 1_000_000 * SHARE,
        settled_custody_shares: 850_000 * SHARE,
        pending_deposits_transit: 150_000 * SHARE,
        pending_redeem_transit: 0,
    };
    let output = execute_reconciliation(&input).expect("reference case must reconcile");
    (input, output)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SHARE: u128 = 1_000_000_000_000_000_000;

    #[test]
    fn u256_checked_math_basics() {
        assert_eq!(
            U256::from_u64(u64::MAX).checked_add(&U256::from_u64(1)).unwrap(),
            U256::from_u128(1u128 << 64)
        );
        assert!(U256([u64::MAX; 4]).checked_add(&U256::from_u64(1)).is_none());
        assert!(U256::ZERO.checked_sub(&U256::from_u64(1)).is_none());
        assert!(U256::ZERO.checked_div(&U256::ZERO).is_none());
        // u128::MAX * 2 = 2^129 - 2 fits comfortably in 256 bits.
        let doubled = U256::from_u128(u128::MAX)
            .checked_mul(&U256::from_u64(2))
            .expect("2^129-2 fits in 256 bits");
        assert_eq!(doubled, U256([u64::MAX - 1, u64::MAX, 1, 0]));
        // True 256-bit overflow: (2^256 - 1) * 2.
        assert!(U256([u64::MAX; 4]).checked_mul(&U256::from_u64(2)).is_none());
    }

    #[test]
    fn u256_mul_div_roundtrip() {
        let a = U256::from_u128(0xFFFF_FFFF_FFFF_FFFF_FFFF_FFFF_FFFF_FFFFu128);
        let b = U256::from_u64(10_000);
        let product = a.checked_mul(&b).expect("fits in 256 bits");
        assert_eq!(product.checked_div(&b).unwrap(), a);
    }

    #[test]
    fn ant_case_study_is_healthy_10000_bps() {
        let (_, output) = ant_case_study_reference();
        assert_eq!(output.reserve_ratio_bps, 10_000);
        assert_eq!(output.status, ReserveStatus::Healthy);
        assert_eq!(output.net_difference_base, 0);
    }

    #[test]
    fn t1_transit_does_not_false_alarm() {
        // Naive oracle: 850,000 settled vs 1,000,000 supply = 8,500 bps deficit.
        // Settlement-aware kernel counts 150,000 shares of confirmed T+1 transit.
        let input = ReconciliationInput {
            onchain_supply: 1_000_000 * SHARE,
            settled_custody_shares: 850_000 * SHARE,
            pending_deposits_transit: 0,
            pending_redeem_transit: 0,
        };
        let output = execute_reconciliation(&input).unwrap();
        assert_eq!(output.reserve_ratio_bps, 8_500);
        assert_eq!(output.status, ReserveStatus::Critical);
    }

    #[test]
    fn zero_supply_is_distinct_state() {
        let input = ReconciliationInput {
            onchain_supply: 0,
            settled_custody_shares: 100 * SHARE,
            pending_deposits_transit: 0,
            pending_redeem_transit: 0,
        };
        let output = execute_reconciliation(&input).unwrap();
        assert_eq!(output.status, ReserveStatus::ZeroSupply);
        assert_eq!(output.reserve_ratio_bps, 10_000);
    }

    #[test]
    fn five_tier_state_machine_precedence() {
        let healthy = ReconciliationOutput {
            status: ReserveStatus::Healthy,
            reserve_ratio_bps: 10_000,
            total_backing_base: 1,
            total_liabilities_base: 1,
            net_difference_base: 0,
        };
        assert_eq!(
            classify_reserve_state(&healthy, 60, false, false),
            ReserveStatus::Healthy
        );
        // Evidence 2h–4h: healthy backing but degraded freshness -> Warning.
        assert_eq!(
            classify_reserve_state(&healthy, 9_000, false, false),
            ReserveStatus::Warning
        );
        // Evidence > 4h -> Stale.
        assert_eq!(
            classify_reserve_state(&healthy, 14_401, false, false),
            ReserveStatus::Stale
        );
        // Freeze outranks everything.
        assert_eq!(
            classify_reserve_state(&healthy, 60, false, true),
            ReserveStatus::Frozen
        );
        // Deficit outranks staleness.
        let critical = ReconciliationOutput {
            reserve_ratio_bps: 9_000,
            ..healthy
        };
        assert_eq!(
            classify_reserve_state(&critical, 99_999, false, false),
            ReserveStatus::Critical
        );
    }
}
