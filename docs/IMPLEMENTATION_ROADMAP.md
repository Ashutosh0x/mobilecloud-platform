# MobileCloud — Implementation Roadmap

**Governed by:** the MobileCloud Master Engineering Implementation Prompt (12
phases). This file is the single source of truth for *what is actually done*,
*what is in progress*, and *what has not been started*. It is updated as each
phase lands — a phase is only marked done when its code is merged and its tests
pass.

Baseline: see [`IMPLEMENTATION_AUDIT.md`](IMPLEMENTATION_AUDIT.md) —
**262 green tests** (2026-11-27). No phase may reduce this count or turn a test
red to obtain a passing build.

---

## Phase status

| Phase | Deliverable | Status | Evidence |
| ---: | :--- | :--- | :--- |
| 0 | Full repository audit + baseline docs | **Done** | `IMPLEMENTATION_AUDIT.md`, this file, `SECURITY_THREAT_MODEL.md`, `PRODUCTION_READINESS.md`; 262 tests recounted. |
| 1 | Harden the existing 58 features | **Partial** | Route-table caching, precompressed sidecar serving, and streamed artifact hashing landed in `core-engine` (commit `00a1254`) with 3 new tests. Per-feature hardening continues. |
| 2 | On-device AI/ML inference | **Not started** | No inference code exists. |
| 3 | Distributed fleet mesh | **Partial (vertical slice)** | `fleet-mesh` crate: identity, registry, replay-protected heartbeats, revocation, telemetry provenance, health, placement, authenticated API — 43 tests. Transport, discovery, load balancing, replication, orchestration **not** implemented. |
| 4 | Dashboard → engine dispatch | **Not started** | Console still records only. |
| 5 | Billing & payments | **Not started** | Metering exists; no provider/invoice/charge. |
| 6 | Hardware & energy telemetry | **Partial (types only)** | `fleet-mesh::telemetry` defines the provenance taxonomy (`Measured`/`OsReported`/`Estimated`/`Unsupported`) and validation, but no Android-side collector feeds it yet. |
| 7 | CloudShell & edge security hardening | **Not started** (beyond existing controls) | Existing controls live in `core-engine/src/terminal_gateway` and `edge/mobilecloud-shield`. |
| 8 | Autonomous agent execution | **Not started** | Agent ingress/rotation APIs exist; scoped-permission framework not built. |
| 9 | Proof-of-Reserve & Soroban hardening | **Not started** (beyond existing) | Baseline already covers checked arithmetic, canonical JSON, quorum, replay; remaining items are additive adversarial vectors. |
| 10 | Trading integrations | **Not started** | Paper/demo only; no exchange adapter. |
| 11 | Observability & distributed reliability | **Not started** | Outbox exists; tracing, tracing correlation, alerting, DLQ not built. |
| 12 | Performance, security & production validation | **Not started** | No vulnerability scan or reproducible benchmark recording wired into CI. |

> **Honesty rule:** a phase marked *Partial* is not complete. The program is not
> finished until every row above is *Done* with evidence, or is explicitly
> re-scoped with a documented, evidence-backed reason.

---

## Per-phase plan and acceptance criteria

### Phase 1 — Harden the existing 58 features
- **Goal:** verify every documented feature against source + tests; fix real defects; never downgrade.
- **Landed:** per-deployment compiled route-table cache; `br`/`gzip` sidecar serving confined to the artifact root; streamed, length-framed artifact hashing. Preserved: 1-permit build semaphore (`429`), 16-permit deployment semaphore (`503`).
- **Acceptance (met for the landed slice):** new tests assert cache reuse and sidecar path confinement; full workspace still green.

### Phase 2 — On-device AI/ML inference
- **Goal:** a real Android inference subsystem — runtime (ONNX Runtime Mobile / LiteRT), model download + cryptographic integrity verification, versioning/rollback, memory-aware loading, CPU/GPU/NPU capability detection with hardware-aware EP selection, thermal/battery-aware scheduling, cancellation/timeout, quotas, lifecycle, performance monitoring, secure model storage, authenticated inference APIs, model registry + executor.
- **Hard constraint:** NPU acceleration may be claimed **only** where hardware execution is independently verified.
- **Acceptance:** a model runs on a real device; benchmark numbers recorded with device model + runtime version; unsupported accelerators reported as `Unsupported`.

