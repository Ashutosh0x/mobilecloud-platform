# FP-ENG-2026-DOC-01 — Gate 7 Parameterized Governance Specification

**Revision:** 2.0 (Post-Audit Corrected — supersedes all prior drafts)
**Status:** `VERIFIED_SOURCE` (compiles clean, 107 workspace tests green) with `DEPLOYED` live testnet evidence
**Verified against:** `contracts/por-verifier/` at the 2026-11-21 audit baseline and live testnet sweep
**Companion documents:** `FP-ENG-2026-QRP-01` (reporting framework), `FP-ENG-2026-AUD-01` (pre-publication audit)

---

## 1. Scope

This specification defines the Gate 7 parameterized governance capability of
the Soroban `por-verifier` contract: per-asset tier policies, the governance
event contract, validation rules, authorization, and non-retroactivity. Every
code excerpt in this document is copied from the shipped source; every count
in this document was recounted from the working tree on 2026-11-21.

**Deployed contract (testnet):**
`CDWNCMD6NG652YNX5PV2VLAWW4HMJGFICVE55NSDMSPS76H2VSLOEDPI`

> **Redeployment note:** `initialize` is once-only and there is no upgrade
> path. Redeploying the Gate 7 WASM produces a **new contract ID** starting
> its own `seq = 1` series. T1–T12 evidence is permanently tied to the
> contract ID above.

## 2. AssetPolicy Model

Governance-configured tier boundaries per asset; absent ⇒ `DEFAULT_POLICY`
(`storage.rs:39`, `storage.rs:107–111`):

```rust
pub const DEFAULT_POLICY: AssetPolicy = AssetPolicy {
    healthy_bps: HEALTHY_BPS,          // 10_000
    warning_floor_bps: WARNING_FLOOR_BPS, // 9_950
};

pub fn asset_policy(env: &Env, asset: &Symbol) -> AssetPolicy { /* storage lookup, unwrap_or(DEFAULT_POLICY) */ }
```

Deployed constants (`storage.rs:84–85`):

| Constant | Value | Meaning |
| :--- | :--- | :--- |
| `HEALTHY_BPS` | **10_000** | `ratio >= healthy_bps ⇒ HEALTHY` |
| `WARNING_FLOOR_BPS` | **9_950** | `warning_floor_bps <= ratio < healthy_bps ⇒ WARNING`; below ⇒ `CRITICAL` |

> **Correction history:** earlier drafts and roadmap notes stated a 9,500
> warning floor. The deployed contract uses **9,950**, confirmed live on
> 2026-11-21: a 97.00% reserve classified `CRITICAL`, a 99.70% reserve
> classified `WARNING`. All documents must state 9,950.

**Validation rule** (`PoRError::InvalidPolicyParams = 12`):
`0 < warning_floor_bps < healthy_bps <= 10_000`.

## 3. Contract ABI (Gate 7 additions)

### 3.1 `set_asset_policy`
Admin-only (`PoRError::UnauthorizedGovernance = 10` otherwise). Validates the
rule in §2, persists the per-asset `AssetPolicy`, emits `GOVERNANCE_CONFIG`.
Changes apply **prospectively only** — historical committed records are never
rewritten (`G7-REG-03`).

### 3.2 `get_asset_policy`
Public view delegating to `storage::asset_policy(&env, &asset_symbol)`
(`lib.rs:351–353`). **Note for integrators:** the helper is
`storage::asset_policy`, *not* `storage::get_policy` (a name that appeared in
a draft illustration and does not exist in the codebase).

### 3.3 `GOVERNANCE_CONFIG` event — shipped payload is a `Vec<u32>`

The contract instantiates and emits a **`Vec<u32>`** with four elements
`[old_healthy, old_warning_floor, new_healthy, new_warning_floor]`
(`lib.rs:332–346`, pinned by snapshot `g7_reg_02_…`):

