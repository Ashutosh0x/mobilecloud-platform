# Verified Baseline — Testnet Evidence T1–T12

**All items in this document are `DEPLOYED`** — verified against live Stellar
testnet on 2026-11-21. Frozen evidence: `audit/TESTNET_BASELINE_2026-11-21/`
(`transactions.md`, `crypto/`, `endpoint/`, `events/`, `state/`, `versions.txt`,
`MANIFEST.sha256`).

## Contract & network

| Item | Value |
| :--- | :--- |
| Contract | `CDWNCMD6NG652YNX5PV2VLAWW4HMJGFICVE55NSDMSPS76H2VSLOEDPI` |
| WASM hash (on-chain instance entry) | `8ebcebc32894d39cbd50867249952f8fb0d9b04e6ae1251ccf34c26aad013648` |
| Network | Stellar Testnet, Protocol 30 (rpc `30.0.1-6b6ec60c`) |

## State-advancing transactions (6) — the live threshold sweep

Sequences are **contiguous 2→7** (sequence 1 was consumed by the
deployment-phase attestation).

| Test | Tx hash | Ledger | Seq | Ratio (bps) | Committed status | Event value |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| T1 | `be1bfa72b9dade9336ec909b81cd70faed15834529c2fd2dbdcebd053deb86cd` | 5,847,205 | 2 | 10000 | `HEALTHY` | `u32(10000)` |
| T4 | `4b2da72657385e20fde709f6f6835e6edc8776054985be2aa5e22eab0d402f56` | 5,847,300 | 3 | 10000 | `HEALTHY` | `u32(10000)` |
| T9 | `a663e33cbdf778e6457189a3179b31465a40b630be1f7776ee61266eb90df0d7` | 5,847,359 | 4 | 9700 | `CRITICAL` | `u32(9700)` |
| T10 | `361501d7d3cb387585749ea66b979c4e28a2ba5b6d1d47921659436fc68c0100` | 5,847,376 | 5 | 9970 | `WARNING` | `u32(9970)` |
| T11 | `5746c9c134433679a3371e549dcc208ace6d16fbb20900ed3f35c254f9fb6c26` | 5,847,380 | 6 | 9300 | `CRITICAL` | `u32(9300)` |
| T12 | `431ca87ec53d7933434169c6df3fccded0a653663c0affc7fc2a6c760ff45191` | 5,847,384 | 7 | 10000 | `HEALTHY` | `u32(10000)` |

The sweep exercises the **full solvency state machine**:
`HEALTHY → CRITICAL → WARNING → CRITICAL → HEALTHY`.

> T9 (9,700 bps → `CRITICAL`) is the live proof that the deployed warning
> floor is **9,950 bps**, not the 9,500 stated in stale roadmap notes.

## Rejected attacks (6) — simulated pre-flight, zero on-chain effect

| Test | Attack | On-chain rejection (HostError) |
| :--- | :--- | :--- |
| T2 | Sequence replay (seq 2 resubmitted) | `Error(Contract, #5)` `InvalidSequenceNumber` |
| T3 | 2-of-5 quorum (below threshold) | `Error(Contract, #4)` `ThresholdNotMet` |
| T5 | Forged signature (1-byte corruption) | `Error(Crypto, InvalidInput)` |
| T6 | Foreign (unregistered) signer | `Error(Contract, #2)` `UnauthorizedSigner` |
| T7 | Descending signer order | `Error(Contract, #3)` `SignerOrderInvalid` |
| T8 | Expired `valid_until` window | `Error(Contract, #6)` `AttestationExpired` |

> Note: freshness rejects with `AttestationExpired(6)` — the contract has no
> active `EvidenceStale(11)` path (reserved for Phase 3).

## Final frozen state (ledger 5,847,384)

- `LatestRecord(ANT)`: seq 7 · epoch 1795260507 · `valid_until` 1795267707
  (epoch + 7,200 s) · reserves = supply = 10²⁴ (18-decimal convention) ·
  ratio 10000 · `HEALTHY`
- `AssetStatus(ANT)`: `HEALTHY`
- Entry TTL at audit close: lastModified 5,847,384 → liveUntil 5,957,979
  (110,595 ledgers ≈ 6.4 days — the deployed WASM predates the 120-day
  source constants; see STELLAR-SOROBAN.md)

## Cryptographic binding [independently verified]

- Preimage (62 B): `"FURLPAY_POR_V1" ‖ seq u64-BE ‖ epoch u64-BE ‖ reserves u128-BE ‖ supply u128-BE`
- SHA-256 digest (seq 7): `e825ef9dfd79611ff7458a236534b83ce427d3c73b2c46b0938c1a550da1ea77`
- Quorum: **3/5 signatures RFC 8032 VALID**, keys ⊆ on-chain signers registry,
  strictly ascending order — verified twice: once by the Rust pipeline, once
  by an independent pure-Python implementation (`crypto/verify_baseline.py`)
  sharing zero code with it.

## Event triple-agreement

All 6 `POR_AUDIT` events were recovered via RPC `getEvents` and cross-checked:
**transaction ↔ contract state ↔ event** agree on seq, ratio, and status for
every step. Raw events: `audit/TESTNET_BASELINE_2026-11-21/events/por_events_raw.json`.

## Source anchoring

- Sources/specs/tooling commit: `31d3e7160c0a466c608ab3cfa8bf8dce71f17072`
  (repository initialized during audit remediation; see AUDIT-EVIDENCE.md).
- Workspace: **110 green tests** in the default workspace members (35
  core-engine, 58 por-kernel, 17 trading-engine). The Soroban contract crate
  (`por-verifier`) builds for `wasm32-unknown-unknown` and is verified
  separately, as is `por-xdr-toolkit`.
- Regression corpus: **26 snapshots** (17 baseline byte-identical + 9 Gate 7),
  all sealed in `INTEGRITY_MANIFEST.sha256`.