### Phase 3 — Distributed fleet mesh
- **Goal:** coordinated multi-device infrastructure that assumes devices are *not* continuously available (Doze, thermal throttling, disconnects, shutdown).
- **Landed (slice):** device enrollment with Ed25519 identity; cryptographic `NodeId` derivation; registration + revocation; replay-protected signed heartbeats; resource/telemetry reporting with provenance; liveness + stale/offline sweeps; deterministic resource-aware placement; fail-closed authenticated API.
- **Remaining:** peer discovery, device-to-device authenticated + encrypted transport, NAT traversal, connection recovery, partition detection, peer reputation/trust, rate limiting on the mesh path, job assignment/ack/retry/migration, duplicate-execution protection, fleet dashboard wiring.
- **Acceptance:** two nodes authenticate and exchange a real work unit; a partition and a revocation are both handled without duplicate execution.

### Phase 4 — Dashboard → engine dispatch
- **Goal:** console actions perform real backend operations. Authenticated dispatch API, job submission/validation, execution authorization, queueing, scheduling, device assignment, live status, cancellation, retry policy, failure reporting, logs, deployment history, rollback integration.
- **Reuse:** existing WebSocket gateway and transactional outbox.
- **Acceptance:** end-to-end E2E run (register → link → create → build → promote → preview → monitor → rollback) with no fake success status; idempotency + tenant isolation asserted.

### Phase 5 — Billing & payments
- **Goal:** usage-based billing. Metering (compute/CPU/memory/storage/bandwidth/deployments/inference/API/fleet-node), aggregation, plans, subscriptions, invoices, reconciliation, credits, history, payment status, refunds/adjustments, enterprise billing; double-entry accounting, immutable audit events, idempotent payments, signed webhook processing.
- **Constraint:** sandbox/simulation providers first; credentials in server-side secret management; **never** present a test payment as a real settlement; keep infrastructure billing separate from FurlPay PoR.
- **Acceptance:** metered usage reconciles against independently counted usage; a sandbox payment round-trips; a duplicate payment is rejected idempotently.

### Phase 6 — Hardware & energy telemetry
- **Goal:** expose, where Android APIs permit, CPU arch/availability, memory, storage, network, battery level/temperature, thermal status, power estimates, uptime, runtime performance — each tagged `Measured`/`OsReported`/`Estimated`/`Unsupported`; energy-efficiency benchmarks.
- **Constraint:** do not invent attestation, enclave guarantees, power figures, or savings. Hardware-backed attestation only where supported and independently verified.
- **Landed:** the provenance + validation types in `fleet-mesh::telemetry` (rejects `Unsupported` carrying data, battery > 100%, used > total).
- **Acceptance:** a real device's report round-trips with correct provenance tags; every estimate is labelled.

### Phase 7 — CloudShell & edge security hardening
- **Goal:** strict filesystem isolation, path-traversal prevention, process sandboxing, SSH auth hardening, session expiry, resource limits, process termination, network isolation, secret isolation, tenant separation, command auditing, secure file transfer + upload caps, input validation, abuse detection, WAF rules, IP/identity rate limits, temporary credentials; fail-closed defaults.
- **Review targets:** JNI `forkpty`, SSH daemon, web preview endpoints, reverse tunnels, every execution API.
- **Acceptance:** adversarial tests for privilege escalation, path traversal, command injection, SSRF, unauthorised access, replay, tenant-boundary violation.

### Phase 8 — Autonomous agent execution
- **Goal:** authorised agent→infrastructure framework (inspect/submit/upload/deploy/revalidate/monitor/logs/rollback/utilization) with agent auth, scoped permissions, tool authorization, signed requests, execution policies, approval gates, rate limits, immutable action logs, idempotency, failure recovery.
- **Hard constraint:** an agent must never obtain unrestricted host-shell, infrastructure-credential, or private-signing-key access. Preserve existing agent ingress/deployment APIs.
- **Acceptance:** an agent with a narrow scope is refused out-of-scope actions; attempts to reach a host shell/credential/key fail.

### Phase 9 — Proof-of-Reserve & Soroban hardening
- **Goal:** checked 256-bit arithmetic, overflow/underflow protection, RFC 8785 canonical JSON, domain separation, cryptographic input validation, multi-source ingestion, Alpaca/ISO 20022/Dinari, T+1 verification, zero-rehypothecation, reconciliation, asset/liability consistency, duplicate detection, freshness, provenance, audit trails; deterministic vectors + adversarial cases.
- **Soroban:** solvency recomputation, quorum validation, ascending-key O(N), governance state transitions, authorization, emergency pause, upgrade governance, replay protection, input validation, storage integrity, event emission.
- **Constraint:** testnet only; no production contract deploy without explicit approval + independent review.
- **Acceptance:** adversarial vectors fail closed; existing 25 contract tests + `por-kernel` suites stay green.

