# MobileCloud — Implementation Audit (Phase 0)

**Status:** baseline audit of the repository as it exists, before any new phase work.
**Audit date:** 2026-11-27.
**Auditor:** repository inspection + executed test suites (no unverified claims).

This document is the Phase 0 deliverable of the MobileCloud engineering program.
Every number below was produced by running the command shown, on the machine
described in §2. Nothing in this file is aspirational.

Status taxonomy (same tags used across `docs/`):

| Tag | Meaning |
| :--- | :--- |
| `DEPLOYED` | Verified against a live deployment (Stellar testnet) with tx/state/event evidence. |
| `VERIFIED_SOURCE` | Verified by reading source and by a passing automated test. |
| `PARTIAL` | Some real implementation exists; other parts are UI-only, record-only, or absent. |
| `NOT_ESTABLISHED` | No evidence exists. Must never be presented as established. |

---

## 1. Repository inventory

| Path | Kind | Language | Verified tests | Notes |
| :--- | :--- | :--- | ---: | :--- |
| `core-engine/` | Binary (axum) | Rust | 39 | On-device build pipeline, Build-Output-v3 proxy, tri-modal terminal gateway, web preview, file transfer. Operator API `:3000`, deployment server `:3001`. |
| `por-kernel/` | Library | Rust | 45 + 13 | Checked `U256` reconciliation, RFC 8785 canonical JSON, Alpaca JWS / ISO 20022 / Dinari TA parsers, T+1 transit accounting. |
| `trading-engine/` | Library + binary | Rust | 17 | Paper/demo cross-DEX arbitrage, four risk invariants, Soroban circuit-breaker *client*. |
| `contracts/por-verifier/` | Soroban contract | Rust → wasm | 25 | M-of-N Ed25519 quorum, O(N) ascending-signer verification, monotonic sequence + `valid_until`, 5-tier solvency. Excluded from default members; host-build tested. |
| `tools/por-attestor/` | Binary | Rust | 0 | Pre-sorted 5-key Ed25519 signer bridging kernel → contract. |
| `tools/por-submitter/` | Binary | Rust | 0 | Stellar Protocol-30 quorum submitter used for the live run. |
| `tools/por-xdr-toolkit/` | Binary/lib | Rust | 4 | RFC 4506 `Option<ScVec>` `LedgerKey` encoder. Standalone workspace. |
| `edge/mobilecloud-shield/` | Library | Rust | 11 | CrowdSec-compatible blocklist, sliding-window rate limiter, regex WAF. |
| `edge/mobilecloud-tunnel/` | Binaries | Rust | 7 | `mc-tunnel-client` / `mc-tunnel-relay`; Ed25519 handshake, yamux mux, WSS. |
| `fleet-mesh/` | Library | Rust | 43 | **New in this program.** Node registry, Ed25519 device identity, replay-protected heartbeats, revocation, telemetry provenance, health sweeps, resource-aware placement, authenticated API. |
| `apps/web-dashboard/` | Next.js 15 app | TypeScript | 58 | Console, realtime gateway, QR pairing, functions/workflows/webhooks, metering, PoR read-only view. SQLite via `node:sqlite`. |
| `android-app/` | Android app | Kotlin 2.0 | build+lint only | Compose console, JNI `forkpty` terminal, `VirtualKeyBar`, foreground terminal service. No JVM unit-test suite. |
| `web-cloudshell/` | Vite app | TypeScript | build only | WebGL Xterm.js browser PTY, file manager, preview picker. |
| `audit/` | Evidence | data | n/a | Frozen 2026-11-21 testnet baseline: 26 state snapshots + `verify_baseline.py`. |
| `docs/` | Documentation | Markdown | n/a | 15 platform/engineering guides (see `docs/INDEX.md`). |

### Workspace topology

`Cargo.toml` `members` = the nine Rust crates above plus `fleet-mesh`.
`default-members` = the same list **minus** `contracts/por-verifier` (the
Soroban crate is host-testable but is excluded from the default host build so a
plain `cargo test` only exercises host-buildable crates). `[profile.release]`
uses `lto = "thin"`, `codegen-units = 1`, `panic = "abort"`.

---

## 2. Test baseline (executed, not estimated)

**Environment:** Windows, `rustc 1.100.0 (0ef1bc386 2026-11-09)`,
`cargo 1.100.0 (3acc79c0c 2026-11-05)`, `node v26.7.0`, `npm 12.2.2`.

| Command | Result |
| :--- | :--- |
| `cargo test` (default members) | **175 passed, 0 failed** across: `core-engine` 39, `fleet-mesh` 43, `mobilecloud-shield` 11, `mobilecloud-tunnel` 7, `por-kernel` 45 + `edge_case_suite` 13, `trading-engine` 17; plus 1 doc-test. |
| `cargo test -p por-verifier` | **25 passed, 0 failed** (59.5 s; the 10,000-case classification test dominates). |
| `cd tools/por-xdr-toolkit && cargo test` | **4 passed, 0 failed**. |
| `cd apps/web-dashboard && npm test` | 58 tests (per the committed baseline; not re-run in this audit pass). |

**Aggregate:** 262 tests across the platform
(default members 175 + `por-verifier` 25 + dashboard 58 + `por-xdr-toolkit` 4).

