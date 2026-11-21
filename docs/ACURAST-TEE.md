# Attestor Signing Architecture & TEE Roadmap

Status tags are explicit in this document: what runs today is
`VERIFIED_SOURCE`/`DEPLOYED`; the hardware-enclave runtime is **planned**
(`NOT_ESTABLISHED`).

## What exists today [VERIFIED_SOURCE, exercised live]

`tools/por-attestor` is the bridge between the deterministic kernel and the
contract:

1. Runs `por_kernel::execute_reconciliation` on the Dinari $ANT case-study
   inputs (1,000,000 circulating across 5 chains = 850,000 DTC-settled +
   150,000 T+1 transit) and prints the kernel's verdict.
2. Derives the **exact** domain-separated digest the contract verifies:
   `Sha256("FURLPAY_POR_V1" ‖ seq_be ‖ epoch_be ‖ reserves_be ‖ supply_be)`.
3. Signs with the 5 deterministic device keys (`ed25519-dalek`).
4. Emits signatures **pre-sorted in canonical ascending public-key order**
   (required by the contract's O(N) duplicate guard) and CLI-ready JSON for
   `stellar contract invoke`.

Evidence-quality parsing lives in `por-kernel` (`parsers/`, including
`alpaca_jws.rs` for JWS-signed broker evidence).

## Deterministic device keys

The 5 signing keys used on testnet are **deterministic development keys** —
not production secrets. The repository contains zero secret keys (strict
`S[AV-Z0-9]{55}` scan: 0 hits). Production key ceremony is a Phase 3 item
(SECURITY-MODEL.md / ROADMAP.md).

## Acurast TEE target [NOT_ESTABLISHED — roadmap, Phase 2+]

The production design moves `por-attestor` execution into Acurast hardware
enclaves (remote-attestable ARM TrustZone-class processors):

- Kernel + digest + signing run inside the enclave; only signatures leave.
- Evidence ingestion (JWS / ISO 20022-style feeds) parsed inside the TEE so
  raw custodian credentials never touch general-purpose infrastructure.
- On-chain or report-published enclave measurements bind attestations to a
  specific, attested binary.

**Nothing in the current baseline depends on Acurast**: the 2026-11-21 live
sweep ran the attestor as a plain host binary. Claims about TEE execution are
therefore tagged `NOT_ESTABLISHED` until a TEE deployment exists with its own
evidence package (same acceptance rule: tx ↔ state ↔ event + independent
verification).

## Why the two-plane design makes this safe to stage

Because verification is independent of signing infrastructure, swapping the
host attestor for a TEE attestor requires no changes to the contract, the
submitter, or any verifier: the digest, ordering, and quorum rules are
identical.