```rust
// ACTUAL SHIPPED CONTRACT (lib.rs:332-346)
let mut payload: Vec<u32> = Vec::new(&env);
payload.push_back(old.healthy_bps);
payload.push_back(old.warning_floor_bps);
payload.push_back(healthy_bps);
payload.push_back(warning_floor_bps);
env.events().publish(
    (Symbol::new(&env, "GOVERNANCE_CONFIG"), asset_symbol),
    payload,
);
```

> **Correction history:** a draft showed a 4-tuple payload. Off-chain
> indexers MUST deserialize the data value as an XDR `ScVal::Vec` of four
> `ScVal::U32` elements; a struct/tuple decoder will fail.

## 4. Freshness & Error Register (corrected)

Freshness is enforced **exclusively** through the caller-supplied
`valid_until` parameter: if `ledger_timestamp > valid_until`, the invocation
aborts with `PoRError::AttestationExpired (6)`.

> **Correction history:** earlier drafts claimed attestations older than 4
> hours reject with `PoRError::EvidenceStale (11)`. In the shipped source,
> `EvidenceStale = 11` (`errors.rs:38`), `STATUS_STALE` (`storage.rs:79`) and
> `STALE_AFTER_SECS = 4 * 3600` (`storage.rs:87`) are **reserved/unused
> discriminants** for Phase 3 sliding-window enforcement — they are never
> returned by `lib.rs`. Publishing the `EvidenceStale` claim would be
> falsifiable by any reproducer. The off-chain kernel may *derive* a
> `STALE` display state (`solvency_view_derives_stale_after_window`), but the
> contract itself does not enforce it.

Full `PoRError` register (`errors.rs`, ABI-stable, never renumber):

| # | Discriminant | Trigger |
| :--- | :--- | :--- |
| 1 | `AlreadyInitialized` | `initialize` called twice |
| 2 | `UnauthorizedSigner` | signature from non-registered key |
| 3 | `SignerOrderInvalid` | signatures not strictly ascending by public key |
| 4 | `ThresholdNotMet` | fewer than M valid signatures |
| 5 | `InvalidSequenceNumber` | sequence ≠ `last + 1` (replay/gap/reorder) |
| 6 | `AttestationExpired` | `ledger_timestamp > valid_until` — **the freshness enforcement** |
| 7 | `ArithmeticOverflow` | checked 256-bit math overflow in ratio calculation |
| 8 | `InvalidConfiguration` | self-inconsistent threshold/signer args |
| 9 | `AssetFrozen` | issuer-governance freeze active |
| 10 | `UnauthorizedGovernance` | governance call not signed by admin |
| 11 | `EvidenceStale` | **reserved (Phase 3)** — unused in shipped source |
| 12 | `InvalidPolicyParams` | `0 < warning_floor < healthy <= 10_000` violated |

## 5. Signature & Digest Scheme

- **Digest:** `Sha256("FURLPAY_POR_V1" || seq_u64be || epoch_u64be || reserves_u128be || supply_u128be)`
  (fixed-width big-endian concatenation; domain-separated).
- **Quorum:** M-of-N Ed25519 (deployed: 3-of-5), signatures over the digest,
  verified in O(N) with signers in **strictly ascending public-key order**
  (`SignerOrderInvalid = 3` otherwise — this simultaneously blocks duplicates).
- **Monotonic sequence:** each asset's sequence must be exactly `last + 1`
  (`InvalidSequenceNumber = 5`).
- Off-chain quarterly reports use a length-prefixed encoding (see QRP-01 §5);
  both schemes are collision-resistant and the distinction is documented.

## 6. Status Publication Model (corrected — advisory)

`por-verifier` publishes telemetry and status **on-chain as data + events**.
It has **no administrative authority** over third-party token contracts or
liquidity pools: a `CRITICAL` status does **not** autonomously halt trading or
minting. Halting requires an external circuit breaker (e.g.
`trading-engine::soroban_circuit_breaker`) or a custom token transfer hook
wired to read the contract's status. All public documentation must use this
advisory model (harmonized with QRP-01 §6).

## 7. Test Register (recounted 2026-11-21)

