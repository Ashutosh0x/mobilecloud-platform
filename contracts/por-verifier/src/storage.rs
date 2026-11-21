//! Partitioned epoch & asset storage keys (master blueprint §2, `storage.rs`).
//!
//! Storage layout discipline:
//! * `Instance` storage: contract-level configuration (signers, threshold,
//!   admin) — read on every attestation, kept minimal for fee efficiency.
//! * `Persistent` storage: per-asset state (last sequence, latest record,
//!   status, freeze flag) — survives indefinitely with TTL renewal.
//!
//! Every per-asset key is partitioned by `Symbol` so multiple assets (ANT,
//! SPACE, NVDA …) share one contract without key collisions.

use soroban_sdk::{contracttype, symbol_short, Env, Symbol};

/// Instance-level configuration keys.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ConfigKey {
    /// Authorized Acurast node Ed25519 public keys, stored ascending.
    Signers,
    /// M-of-N threshold (3-of-5 baseline; 5-of-7 escalations happen off-chain
    /// before submission — the contract enforces the minimum).
    Threshold,
    /// Governance key authorized to freeze/unfreeze assets.
    Admin,
}

/// Per-asset persistent state keys, partitioned by asset symbol.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    /// Last consumed attestation sequence number for the asset.
    LastSequence(Symbol),
    /// The most recent verified [`AttestationRecord`].
    LatestRecord(Symbol),
    /// The most recent published status symbol (HEALTHY / WARNING / CRITICAL / STALE).
    AssetStatus(Symbol),
    /// Issuer-governance freeze flag (true ⇒ FROZEN, attestations refused).
    AssetFrozen(Symbol),
    /// Governance-configured tier boundaries (Gate 7); absent ⇒ [`DEFAULT_POLICY`].
    AssetPolicy(Symbol),
}

/// Governance-configurable solvency tier boundaries for one asset (Gate 7).
///
/// Classification (equality semantics are contractual and test-pinned):
/// `ratio >= healthy_bps ⇒ HEALTHY`, `warning_floor_bps <= ratio < healthy_bps ⇒
/// WARNING` (floor inclusive), `ratio < warning_floor_bps ⇒ CRITICAL`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AssetPolicy {
    pub healthy_bps: u32,
    pub warning_floor_bps: u32,
}

/// Effective policy when governance has set none — byte-identical to the
/// frozen testnet baseline (`ANT-POR-BASELINE-2026-11-21`).
pub const DEFAULT_POLICY: AssetPolicy = AssetPolicy {
    healthy_bps: HEALTHY_BPS,
    warning_floor_bps: WARNING_FLOOR_BPS,
};

/// The verified attestation record stored on-chain per asset.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AttestationRecord {
    pub asset_symbol: Symbol,
    pub sequence_number: u64,
    pub epoch_timestamp: u64,
    pub valid_until: u64,
    pub verified_reserves: u128,
    pub onchain_supply: u128,
    pub calculated_ratio_bps: u32,
    pub status: Symbol,
}

/// Reserve tier status symbols.
pub const STATUS_HEALTHY: Symbol = symbol_short!("HEALTHY");
pub const STATUS_WARNING: Symbol = symbol_short!("WARNING");
pub const STATUS_STALE: Symbol = symbol_short!("STALE");
pub const STATUS_CRITICAL: Symbol = symbol_short!("CRITICAL");
pub const STATUS_FROZEN: Symbol = symbol_short!("FROZEN");

/// Ratio thresholds (basis points).
pub const HEALTHY_BPS: u32 = 10_000;
pub const WARNING_FLOOR_BPS: u32 = 9_950;
/// Evidence epoch staleness bound: 4 hours (master blueprint Screen 4).
pub const STALE_AFTER_SECS: u64 = 4 * 3600;

/// Read helper: last consumed sequence (0 before the first attestation).
pub fn last_sequence(env: &Env, asset: &Symbol) -> u64 {
    env.storage()
        .persistent()
        .get(&DataKey::LastSequence(asset.clone()))
        .unwrap_or(0)
}

/// Read helper: freeze flag (unfrozen before any governance action).
pub fn is_frozen(env: &Env, asset: &Symbol) -> bool {
    env.storage()
        .persistent()
        .get(&DataKey::AssetFrozen(asset.clone()))
        .unwrap_or(false)
}

/// Read helper: effective tier policy (stored governance value or the
/// deployed default — never panics on a fresh asset).
pub fn asset_policy(env: &Env, asset: &Symbol) -> AssetPolicy {
    env.storage()
        .persistent()
        .get(&DataKey::AssetPolicy(asset.clone()))
        .unwrap_or(DEFAULT_POLICY)
}
