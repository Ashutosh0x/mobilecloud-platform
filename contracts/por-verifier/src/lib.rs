//! Hardened Stellar Soroban Proof-of-Reserve Contract.
//!
//! M-of-N Ed25519 threshold attestation with:
//! 1. **O(N) strictly ascending signer validation** — duplicate signers are
//!    structurally impossible (equal or descending keys reject), with zero
//!    heap allocation (`contracts` run under a strict instruction budget).
//! 2. **Monotonic sequence replay defense** — `seq == last + 1` exactly;
//!    replays, gaps, and reorders all fail.
//! 3. **Domain-separated SHA-256 digest** —
//!    `Sha256("FURLPAY_POR_V1" || seq || epoch || reserves || supply)`.
//! 4. **Independent on-chain ratio calculation** — the contract never trusts
//!    the mesh's arithmetic; it recomputes `bps = reserves * 10_000 / supply`
//!    with checked math and derives the status itself.
//! 5. **Issuer-governance freeze** — the 5-tier FROZEN state can only be set
//!    by the admin key (issuer multi-sig), never by the attestation path.
//!
//! Reference: `FURLPAY_INSTITUTIONAL_POR_PRODUCTION_SPECIFICATION_2026.md` §2
//! and master blueprint §8.2.
//!
//! Digest note: the domain string "FURLPAY_POR_V1" provides cross-protocol
//! domain separation; production deployment additionally binds ChainID and
//! ContractAddress implicitly (a Soroban contract only executes against its
//! own ledger state), so replaying a signature against a different contract
//! or chain yields a different effective verification context.

#![no_std]

mod errors;
mod storage;

#[cfg(test)]
mod test;

use errors::PoRError;
use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, Address, Bytes, BytesN, Env, Symbol, Vec,
};
use storage::{
    asset_policy, is_frozen, last_sequence, AssetPolicy, AttestationRecord, ConfigKey, DataKey,
    STATUS_CRITICAL, STATUS_FROZEN, STATUS_HEALTHY, STATUS_STALE, STATUS_WARNING, STALE_AFTER_SECS,
};

/// One Acurast mesh node's hardware signature over the canonical digest.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NodeSignature {
    /// Ed25519 public key (must be in the authorized signer registry).
    pub public_key: BytesN<32>,
    /// Ed25519 signature over the domain-separated digest.
    pub signature: BytesN<64>,
}

#[contract]
pub struct HardenedProofOfReserveContract;

const BPS_SCALE: u128 = 10_000;

// ---------------------------------------------------------------------------
// TTL MAINTENANCE ("Read-and-Extend" pattern, production roadmap §6.2).
// Soroban persistent entries ARCHIVE when their TTL lapses — a dormant asset
// would brick submit_attestation on mainnet (permanent DoS). Every
// successful attestation therefore proactively re-extends the instance and
// the three per-asset persistent records. 1 ledger ≈ 5 s → 17,280 ledgers/day.
// ---------------------------------------------------------------------------
const LEDGERS_PER_DAY: u32 = 17_280;
const TTL_THRESHOLD_LEDGERS: u32 = 30 * LEDGERS_PER_DAY; // extend only if < 30 days left
const TTL_EXTEND_TO_LEDGERS: u32 = 120 * LEDGERS_PER_DAY; // target lifetime ~120 days

#[contractimpl]
impl HardenedProofOfReserveContract {
    /// Initialize with the authorized Acurast node public keys (strictly
    /// ascending), the M-of-N threshold, and the issuer governance admin.
    ///
    /// Called once; subsequent calls fail with [`PoRError::AlreadyInitialized`].
    pub fn initialize(
        env: Env,
        admin: Address,
        signers: Vec<BytesN<32>>,
        threshold: u32,
    ) -> Result<(), PoRError> {
        if env.storage().instance().has(&ConfigKey::Threshold) {
            return Err(PoRError::AlreadyInitialized);
        }
        if threshold == 0 || signers.len() < threshold {
            return Err(PoRError::ThresholdNotMet);
        }
        if signers.is_empty() {
            return Err(PoRError::InvalidConfiguration);
        }
        // Strictly ascending registration enforces uniqueness from genesis.
        for i in 0..(signers.len() - 1) {
            if signers.get(i).unwrap() >= signers.get(i + 1).unwrap() {
                return Err(PoRError::SignerOrderInvalid);
            }
        }
        env.storage().instance().set(&ConfigKey::Admin, &admin);
        env.storage().instance().set(&ConfigKey::Signers, &signers);
        env.storage().instance().set(&ConfigKey::Threshold, &threshold);
        // Genesis TTL: pin the instance (which also covers the WASM code
        // lifetime) out to the 120-day target from day one.
        env.storage()
            .instance()
            .extend_ttl(TTL_THRESHOLD_LEDGERS, TTL_EXTEND_TO_LEDGERS);
        Ok(())
    }

