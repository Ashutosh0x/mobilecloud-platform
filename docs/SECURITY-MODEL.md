# Security Model — Quorum, Digest & Honest Threat Matrix

Status: `DEPLOYED` for live-rejected attacks (T2–T8); design analysis is
`VERIFIED_SOURCE`.

## Signature scheme

- **Digest (domain-separated, fixed-width big-endian):**
  `Sha256("FURLPAY_POR_V1" ‖ seq_u64 ‖ epoch_u64 ‖ reserves_u128 ‖ supply_u128)`
  — 62-byte preimage. Domain separation prevents cross-protocol replay of
  signatures; fixed width eliminates ambiguity.
- **Quorum:** 3-of-5 Ed25519. Signatures must be submitted in **strictly
  ascending public-key order** (`SignerOrderInvalid = 3`), which makes
  duplicate signers structurally impossible in the O(N) verification loop.
- **Sequence defense:** each asset's sequence must be exactly `last + 1`
  (`InvalidSequenceNumber = 5`) — replays, gaps, and reordering all reject.
- **Freshness:** caller-supplied `valid_until`; `ledger_timestamp >
  valid_until ⇒ AttestationExpired(6)`. (`EvidenceStale(11)` is a reserved
  Phase 3 discriminant — not active.)
- **Freeze:** issuer-governance freeze blocks attestations for an asset
  (`AssetFrozen = 9`), liftable by admin (`UnauthorizedGovernance = 10`
  guards all governance paths).

## Live attack rejections (testnet, zero on-chain effect)

| Attack | Result |
| :--- | :--- |
| Sequence replay (seq 2) | `Error(Contract, #5)` |
| 2-of-5 quorum | `Error(Contract, #4)` |
| Forged signature (1-byte corruption) | `Error(Crypto, InvalidInput)` |
| Unregistered signer | `Error(Contract, #2)` |
| Descending signer order | `Error(Contract, #3)` |
| Expired window | `Error(Contract, #6)` |

## Threat matrix (honest version)

| Threat | Outcome |
| :--- | :--- |
| 1–2 of 5 signer keys compromised | **No impact** — quorum is 3-of-5 |
| 3+ signer keys compromised | Attacker can post fraudulent *future* attestations. Mitigations: off-chain independent verification against custodian statements, `por-keeper` monitoring of status transitions |
| Admin key compromised — history | **Immutable.** `G7-REG-03` proves policy changes cannot retroactively alter committed records |
| Admin key compromised — future | Admin can set degenerate thresholds (e.g. `healthy=2, warning=1`) making future ratios trivially "HEALTHY". **This is documented, not hidden** — Phase 3 mainnet requires Timelock + Multi-sig before launch |
| Freeze abuse | Admin can freeze/unfreeze attestations; visible via `GOVERNANCE_FREEZE` events |
| Evidence staleness | Window is explicit: `valid_until = epoch + 7,200 s` in the baseline; expired submissions reject on-chain |
| Verification stack compromise | Rust pipeline + pure-Python RFC 8032 verifier share zero code; both must agree, plus on-chain enforcement |
| Historical evidence loss | 26 snapshots + sources sealed in `INTEGRITY_MANIFEST.sha256`; baseline frozen under `audit/TESTNET_BASELINE_2026-11-21/MANIFEST.sha256` |

## Operational constraints (must-know)

1. **Redeploy = new contract ID** — no upgrade path; `initialize` is
   once-only; sequence series restarts at 1.
2. **120-day archival trap** — persistent entries archive if unbumped; see
   STELLAR-SOROBAN.md.
3. **Zero secret keys in the repo** — strict `S[AV-Z0-9]{55}` scan: 0 hits;
   test/dev keys are deterministic and non-production.

## What "verified" means here

- 107 workspace tests + 4 toolkit tests green.
- tx ↔ state ↔ event triple-agreement for all six live attestations.
- Independent-language cryptographic verification (digest + all 3 quorum
  signatures) — `audit/TESTNET_BASELINE_2026-11-21/crypto/verify_baseline.py`.