### Phase 10 — Trading integrations
- **Goal:** strict paper / testnet / live separation; exchange + DEX adapters, market-data ingestion, order validation, liquidity checks, slippage protection, fees, transaction simulation, risk checks, position limits, execution reconciliation, circuit breakers, failure recovery.
- **Constraint:** preserve the four risk invariants and the Soroban circuit breaker; **live trading disabled by default** and gated behind explicit authorization; never present a simulated trade as real.
- **Acceptance:** mode is unambiguously reported; live mode cannot activate without authorization.

### Phase 11 — Observability & distributed reliability
- **Goal:** structured logging, metrics, distributed tracing, request correlation, device/deployment/job/queue metrics, API latency, error rates, resource utilization, tunnel health, WebSocket diagnostics, PoR events, alerting; OpenTelemetry-compatible. Harden: transactional outbox, idempotent event processing, event versioning, cursor sync, replay, DLQ, retry, conflict resolution, consistency checks, backups, recovery, migration validation, authoritative-state declaration.
- **Constraint:** do not collect secrets or unnecessary PII in telemetry.
- **Acceptance:** duplicate deployment/payment/execution events are demonstrably prevented; a dashboard shows real latency/error/queue metrics.

### Phase 12 — Performance, security & production validation
- **Goal:** benchmark every critical path (build, artifact serving, compression, image latency, terminal responsiveness, SSH setup, tunnel throughput, WS sync latency, D2D comms, scheduling latency, inference latency, memory/CPU/energy); optimise only after a reproducible baseline. Full test pyramid: unit, integration, E2E, security, resilience. CI/CD, env separation, migrations, health/readiness, rollback, backups, DR, runbooks, incident response.
- **Constraint:** no benchmark claim that cannot be reproduced.
- **Acceptance:** reproducibility statement (hardware + versions) attached to every number; security suite covers the named attack classes; recovery runbook executed at least once.

---

## Architecture Decision Record (ADR)

Decisions made during this program, in order, with the reason. The master
prompt's §18 requires recording them.

| ID | Decision | Rationale |
| :--- | :--- | :--- |
| ADR-001 | Document, do not delete, the over-claimed subsystems. | §18 "never fake production functionality": the honest path is to keep the real parts and label the rest. |
| ADR-002 | Keep the `[CRITICAL]` build-queue concurrency as a **single** permit (`429` when busy). | The benchmark report suggested parallelising it; the single permit is deliberate host protection and is covered by a test asserting the `429`. Rejected the change. |
| ADR-003 | Do **not** migrate the synchronous build/serve filesystem code to `tokio::fs`. | High regression risk against a working, tested path for an unmeasured gain. Rejected pending a reproducible baseline. |
| ADR-004 | Do **not** add a shared `node_modules` cache across builds. | Contradicts `bun_runner.rs`'s invariant of never giving a build a shared writable dependency cache. |
| ADR-005 | Add `fleet-mesh` as a **new workspace crate** rather than extending `core-engine`. | Keeps the edge-engine binary free of fleet concerns; enables independent testing (43 tests) and independent build. |
| ADR-006 | `fleet-mesh` telemetry **encodes provenance in the type system** (`MeasurementSource`). | §20 requires distinguishing measurement from estimate; a type makes it impossible to report an unlabelled value. |
| ADR-007 | `fleet-mesh` enrollment/heartbeat tokens are compared **constant-time**, and every auth failure returns `401`. | Fail-closed, no timing oracle, no panic on malformed input. |
| ADR-008 | Heartbeats carry a **strictly-increasing** `seq`; replays/gaps are refused (`409`). | Replay protection is a prerequisite for trusting any fleet telemetry. |
| ADR-009 | Keep `docs/ARCHITECTURE.md` (PoR-focused) and **append** a repo component map rather than replace it. | The existing document is accurate and tightly scoped; §18 forbids needless rewrites. |
| ADR-010 | Prefer additive docs (`IMPLEMENTATION_*`, `SECURITY_THREAT_MODEL`, `PRODUCTION_READINESS`) over editing the existing PoR docs. | Keeps the two audiences (institutional PoR verifiers vs platform engineering) separate. |
| ADR-011 | Benchmark/threshold statements are labelled as *declared thresholds*, never as recorded results. | §18 rule 13: never fabricate test results. |

---

## Out of scope until explicitly authorised

- Any **live** financial or blockchain deployment (mainnet contract, live
  trading, real payment settlement). Testnet/sandbox only.
- Any claim of NPU/energy/attestation capability without independently verified
  hardware evidence.
