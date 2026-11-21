# Integration Guide — Reading & Independently Verifying the Proof-of-Reserve

Status: `DEPLOYED` procedures (every command below was executed against the
live testnet contract during the 2026-11-21 baseline).

## Who this is for

Custodians, transfer agents, trading desks, and auditors who want to verify
FurlPay's proof-of-reserve **without trusting any FurlPay infrastructure** —
only the Stellar ledger and standard tooling.

## Step 1 — Identify the contract

```text
Contract:  CDWNCMD6NG652YNX5PV2VLAWW4HMJGFICVE55NSDMSPS76H2VSLOEDPI
WASM hash: 8ebcebc32894d39cbd50867249952f8fb0d9b04e6ae1251ccf34c26aad013648
Network:   Stellar Testnet (Protocol 30)
```

> A redeployment produces a new contract ID; evidence (T1–T12) is permanently
> bound to the ID above. `initialize` is once-only — there is no upgrade path.

## Step 2 — Read the committed state (RPC `getLedgerEntries`)

Keys are `LedgerKey::ContractData` (Persistent) with
`ScVal::Vec([Symbol(variant), Symbol(asset)])`:

- `LatestRecord(ANT)` → seq, epoch, reserves, supply, ratio_bps, `valid_until`
- `AssetStatus(ANT)` → committed status symbol
- `AssetPolicy(ANT)` → governed tier policy (may be absent ⇒ default 10,000/9,950)

Byte-exact key encodings (including the RFC 4506 `Option` presence flag that
breaks hand-rolled encoders) are in PROTOCOL-30-XDR.md, and the
`por-xdr` CLI in `tools/por-xdr-toolkit` generates them for you:

```bash
por-xdr key <contract_hash_hex> LatestRecord ANT record_key.bin
```

18-decimal `u128` values arrive on-chain untruncated (baseline: reserves =
supply = 10²⁴ → ratio 10000).

## Step 3 — Read the event stream (RPC `getEvents`)

Filter for `POR_AUDIT` (data = `u32` ratio bps, one per committed
attestation) and `GOVERNANCE_CONFIG` (data = `Vec<u32>` of exactly **four**
elements `[old_healthy, old_warning_floor, new_healthy, new_warning_floor]` —
deserialize as `ScVal::Vec`, **not** a tuple).

Cross-check: for every tx in VERIFIED-BASELINE.md, the committed state, the
event value, and the tx outcome must agree (the baseline's
`events/por_events_raw.json` shows the expected shapes).

## Step 4 — Independently verify the cryptography

The digest is fully recomputable from public state:

```text
preimage = "FURLPAY_POR_V1" ‖ seq_u64BE ‖ epoch_u64BE ‖ reserves_u128BE ‖ supply_u128BE
digest   = SHA-256(preimage)
```

Baseline example (seq 7): `e825ef9dfd79611ff7458a236534b83ce427d3c73b2c46b0938c1a550da1ea77`,
verified by `audit/TESTNET_BASELINE_2026-11-21/crypto/verify_baseline.py` —
a **pure-Python RFC 8032 Ed25519 verifier sharing zero code with the Rust
pipeline** (it validates all 3-of-5 signatures and ascending order).

## Step 5 — Interpret status (advisory model)

| Committed status | Suggested consumer action |
| :--- | :--- |
| `HEALTHY` (≥ healthy_bps) | normal operation |
| `WARNING` (≥ warning_floor_bps) | raise monitoring cadence; review next attestation |
| `CRITICAL` (< warning_floor_bps) | apply your own risk policy — the contract does **not** halt anything by itself; wire `trading-engine::soroban_circuit_breaker` if you want automatic responses |

Staleness: check `LatestRecord.valid_until` yourself; an expired window means
the **latest committed record is old** even though the contract still holds it.

## Operational cautions

- **Redeploy = new contract ID** (seq series restarts at 1).
- **Archival trap:** on the deployed WASM, entry TTL bumps ~6.4 days per
  write (measured: liveUntil 5,957,979 from 5,847,384); a dormant asset's
  keys can archive — restore before submitting (see STELLAR-SOROBAN.md).
- Freshness rejects on-chain with `AttestationExpired(6)`; there is no active
  `EvidenceStale(11)` path (reserved for Phase 3).

## Institutional engagement status

CPA attestation, licensed custody, and regulatory filings are
`NOT_ESTABLISHED` — the quarterly reporting framework they will consume is
specified in `specs/FP-ENG-2026-QRP-01.md`.
