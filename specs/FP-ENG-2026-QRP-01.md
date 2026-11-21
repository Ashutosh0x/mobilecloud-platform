# FP-ENG-2026-QRP-01 — Quarterly Reporting Framework, Continuous Verification Architecture & Institutional Benchmarking

**Revision:** 2.0 (Post-Audit Corrected — formally supersedes the initial unverified draft, which contained unverified AUM and brand claims)
**Status:** `VERIFIED_SOURCE` + `DEPLOYED` evidence (T1–T12, testnet)
**Companion documents:** `FP-ENG-2026-DOC-01` (governance spec), `FP-ENG-2026-AUD-01` (pre-publication audit)

---

## 1. Status Taxonomy (authoritative)

Every claim in every FurlPay document must be tagged with exactly one of:

| Status | Meaning | Applies to |
| :--- | :--- | :--- |
| `DEPLOYED` | Verified against the live testnet contract with transaction, state, and event evidence | Milestones T1–T12 |
| `VERIFIED_SOURCE` | Verified in source + test suite, not yet exercised live | Gate 7 governance (live-swept 2026-11-21, see §8) |
| `NOT_ESTABLISHED` | No evidence exists yet; must not be implied | CPA audit, licensed custody, mainnet, regulatory filings |

> The initial QRP-01 draft mixed these categories (e.g. implying institutional
> custody relationships that are `NOT_ESTABLISHED`). This revision is the
> single source of truth.

## 2. Attestation Freshness Model (corrected)

- On-chain enforcement: **`valid_until` only**. A submission whose
  `ledger_timestamp > valid_until` aborts with `PoRError::AttestationExpired (6)`.
- `PoRError::EvidenceStale (11)` / `STATUS_STALE` / `STALE_AFTER_SECS = 4h`
  are **reserved Phase 3 sliding-window discriminants** — not active
  enforcement. Earlier drafts claiming 4-hour on-chain stale rejection are
  corrected by this revision.
- The off-chain kernel may *display* a `STALE` derivation
  (`solvency_view_derives_stale_after_window` snapshot); that is presentation
  logic, not contract enforcement.

## 3. Continuous Verification Architecture

Two independent planes, deliberately unable to share a bug:

1. **On-chain plane (per attestation):** `por-attestor` (Acurast TEE) signs the
   canonical digest → `por-submitter` posts 3-of-5 ascending-order Ed25519
   quorum → `por-verifier` verifies + commits `AttestationRecord` + emits
   `POR_AUDIT`. Consumers verify independently via RPC reads and `getEvents`.
2. **Off-chain plane (quarterly):** institutional report built from the same
   digests, with an independent verifier (`crypto/verify_baseline.py`, pure
   Python RFC 8032) that shares **zero code** with the Rust pipeline.

Acceptance rule for any release: **tx ↔ state ↔ event triple-agreement**, plus
one independent-language cryptographic verification.

## 4. Snapshot & Test Corpus (recounted 2026-11-21)

- **107 green tests**: 16 `core-engine`, 23 `por-verifier`, 58 `por-kernel`,
  10 `trading-engine` (replaces the stale "98-test suite" figure).
- **26 regression snapshots**: 17 baseline (byte-identical) + 9 Gate 7
  (replaces the stale "15 snapshots" figure; audit rev 1.0's "24" was also a
  miscount — see AUD-01 §3).
- Repo-wide sealing: `INTEGRITY_MANIFEST.sha256` covers all 26 snapshots,
  contract sources, `Cargo.toml`/`Cargo.lock`, and the release WASM.

## 5. Digest Schemes (both are canonical, documented on purpose)

| Scheme | Encoding | Used by |
| :--- | :--- | :--- |
| Fixed-width big-endian | `Sha256("FURLPAY_POR_V1" \|\| seq_u64be \|\| epoch_u64be \|\| reserves_u128be \|\| supply_u128be)` | Contract `submit_attestation` (on-chain) |
| Length-prefixed | TLV-style fields | Off-chain quarterly report construction (§7.1) |

Rationale: fixed-width minimizes on-chain compute and is unambiguous for
fixed-size `u128` ledger values; length-prefixed is extensible for report
attachments. Both are collision-resistant; cross-checking a quarterly report
against the on-chain digest is part of Q4 acceptance.

## 6. Advisory Halt Model (corrected — replaces autonomous-halt claim)

The `por-verifier` contract **publishes** status; it does not control third
parties. Response actions are wired externally:

| Status | Automated response (external wiring) |
| :--- | :--- |
| `HEALTHY` | normal operation |
| `WARNING` | raise monitoring cadence; notify ops |
| `CRITICAL` | external circuit breaker (e.g. `trading-engine::soroban_circuit_breaker`) pauses trading/minting **if wired**; status remains advisory otherwise |
| `STALE` (derived, off-chain only) | presenter-side flag; Phase 3 may move on-chain |

Earlier drafts asserting "a CRITICAL status triggers an immediate trading and
minting halt" as a contract behavior are corrected: without external wiring,
no halt occurs.

## 7. Quarterly Report Contents (§7.1)

Each quarterly report must contain:
1. Reserve composition statement (institutional source, `NOT_ESTABLISHED`
   until a licensed custodian/CPA attests).
2. Per-asset ratio table in basis points (10,000 = fully backed).
3. Digest listing (on-chain fixed-width scheme) + independent verifier output.
4. On-chain evidence: contract ID, sequence range, ledger heights, tx hashes.
5. Deviations & incidents (including any `WARNING`/`CRITICAL` transitions).
6. Toolchain fingerprint (Protocol 30, `stellar-xdr =22.1.0`, `soroban-sdk 22.0.11`).

## 8. Live Verification Record (2026-11-21)

Full solvency state machine exercised live against
`CDWNCMD6NG652YNX5PV2VLAWW4HMJGFICVE55NSDMSPS76H2VSLOEDPI`:

`HEALTHY → CRITICAL (97.00%) → WARNING (99.70%) → CRITICAL (93.00%) → HEALTHY (100.00%)`
— attestation seq 1→7, final record at ledger 5,847,384; 6 `POR_AUDIT` events
recovered and decoded; digest recomputed and all 3 quorum signatures validated
by an independent pure-Python RFC 8032 implementation. This sweep also
**disproved the stale 9,500 warning-floor figure**: 9,700 bps classified
`CRITICAL` because the deployed floor is **9,950** (DOC-01 §2).

## 9. Known Operational Constraints (mandatory disclosures)

1. **Redeployment ⇒ new contract ID** (no upgrade path); testnet evidence is
   permanently bound to the deployed ID; a new deployment restarts `seq = 1`.
2. **120-day archival trap:** persistent `AssetPolicy` / `AttestationRecord`
   entries archive if unbumped ~120 days (`TTL_EXTEND_TO_LEDGERS`); a dormant
   asset needs `por-keeper` restoration automation or the next submission
   traps at the VM level.
3. **Compromised-admin threat:** history is immutable (`G7-REG-03`), but an
   admin can set degenerate thresholds for *future* attestations; Phase 3
   mainnet requires Timelock + Multi-sig.
4. **`NOT_ESTABLISHED` items** (custody, CPA, mainnet, regulation) must never
   be presented as established.

---

*FP-ENG-2026-QRP-01 rev 2.0 — FurlPay Quality Assurance & Cryptographic Engineering Group, 2026-11-21.*