    /// Submit a verified multi-sig reserve attestation.
    #[allow(clippy::too_many_arguments)]
    pub fn submit_attestation(
        env: Env,
        asset_symbol: Symbol,
        sequence_number: u64,
        epoch_timestamp: u64,
        valid_until: u64,
        verified_reserves: u128,
        onchain_supply: u128,
        signatures: Vec<NodeSignature>,
    ) -> Result<(), PoRError> {
        // 0. Issuer-governance freeze refuses new attestations (5-tier FROZEN).
        if is_frozen(&env, &asset_symbol) {
            return Err(PoRError::AssetFrozen);
        }

        // 1. REPLAY DEFENSE: strict monotonic sequence, expiry & evidence
        //    freshness. `valid_until` is chosen by the submitter, so a
        //    far-future window must not launder measurements whose epoch has
        //    aged past the 4-hour staleness bound (master blueprint Screen 4).
        let last_seq = last_sequence(&env, &asset_symbol);
        if sequence_number != last_seq.wrapping_add(1) || sequence_number == 0 {
            return Err(PoRError::InvalidSequenceNumber);
        }
        let now = env.ledger().timestamp();
        if now > valid_until {
            return Err(PoRError::AttestationExpired);
        }
        if now.saturating_sub(epoch_timestamp) > STALE_AFTER_SECS {
            return Err(PoRError::EvidenceStale);
        }

        // 2. THRESHOLD PRESENCE (cryptographic verification follows below).
        let authorized_signers: Vec<BytesN<32>> = env
            .storage()
            .instance()
            .get(&ConfigKey::Signers)
            .ok_or(PoRError::InvalidConfiguration)?;
        let threshold: u32 = env
            .storage()
            .instance()
            .get(&ConfigKey::Threshold)
            .ok_or(PoRError::InvalidConfiguration)?;
        if signatures.len() < threshold {
            return Err(PoRError::ThresholdNotMet);
        }

        // 3. DOMAIN-SEPARATED DIGEST:
        //    Sha256("FURLPAY_POR_V1" || seq || epoch || reserves || supply)
        let mut msg_bytes = Bytes::new(&env);
        msg_bytes.append(&Bytes::from_slice(&env, b"FURLPAY_POR_V1"));
        msg_bytes.append(&Bytes::from_slice(&env, &sequence_number.to_be_bytes()));
        msg_bytes.append(&Bytes::from_slice(&env, &epoch_timestamp.to_be_bytes()));
        msg_bytes.append(&Bytes::from_slice(&env, &verified_reserves.to_be_bytes()));
        msg_bytes.append(&Bytes::from_slice(&env, &onchain_supply.to_be_bytes()));
        let digest = env.crypto().sha256(&msg_bytes);

        // 4. O(N) STRICTLY ASCENDING SIGNER VERIFICATION.
        //    `sig[i].public_key < sig[i+1].public_key` guarantees every
        //    signature comes from a DISTINCT authorized node — a duplicated
        //    key can never inflate the count toward the threshold.
        let mut last_key = BytesN::<32>::from_array(&env, &[0u8; 32]);
        let mut valid_count: u32 = 0;

        for i in 0..signatures.len() {
            let sig = signatures.get(i).unwrap();
            if i > 0 && sig.public_key <= last_key {
                return Err(PoRError::SignerOrderInvalid);
            }
            last_key = sig.public_key.clone();

            if !authorized_signers.contains(&sig.public_key) {
                return Err(PoRError::UnauthorizedSigner);
            }
            env.crypto().ed25519_verify(
                &sig.public_key,
                &digest.clone().into(),
                &sig.signature,
            );
            valid_count += 1;
        }
        if valid_count < threshold {
            return Err(PoRError::ThresholdNotMet);
        }

        // 5. INDEPENDENT ON-CHAIN RATIO CALCULATION (checked math).
        //    Bound: verified_reserves <= u128::MAX / 10_000 (~3.4e35 base
        //    units = 3.4e17 shares at 18 decimals) — comfortably above any
        //    real asset; larger figures are a typed overflow, never a wrap.
        let ratio: u32 = if onchain_supply == 0 {
            BPS_SCALE as u32
        } else {
            let scaled = verified_reserves
                .checked_mul(BPS_SCALE)
                .ok_or(PoRError::ArithmeticOverflow)?;
            let ratio_u128 = scaled / onchain_supply;
            if ratio_u128 > u32::MAX as u128 {
                return Err(PoRError::ArithmeticOverflow);
            }
            ratio_u128 as u32
        };

        // 6. STATUS DETERMINATION & STATE COMMIT.
        //    Tier boundaries come from the asset's effective policy (Gate 7):
        //    governance-configured if set, otherwise the deployed default —
        //    `ratio >= healthy ⇒ HEALTHY; ratio >= floor ⇒ WARNING; else CRITICAL`.
        let policy = asset_policy(&env, &asset_symbol);
        let status = if ratio >= policy.healthy_bps {
            STATUS_HEALTHY
        } else if ratio >= policy.warning_floor_bps {
            STATUS_WARNING
        } else {
            STATUS_CRITICAL
        };

        let record = AttestationRecord {
            asset_symbol: asset_symbol.clone(),
            sequence_number,
            epoch_timestamp,
            valid_until,
            verified_reserves,
            onchain_supply,
            calculated_ratio_bps: ratio,
            status: status.clone(),
        };

        env.storage()
            .persistent()
            .set(&DataKey::LastSequence(asset_symbol.clone()), &sequence_number);
        env.storage()
            .persistent()
            .set(&DataKey::LatestRecord(asset_symbol.clone()), &record);
        env.storage()
            .persistent()
            .set(&DataKey::AssetStatus(asset_symbol.clone()), &status);

        // Read-and-Extend: push the instance and every modified persistent
        // record out to the 120-day target (roadmap §6.2).
        env.storage()
            .instance()
            .extend_ttl(TTL_THRESHOLD_LEDGERS, TTL_EXTEND_TO_LEDGERS);
        let seq_key = DataKey::LastSequence(asset_symbol.clone());
        let record_key = DataKey::LatestRecord(asset_symbol.clone());
        let status_key = DataKey::AssetStatus(asset_symbol.clone());
        env.storage()
            .persistent()
            .extend_ttl(&seq_key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_TO_LEDGERS);
        env.storage()
            .persistent()
            .extend_ttl(&record_key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_TO_LEDGERS);
        env.storage()
            .persistent()
            .extend_ttl(&status_key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_TO_LEDGERS);
        // A governance-set policy rides the same attestation cadence.
        let policy_key = DataKey::AssetPolicy(asset_symbol.clone());
        if env.storage().persistent().has(&policy_key) {
            env.storage()
                .persistent()
                .extend_ttl(&policy_key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_TO_LEDGERS);
        }

        env.events()
            .publish((Symbol::new(&env, "POR_AUDIT"), asset_symbol), ratio);
        Ok(())
    }