Baseline for regression comparison: **zero failing tests, zero ignored tests.**
Any phase that changes a tested subsystem must keep this at zero failures.

### Known non-fatal build warning

`cargo test` emits `warning: unused dependency 'thiserror'` for `fleet-mesh`.
It is cosmetic, tracked, and left in place to avoid unrelated churn.

---

## 3. The 12 documented feature areas → source mapping

| # | Feature area | Primary source | Current status |
| --- | :--- | :--- | :--- |
| 1 | Autonomous Edge Computing | `core-engine/src/builder/*`, `core-engine/src/main.rs` | `VERIFIED_SOURCE` — real build → promote → serve pipeline. |
| 2 | Tri-Modal Terminal & CloudShell Gateway | `core-engine/src/terminal_gateway/*` | `VERIFIED_SOURCE` — JNI PTY, WS CloudShell, russh SSH. |
| 3 | Terminal Emulation & Touch Ergonomics | `android-app/`, `web-cloudshell/` | `VERIFIED_SOURCE` (build+lint, no automated suite). |
| 4 | Android Application Hardening | `android-app/app/` | `VERIFIED_SOURCE` (build+lint). |
| 5 | Next.js 15 Web Management Console | `apps/web-dashboard/` | `VERIFIED_SOURCE` — 58 tests. |
| 6 | Agentic Direct Deployment & Cache Revalidation | `core-engine` deploy ingress + `apps/web-dashboard` builder | `VERIFIED_SOURCE`. |
| 7 | FurlPay Proof-of-Reserve | `por-kernel/`, `tools/por-*` | `VERIFIED_SOURCE` (+ `DEPLOYED` on testnet per `docs/VERIFIED-BASELINE.md`). |
| 8 | Stellar Soroban Contract | `contracts/por-verifier/` | `DEPLOYED` (testnet) + `VERIFIED_SOURCE` (25 tests). |
| 9 | Edge Trading Engine | `trading-engine/` | `PARTIAL` — paper/demo only. |
| 10 | Unified Web-to-Android Sync | `apps/web-dashboard` outbox + `server/realtime.mjs` | `VERIFIED_SOURCE` (14 tests). |
| 11 | Edge Tunnel & Shield Fabric | `edge/mobilecloud-tunnel`, `edge/mobilecloud-shield` | `VERIFIED_SOURCE`. |
| 12 | Platform Services | `apps/web-dashboard/lib/server/*` | `VERIFIED_SOURCE` — functions/workflows/webhooks/metering/PoR view. |

The complete, per-feature execution audit (operational vs limited vs
record-only vs absent) is in [`FEATURE-REPORT.md`](FEATURE-REPORT.md); this
audit does not restate it.

---

## 4. Findings

### 4.1 Genuinely absent (no implementation exists)

These are the honest gaps the program must close. Each is currently
documented as "Not implemented" in `README.md` §Release status:

1. **On-device AI/ML inference** — no inference runtime, model registry,
   executor, or inference API anywhere in the repo (`FEATURE-REPORT.md` §15).
2. **Fleet mesh transport & orchestration** — the `fleet-mesh` crate now
   implements node management (this audit's era), but **peer discovery,
   device-to-device transport, load balancing, replication, and distributed job
   orchestration do not exist.**
3. **Billing & payments** — usage is metered into append-only counters; there is
   no payment provider, invoice, or charge path (`FEATURE-REPORT.md` §19).
4. **Dashboard → engine dispatch** — the console records deployment requests; it
   does not dispatch them (`README.md` §Release status).

### 4.2 Partially implemented (real code, limited scope)

- **Trading**: real arithmetic and risk invariants; execution is paper/demo.
- **Data layer**: real SQLite + transactional outbox; no multi-control-plane
  scaling, no conflict resolution beyond last-write-wins.
- **Observability**: request-percentile view exists in the dashboard; no
  OpenTelemetry, no distributed tracing, no alerting.
- **Android**: verified by build + lint, not by an automated test suite.

### 4.3 Security-relevant observations (pre-existing, unchanged by this audit)

- Local build preview runs in the plain app UID — **not sandboxed** (documented).
- `core-engine` deliberately serialises builds through a 1-permit semaphore
  (returns `429`) and caps concurrent deployments at 16 (`503`); this is
  host-protection by design and is covered by tests. Any change must preserve it.
- SSH refuses a non-loopback bind without an authorised Ed25519 key.
- No dependency-vulnerability scan (`cargo audit` / `npm audit`) is wired into
  CI — recorded as a Phase 12 gap, not run in this pass.

### 4.4 Not run / not measured in this audit

- `cargo clippy --all-targets` on the full workspace (only `core-engine` was
  clippy-clean at commit `00a1254`).
- `npm audit`, `cargo audit`, `cargo deny`.
- The k6 load harness (`benchmarks/k6-load-test.js`) — it ships declared
  thresholds, **not** recorded results.

---

## 5. Baseline conclusion

The repository is a **coherent, tested, honest local-evaluation build**:
262 green tests, real build/serve/terminal/PoR code, and a Release-status table
that correctly labels its own gaps. The work ahead is *additive* — build the
absent subsystems (§4.1) without regressing the 262-test baseline, and never
upgrade a status tag without executed evidence.

The phase plan lives in [`IMPLEMENTATION_ROADMAP.md`](IMPLEMENTATION_ROADMAP.md).
