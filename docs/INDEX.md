# FurlPay Proof-of-Reserve Documentation

**Audience:** custodians, CPAs, transfer agents, trading desks, and independent verifiers.
**Every factual claim in this documentation set is tagged with a status** — nothing
unstated is implied.

## Status taxonomy (used throughout)

| Tag | Meaning |
| :--- | :--- |
| `DEPLOYED` | Verified against the live Stellar testnet contract with transaction, state, and event evidence |
| `VERIFIED_SOURCE` | Verified in source and test suite (107 green tests), not necessarily exercised live |
| `NOT_ESTABLISHED` | No evidence exists yet — must never be presented as established |

## The one-paragraph summary

FurlPay publishes a machine-verifiable proof-of-reserve for tokenized assets
(case study: Dinari $ANT). A deterministic reconciliation kernel computes a
reserve ratio in basis points (10,000 = fully backed); 3-of-5 Ed25519 signers
produce a quorum over a domain-separated SHA-256 digest; a Soroban contract
(stellar-xdr 22.1.0, Protocol 30) verifies the quorum on-chain, enforces
monotonic sequences and freshness via `valid_until`, and commits an immutable,
non-retroactive status record (`HEALTHY` / `WARNING` / `CRITICAL`) with a
`POR_AUDIT` event per attestation. The full state machine was exercised live
on testnet on 2026-11-21 — including live rejections of six attack classes.

## Contract & identifiers

| Item | Value |
| :--- | :--- |
| Deployed contract (testnet) | `CDWNCMD6NG652YNX5PV2VLAWW4HMJGFICVE55NSDMSPS76H2VSLOEDPI` |
| WASM hash (on-chain instance) | `8ebcebc32894d39cbd50867249952f8fb0d9b04e6ae1251ccf34c26aad013648` |
| Network | Stellar Testnet (`Test SDF Network ; September 2015`), Protocol 30 |
| Toolchain | `soroban-sdk 22.0.11`, `stellar-xdr 22.1.0`, rpc `30.0.1-6b6ec60c` |

> Redeploying creates a **new contract ID** (no upgrade path); evidence is
> permanently bound to the ID above.

## Document map

| Document | Contents |
| :--- | :--- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Dual-cadence assurance model, component dataflow, platform real-time plane |
| [REALTIME-SYNC.md](REALTIME-SYNC.md) | Unified Web ⇄ Android real-time sync: event envelope, transactional outbox, WebSocket gateway protocol, cursor recovery, discovery, cross-device auth, limits |
| [VERIFIED-BASELINE.md](VERIFIED-BASELINE.md) | T1–T12 testnet evidence: tx hashes, ledgers, live attack rejections |
| [SOLVENCY-MODEL.md](SOLVENCY-MODEL.md) | Basis-point scale, thresholds (10,000 / 9,950), ratio math |
| [PROTOCOL-30-XDR.md](PROTOCOL-30-XDR.md) | XDR wire-format invariants and the `Option<ScVec>` presence flag |
| [GOVERNANCE.md](GOVERNANCE.md) | Gate 7 per-asset policies, validation rules, non-retroactivity |
| [SECURITY-MODEL.md](SECURITY-MODEL.md) | Quorum design, digest scheme, threat matrix |
| [STELLAR-SOROBAN.md](STELLAR-SOROBAN.md) | Contract mechanics, TTL/archival behavior, events |
| [ACURAST-TEE.md](ACURAST-TEE.md) | Attestor signing architecture and TEE roadmap |
| [INTEGRATION-GUIDE.md](INTEGRATION-GUIDE.md) | How to read and independently verify the proof-of-reserve |
| [ROADMAP.md](ROADMAP.md) | Phase 1–6 plan with honest status tags |
| [AUDIT-EVIDENCE.md](AUDIT-EVIDENCE.md) | Integrity manifests, verification scripts, commit anchors |

## Engineering specs (internal)

- `specs/FP-ENG-2026-DOC-01.md` — Gate 7 governance specification (rev 2.0, post-audit corrected)
- `specs/FP-ENG-2026-QRP-01.md` — Quarterly reporting framework (rev 2.0)
- `specs/FP-ENG-2026-AUD-01.md` — Pre-publication audit & remediation record

## Verification posture (as of 2026-11-21)

- **107 green tests** across the workspace (16 core-engine, 23 por-verifier,
  58 por-kernel, 10 trading-engine) + 4 in `por-xdr-toolkit`.
- **26 regression snapshots** (17 baseline byte-identical + 9 Gate 7).
- **Live:** 6 state-advancing transactions (seq 2→7 contiguous), 6 simulated
  attacks rejected pre-flight, tx ↔ state ↔ event triple-agreement, and an
  independent pure-Python RFC 8032 verification of the 3-of-5 quorum.
- **`NOT_ESTABLISHED` (do not assume):** CPA attestation, licensed custody,
  mainnet deployment, regulatory filings.