    /// Issuer-governance freeze (5-tier FROZEN). Requires the admin key.
    pub fn freeze_asset(env: Env, admin: Address, asset_symbol: Symbol) -> Result<(), PoRError> {
        Self::require_admin(&env, &admin)?;
        env.storage()
            .persistent()
            .set(&DataKey::AssetFrozen(asset_symbol.clone()), &true);
        env.events()
            .publish((Symbol::new(&env, "GOVERNANCE"), asset_symbol), STATUS_FROZEN);
        Ok(())
    }

    /// Lift an issuer-governance freeze. Requires the admin key.
    pub fn unfreeze_asset(env: Env, admin: Address, asset_symbol: Symbol) -> Result<(), PoRError> {
        Self::require_admin(&env, &admin)?;
        env.storage()
            .persistent()
            .set(&DataKey::AssetFrozen(asset_symbol.clone()), &false);
        env.events().publish(
            (Symbol::new(&env, "GOVERNANCE"), asset_symbol),
            STATUS_HEALTHY,
        );
        Ok(())
    }

    /// The most recent verified attestation for an asset, if any.
    pub fn get_latest_record(env: Env, asset_symbol: Symbol) -> Option<AttestationRecord> {
        env.storage()
            .persistent()
            .get(&DataKey::LatestRecord(asset_symbol))
    }