Workspace total: **107 green tests** — 16 `core-engine`, 23 `por-verifier`,
58 `por-kernel`, 10 `trading-engine`.

Gate 7 contributes **9 tests** in `contracts/por-verifier/src/test.rs`:

| Test ID | Function | Snapshot |
| :--- | :--- | :--- |
| `G7-DEF-01` | `g7_def_01_default_policy_matches_baseline_boundaries` | `g7_def_01_….1.json` |
| `G7-SET-01` | `g7_set_01_custom_policy_9000_8000_reclassifies_boundaries` | `g7_set_01_….1.json` |
| `G7-SET-02` | `g7_set_02_get_policy_default_then_governed_per_asset` | `g7_set_02_….1.json` |
| `G7-AUTH-01` | `g7_auth_01_non_admin_cannot_set_asset_policy` | `g7_auth_01_….1.json` |
| `G7-VAL-01` | `g7_val_01_rejects_warning_floor_ge_healthy` | `g7_val_01_….1.json` |
| `G7-VAL-02` | `g7_val_02_rejects_healthy_above_bps_scale` | `g7_val_02_….1.json` |
| `G7-VAL-03` | `g7_val_03_rejects_zero_warning_floor` | `g7_val_03_….1.json` |
| `G7-REG-02` | `g7_reg_02_governance_config_event_carries_transition_payload` | `g7_reg_02_….1.json` |
| `G7-REG-03` | `g7_reg_03_policy_change_cannot_retroactively_clear_committed_status` | `g7_reg_03_….1.json` |

> **Correction history:** earlier drafts said "All 8 new tests" with
> placeholder IDs `G7-REG-01..08`. The actual set is the 9 functions above.

## 8. Snapshot Register

`contracts/por-verifier/test_snapshots/test/` contains **26 snapshots**:
**17 baseline** (byte-identical on re-run) + **9 Gate 7** snapshots.

> **Correction history:** audit revision 1.0 recorded "24 (15+9)". A recount
> of the directory found **26 (17+9)** — the baseline snapshot count was
> itself stale. 26 is the verified figure and the count sealed in
> `INTEGRITY_MANIFEST.sha256`.

## 9. Live Verification Evidence (testnet, 2026-11-21)

Threshold sweep T9–T12 exercised the full solvency state machine against the
deployed contract:

| Step | Reserve ratio | Committed status | Attestation seq | Note |
| :--- | :--- | :--- | :--- | :--- |
| T9 | 97.00% | `CRITICAL` | 4 | below the 9,950 floor ⇒ CRITICAL (confirms §2 constants) |
| T10 | 99.70% | `WARNING` | 5 | inside the 9,950–9,999 band |
| T11 | 93.00% | `CRITICAL` | 6 | deep-critical |
| T12 | 100.00% | `HEALTHY` | 7 | restore; final record at ledger 5,847,384 |

Each step: tx ↔ contract state read ↔ `POR_AUDIT` event **triple-agreement**
(6 events recovered via RPC `getEvents`). Independent verification with a
from-scratch pure-Python RFC 8032 implementation (zero shared code with the
Rust pipeline) recomputed the digest byte-for-byte and validated all
**3-of-5 quorum signatures** (signers in ascending order). Evidence:
`audit/TESTNET_BASELINE_2026-11-21/crypto/quorum_seq7.json`,
`crypto/verify_baseline.py`.

## 10. Non-Goals

- No autonomous trading/minting halt (§6).
- No contract upgrade path (§1 redeployment note).
- No `EvidenceStale` enforcement in this phase (§4).
- Admin threshold changes are not timelocked on testnet; Phase 3 mainnet
  requires Timelock + Multi-sig (see QRP-01 §7 — a compromised admin can set
  degenerate thresholds for *future* attestations, though committed history
  remains immutable per `G7-REG-03`).

---

*FP-ENG-2026-DOC-01 rev 2.0 — FurlPay Core Infrastructure & Cryptographic Engineering Group, 2026-11-21.*
