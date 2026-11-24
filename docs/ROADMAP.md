# Roadmap — Phase 1 to Phase 6 (with honest status tags)

Every phase below carries its true status. Nothing `NOT_ESTABLISHED` is
presented as done.

## Phase 1 — Deterministic core & regression discipline ✅ DONE (`VERIFIED_SOURCE`/`DEPLOYED`)

- `por-kernel` reconciliation (58 tests), `core-engine` platform services
  (35 tests), `trading-engine` (17 tests) — 110 in the default workspace
  members.
- Deterministic snapshot corpus: **26 snapshots** (17 baseline byte-identical
  on every re-run + 9 Gate 7), sealed in `INTEGRITY_MANIFEST.sha256`.

## Phase 2 — Soroban verifier on testnet ✅ DONE (`DEPLOYED`)

- `por-verifier` deployed: `CDWNCMD6NG652YNX5PV2VLAWW4HMJGFICVE55NSDMSPS76H2VSLOEDPI`
  (WASM `8ebceb…3648`), Protocol 30.
- T1–T12 live evidence: 6 state-advancing txs (seq 2→7), 6 attack rejections,
  full state-machine sweep, event triple-agreement.
- Attestor/submitter tooling + independent pure-Python RFC 8032 verification.

## Phase 3 — Governance hardening & production launch (current)

Gate 7 parameterized governance is implemented and tested
(`VERIFIED_SOURCE`, live-swept 2026-11-21). Remaining before mainnet:

| Item | Status | Notes |
| :--- | :--- | :--- |
| Admin Timelock + Multi-sig | `NOT_ESTABLISHED` | Required: an admin can otherwise set degenerate future thresholds (SECURITY-MODEL.md) |
| Sliding-window staleness on-chain (`EvidenceStale(11)` / `STATUS_STALE` activation) | reserved discriminants | Phase 3 enforcement target |
| Protocol 30 XDR migration (`stellar-xdr` 30.x) | planned | RFC 4506 invariants already pinned by toolkit tests |
| `por-keeper` TTL automation | planned | restore-or-bump to defeat the archival trap (deployed WASM bumps only ~6.4 days) |
| Production key ceremony | `NOT_ESTABLISHED` | testnet keys are deterministic dev keys |
| Mainnet deployment | `NOT_ESTABLISHED` | new contract ID; own seq series; new evidence package required |

## Phase 4 — TEE attestation (`NOT_ESTABLISHED`)

Acurast enclave execution of kernel+signing with attested binaries — design
staged so it requires **no** contract changes (ACURAST-TEE.md).

## Phase 5 — Institutional attestation (`NOT_ESTABLISHED`)

CPA examination of reserves, licensed custody arrangements, quarterly reports
per `specs/FP-ENG-2026-QRP-01.md` §7 (dual digest schemes, independent
verifier output included).

## Phase 6 — Regulatory & public scale (`NOT_ESTABLISHED`)

Regulatory filings, multi-asset expansion (policies are already per-asset),
public dashboard consuming `getEvents` streams.

## Documentation & audit status (2026-11-21)

- Pre-publication audit executed and remediated (`specs/FP-ENG-2026-AUD-01.md`):
  corrected specs (rev 2.0), git initialization, integrity manifest, XDR
  toolkit promotion — all steps closed.
- This `docs/` set is the publication candidate; every claim is either
  evidence-backed or tagged `NOT_ESTABLISHED`.