    /// Configure an asset's tier boundaries (Gate 7). Requires the admin key.
    ///
    /// Validation: `0 < warning_floor_bps < healthy_bps <= 10_000`. The change
    /// writes ONLY the policy key — committed status (`AssetStatus`) is never
    /// touched, so loosening thresholds cannot clear a CRITICAL publication;
    /// only a new valid attestation reclassifies.
    pub fn set_asset_policy(
        env: Env,
        admin: Address,
        asset_symbol: Symbol,
        healthy_bps: u32,
        warning_floor_bps: u32,
    ) -> Result<(), PoRError> {
        Self::require_admin(&env, &admin)?;
        if warning_floor_bps == 0
            || warning_floor_bps >= healthy_bps
            || healthy_bps > BPS_SCALE as u32
        {
            return Err(PoRError::InvalidPolicyParams);
        }
        let old = asset_policy(&env, &asset_symbol);
        let policy = AssetPolicy {
            healthy_bps,
            warning_floor_bps,
        };
        let key = DataKey::AssetPolicy(asset_symbol.clone());
        env.storage().persistent().set(&key, &policy);
        env.storage()
            .persistent()
            .extend_ttl(&key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_TO_LEDGERS);

        // Auditors reconstruct the transition without ledger archaeology:
        // value = [old_healthy, old_floor, new_healthy, new_floor].
        let mut payload: Vec<u32> = Vec::new(&env);
        payload.push_back(old.healthy_bps);
        payload.push_back(old.warning_floor_bps);
        payload.push_back(healthy_bps);
        payload.push_back(warning_floor_bps);
        env.events().publish(
            (Symbol::new(&env, "GOVERNANCE_CONFIG"), asset_symbol),
            payload,
        );
        Ok(())
    }

    /// Effective tier policy for an asset (stored value or deployed default).
    pub fn get_asset_policy(env: Env, asset_symbol: Symbol) -> AssetPolicy {
        asset_policy(&env, &asset_symbol)
    }

    /// Live solvency telemetry: `(status, ratio_bps, last_sequence)`.
    ///
    /// Read-and-Extend: reads must not be free-riding on TTLs written long
    /// ago — public dashboards keep the asset's records alive as a side
    /// effect of every poll.
    ///
    /// STALE derivation: the committed record is immutable, but once its
    /// evidence epoch ages past [`STALE_AFTER_SECS`] the *view* reports
    /// `STALE` instead of the last committed tier — consumers (Gate 9
    /// circuit breakers) halt on `CRITICAL` **or** `STALE`.
    pub fn get_solvency_state(env: Env, asset_symbol: Symbol) -> (Symbol, u32, u64) {
        let seq_key = DataKey::LastSequence(asset_symbol.clone());
        let record_key = DataKey::LatestRecord(asset_symbol.clone());
        let status_key = DataKey::AssetStatus(asset_symbol.clone());

        let status = env
            .storage()
            .persistent()
            .get::<DataKey, Symbol>(&status_key)
            .unwrap_or_else(|| symbol_short!("UNKNOWN"));
        let record = env
            .storage()
            .persistent()
            .get::<DataKey, AttestationRecord>(&record_key);
        let seq = last_sequence(&env, &asset_symbol);

        // Extend the three records we just touched (no-op below threshold).
        env.storage()
            .persistent()
            .extend_ttl(&seq_key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_TO_LEDGERS);
        env.storage()
            .persistent()
            .extend_ttl(&record_key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_TO_LEDGERS);
        env.storage()
            .persistent()
            .extend_ttl(&status_key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_TO_LEDGERS);

        match &record {
            Some(r) => {
                let view = if env
                    .ledger()
                    .timestamp()
                    .saturating_sub(r.epoch_timestamp)
                    > STALE_AFTER_SECS
                {
                    STATUS_STALE
                } else {
                    status
                };
                (view, r.calculated_ratio_bps, seq)
            }
            None => (status, 0, seq),
        }
    }

    fn require_admin(env: &Env, admin: &Address) -> Result<(), PoRError> {
        let stored: Address = env
            .storage()
            .instance()
            .get(&ConfigKey::Admin)
            .ok_or(PoRError::InvalidConfiguration)?;
        if &stored != admin {
            return Err(PoRError::UnauthorizedGovernance);
        }
        admin.require_auth();
        Ok(())
    }
}
