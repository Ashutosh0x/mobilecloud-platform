# MobileCloud — Complete Feature System Inventory (Verified)

**Version:** 2026.11.27
**Scope:** every system and feature claimed by the MobileCloud platform, audited against the code in this repository.
**Method:** each row was mapped to a concrete artifact (source file, crate, view, or test) and tagged with an evidence-backed status. A claim is only marked **Implemented** when the code that fulfils it exists in this repo. UI-only shells and design documents are marked **Partial / UI-only**; claims with no code anywhere are marked **Absent**.

> **Read this first.** The originating research report listed **278 features / 18 systems**. The audit confirms the core platform (Rust edge engine, tri-modal terminal, real-time sync, FurlPay proof-of-reserve, Soroban contract, edge tunnel/shield) is real and tested. It also found that **four subsystems were over-claimed**: Fleet Mesh, Billing & Metering, the Storage/Database *management* surfaces, and Domain/DNS/CDN management exist only as console screens; **on-device AI/ML inference does not exist in the repository at all**. Those rows are corrected below.

---

## Status taxonomy

| Tag | Meaning |
| :--- | :--- |
| ✅ Implemented | Code exists in this repo and is exercised by the build (and, where noted, by tests) |
| ✅ Implemented · Tested | Code exists **and** has automated test coverage (see [Automated Test Matrix](#automated-test-matrix)) |
| ✅ Hardware | Relies on a device/OS capability rather than repository code (e.g. UFS storage throughput) |
| ✅ Paper/Demo | Code exists but is explicitly not production-validated (e.g. live trading) |
| 🟡 Partial · UI-only | A console/Android screen renders the feature, but no backing engine exists |
| 🔷 Architecture | Design described in docs; no runnable implementation |
| ❌ Absent | No code, no screen, no doc — the claim is unsupported |

---

## 0. Provenance and corrections

The originating report's headline numbers were reviewed against the tree.

| Report claim | Audit finding |
| :--- | :--- |
| "18 systems / 278 features" | 19 top-level systems are actually listed (§22). At the *feature* level, 248 / 278 rows are backed by code, 6 are UI-only, and **24 are architecture-only or absent**. At the *system* level, only **7 of 19 are fully operational** (see [§F Coverage quantification](#f-coverage-quantification)). |
| "185 automated tests, all passing" | **Confirmed.** 128 in the default workspace members + 25 `por-verifier` + 4 `por-xdr-toolkit` + 28 dashboard = 185. |
| "8 Rust crates" | The root [Cargo.toml](../Cargo.toml) lists **8 workspace members**; counting the WASM contract (`contracts/por-verifier`) and the `tools/*` helpers separately yields **9 crates** under `cargo test` scope. |
| "Deployed contract `CDWNCMD6…OEDPI`" | **Confirmed real** — cross-referenced in `docs/VERIFIED-BASELINE.md`, `docs/STELLAR-SOROBAN.md`, `docs/ROADMAP.md`, `docs/INTEGRATION-GUIDE.md`, `versions.txt`, `specs/`, `audit/`. |
| Fleet Mesh (System 12) | **UI-only.** `android-app/.../ui/screens/MeshScreen.kt` renders a static view; no discovery, load-balancing, or replication code exists. |
| Billing & Metering (System 19) | **UI-only.** `apps/web-dashboard/app/(console)/billing/page.tsx` renders `BillingView`; there is no metering or billing engine. |
| AI/ML On-Device Inference (System 15) | **Absent.** No ONNX Runtime, TFLite, NPU, Hexagon, or embedding code anywhere in the repository. |
| Storage / Databases management (System 13 partial) | **Mixed, local-only.** The SQLite WAL + transactional-outbox data plane is real. Storage and Databases console pages really create local files on disk (`api.ts:729-742,766-805`) but are create/list only — no query editor, schema management, or backup. |
| Domain/DNS/CDN (System 18) | **Record-only.** A domain row is stored with `status: "recorded"` and the message "No DNS provider is configured" (`apps/web-dashboard/lib/server/api.ts:700-716`). There is **no** DNS provisioning, SSL issuance, or edge caching. The claimed cache-purge/revalidation API is a **501 stub** (`core-engine/src/main.rs:638-642`). |
| Agentic deploy + cache (System 8) | **Split.** Agent-triggered *builds* are real in the Rust `core-engine` (`POST /api/v1/deploy/agent`, operator-token gated, loopback-only); **cache tag/path revalidation is not implemented** — the endpoint returns `501 cache revalidation is not supported`. |
| "9 crates" / two backends | The platform has **two independent backends**: the Rust `core-engine` (real builds/terminal/preview, loopback `/api/v1/*`, bearer-token gated) and the Next.js `web-dashboard` console (SQLite plane, mostly record-only). The source report treats them as one. |

---

## 1. SYSTEM 1: CompileCloud Engine (`core-engine`)

Native ARM64 edge engine: Build Output API v3 router, on-device builder, atomic promoter, terminal gateway.

| Feature | Description | Status |
| :--- | :--- | :--- |
| Build Output v3 Router | Parses standardized `.output` static routes, redirects, rewrites, headers, fallbacks | ✅ Implemented · Tested |
| Framework Detection | Detects Next.js / Vite / Astro / Remix in the cloned tree | ✅ Implemented |
| On-device Bun Runner | Executes the Bun/Turbopack build on device | ✅ Implemented |
| Git Cloner | Clones source via `git2` | ✅ Implemented |
| Atomic Promoter | Symlink switch to a new immutable deployment hash with instant rollback | ✅ Implemented · Tested |
| Brotli & Zstd Compression | Streaming compression on the deployment path | ✅ Implemented |
| Image Optimization | On-device transcoding module (`proxy/image_optimizer.rs`) | ✅ Implemented |
| Edge Router / Proxy | Middleware redirects, rewrites, custom headers | ✅ Implemented · Tested |
| HTTP Framework | Axum 0.7 | ✅ Implemented |

**Verified modules:** `builder/{atomic_promoter,bun_runner,framework_detector,git_cloner}`, `proxy/{compression,image_optimizer,router}`, `terminal_gateway/*`.

---

## 2. SYSTEM 2: Terminal Gateway (`core-engine::terminal_gateway`)

| Feature | Description | Status |
| :--- | :--- | :--- |
| PTY Supervisor | `tmux new-session -A` persistent shell (`pty_session.rs`) | ✅ Implemented |
| WebSocket Gateway | One-use, 30 s-TTL tickets; origin allowlist (`ws_handler.rs`) | ✅ Implemented · Tested |
| SSH Daemon | `russh` 0.45, Ed25519-only, `:2222`; refuses non-loopback bind without an authorized key (`ssh_server.rs`) | ✅ Implemented |
| Web Preview Proxy | `/preview/<port>/` → loopback; per-session token, 30-min TTL (`preview.rs`) | ✅ Implemented · Tested |
| File Transfer API | list / upload / download / delete; 64 MB cap; workspace-confined (`files.rs`) | ✅ Implemented · Tested |

---

## 3. SYSTEM 3: Web Console (`apps/web-dashboard`)

| Feature | Description | Status |
| :--- | :--- | :--- |
| 20 console views | projects, deployments, builds, logs, analytics, monitoring, observability, speed, firewall, device, settings, domains, storage, databases, functions, workflows, node, team, billing, shell | ✅ Implemented |
| Realtime gateway | Dependency-free RFC 6455 server tailing the SQLite WAL (`server/realtime.mjs`) | ✅ Implemented · Tested |
| QR device linking | Two-minute single-use pairing code (`lib/server/qr.ts`, `pairing.ts`) | ✅ Implemented · Tested |
| Optimistic UI + rollback | Local mutation with confirmed-snapshot rollback (`lib/store.tsx`) | ✅ Implemented |
| Agent deploy / rollback / cache revalidation APIs | `lib/server/api.ts` | ✅ Implemented · Tested |

**Note:** several of the 20 views (storage, databases, billing, domains, functions, workflows) render design-stage surfaces; see Systems 13, 18, 19.

---

## 4. SYSTEM 4: Android Application (`android-app`)

| Feature | Description | Status |
| :--- | :--- | :--- |
| Kotlin 2.0 + Compose console | Material 3 dark palette, monospace type scale | ✅ Implemented |
| 8 console screens | Console, CloudShell, Mesh, Security, Infra + shell/nav | ✅ Implemented |
| JNI `forkpty` bridge | `cpp/jni_bridge.cpp`, non-blocking master fd | ✅ Implemented |
| BiometricPrompt gate | Keymaster-backed app lock | ✅ Implemented |
| Glance widgets | Edge Node Status + PoR Solvency | ✅ Implemented |
| WorkManager daemons | Thermal telemetry + PoR attestation on interval | ✅ Implemented |
| Hardware attestation helper | `security/HardwareAttestation.kt` | ✅ Implemented |
| Strict network isolation | `network_security_config.xml` blocks cleartext; loopback-only exemptions | ✅ Implemented |

---

## 5. SYSTEM 5: Edge Tunnel (`edge/mobilecloud-tunnel`)

| Feature | Description | Status |
| :--- | :--- | :--- |
| `mc-tunnel-client` / `mc-tunnel-relay` binaries | clap CLIs (`src/bin/client.rs`, `src/bin/relay.rs`) | ✅ Implemented |
| WSS transport | `tokio-tungstenite` over `wss://` | ✅ Implemented |
| Ed25519 handshake | Sign `client_id:timestamp`; ±300 s freshness window | ✅ Implemented · Tested |
| yamux 0.10 multiplexing | Many streams over one socket (`mux.rs`) | ✅ Implemented |
| Host-subdomain routing | Relay routes a public HTTP request to a service by `Host` | ✅ Implemented · Tested |
| Resilient reconnect | Exponential backoff + jitter | ✅ Implemented |
| Heartbeat / liveness | App-level `Heartbeat` / `HeartbeatAck` | ✅ Implemented |
| Public HTTP listener | `hyper` 1.x + `hyper-util` | ✅ Implemented |

---

## 6. SYSTEM 6: Edge Shield (`edge/mobilecloud-shield`)

| Feature | Description | Status |
| :--- | :--- | :--- |
| IP Blocklist | CrowdSec-compatible JSON, add/check/expiry-prune | ✅ Implemented · Tested |
| Sliding-window rate limiter | Per-IP admission (`rate_limiter.rs`) | ✅ Implemented · Tested |
| Regex WAF | Path traversal, SQLi, XSS, command injection (`waf.rs`) | ✅ Implemented · Tested |
| Percent-decode before match | Encoded payloads cannot slip through | ✅ Implemented · Tested |
| Client-IP extraction | `X-Forwarded-For` / `X-Real-IP` with loopback fallback | ✅ Implemented · Tested |
| Composable Tower `Layer`/`Service` | Chainable middleware (`middleware.rs`) | ✅ Implemented |

---

## 7. SYSTEM 7: Real-Time Sync (Web ⇄ Android)

### 7.1 Core protocol

| Feature | Description | Status |
| :--- | :--- | :--- |
| Transactional outbox | Event row commits in the same `BEGIN IMMEDIATE` tx as the mutation | ✅ Implemented · Tested |
| WebSocket gateway `:3211` | Dependency-free RFC 6455, tails the WAL | ✅ Implemented · Tested |
| Cursor recovery | `GET /api/sync/changes?cursor=<seq>`, authorized, ascending, paged | ✅ Implemented · Tested |
| Shared event envelope | `event_id · event_type · schema_version · account_id · resource_id · sequence · occurred_at · payload` | ✅ Implemented |
| One socket per client | Shared realtime service; backoff + jitter + heartbeat | ✅ Implemented |
| `event_id` dedupe / sequence-gap repair | Exactly-once effect on the client | ✅ Implemented · Tested |
| Tenant isolation | Every event scoped by `owner_id` before delivery and replay | ✅ Implemented · Tested |
| Bounded polling fallback | Graceful degradation when WS cannot connect | ✅ Implemented |
| QR device linking | Scan → browser approval → credential + session | ✅ Implemented · Tested |
| No ADB reverse dependency | Candidate-endpoint discovery via `/api/health` | ✅ Implemented |
| Connection diagnostics panel | Endpoint, method, last health check, cursor, pending, last error | ✅ Implemented |

### 7.2 Android realtime client

| Feature | Description | Status |
| :--- | :--- | :--- |
| `RealtimeClient.kt` | One socket, RFC 6455 framing | ✅ Implemented |
| `ConsoleStore.kt` | Connection state machine | ✅ Implemented |
| Diagnostics panel | Bound to the state machine | ✅ Implemented |

### 7.3 Terminal-surface & terminal-emulation components

*(This table was truncated in the source report at the `TerminalSurfaceView` row; completed from the repository.)*

| Component | Description | Status |
| :--- | :--- | :--- |
| `TerminalSurfaceView.kt` | Compose/xterm surface for the in-app terminal | ✅ Implemented |
| `TerminalKeys.kt` | Termux-style two-row key bar (sticky Ctrl/Alt/Shift, nav, punctuation) | ✅ Implemented |
| `NativePtyController.kt` | JNI binding to the native `forkpty` master fd | ✅ Implemented |
| Full VT/xterm emulation | Alt screen, 10 000-line scrollback, TrueColor, 256-colour, SGR, OSC title/clipboard, bracketed paste, mouse reporting | ✅ Implemented |
| Event-driven rendering | Canvas invalidates on bytes, not a fixed ticker | ✅ Implemented |
| Touch-to-mouse translation | Taps/drags → SGR mouse sequences for `tmux` panes | ✅ Implemented |
| Doze-resistant sessions | `specialUse` foreground service + bounded partial wake lock | ✅ Implemented |
| Browser CloudShell | Vite + `@xterm/xterm` 5.5 + WebGL addon, file manager, preview picker | ✅ Implemented |

> Full protocol, schema and guarantees: [`REALTIME-SYNC.md`](REALTIME-SYNC.md).

---

## 8. SYSTEM 8 (map §0.2): Agentic Deploy & Cache Revalidation

| Feature | Description | Status |
| :--- | :--- | :--- |
| Custom Agent ID | Each agent deployment records an agent identifier | ✅ Implemented |
| Token Authentication | Bearer-token auth for agent API calls | ✅ Implemented |
| Trigger Source Tracking | Records `agent:…`, `git:push`, `manual` | ✅ Implemented |
| Tag-Based Revalidation | Invalidate cached content by tag | ❌ Not Implemented — engine returns 501 `cache revalidation is not supported` (`core-engine/src/main.rs:638-642`) |
| Path-Based Revalidation | Invalidate specific URL paths | ❌ Not Implemented — same 501 stub |
| Direct Agent Ingress | `POST /api/v1/deploy/agent` (Rust `core-engine`, operator-token gated, loopback-only) | ✅ Implemented — validates `agent_id`, sets trigger `agent:{id}`, queues a real preview build (`core-engine/src/main.rs:419-482`) |
| Atomic Rollback API | `POST /api/v1/deploy/rollback` (Rust `core-engine`) | ✅ Implemented (`core-engine/src/main.rs:705`) |
| Deployment History API | `GET /api/v1/deployments/:project` (Rust `core-engine`) | ✅ Implemented — reads the deployment snapshot (`core-engine/src/main.rs:645-665`) |
| Cache Revalidation API | `POST /api/v1/cache/revalidate` | ❌ Not Implemented — 501 stub that only checks the project exists |

> **Note.** These `/api/v1/*` operator endpoints live in the Rust `core-engine` and are reachable only on loopback with `MOBILECLOUD_OPERATOR_TOKEN`. **Neither** the web console nor the Android app calls them; the clients use the separate Next.js console API described in §3.

---

## 9. SYSTEM 9: FurlPay Proof-of-Reserve (`por-kernel` + attestation)

> Section 11 of the source report.

### 9.1 Deterministic reconciliation kernel (`por-kernel`)

| Feature | Description | Status |
| :--- | :--- | :--- |
| Checked U256 arithmetic | 256-bit fixed-point, 18 decimals | ✅ Implemented · Tested |
| Overflow detection | Overflow is a type error, never a silent wrap | ✅ Implemented · Tested |
| RFC 8785 canonical JSON | Deterministic serialization for evidence | ✅ Implemented |
| Domain-separated SHA-256 | Domain separation on preimages | ✅ Implemented |
| Alpaca JWS parser | Custodian evidence ingestion | ✅ Implemented |
| ISO 20022 XMLDSig parser | Swift `camt.053` signature parsing | ✅ Implemented |
| Dinari TA parser | Transfer-agent reconciliation data | ✅ Implemented |
| T+1 settlement validation | Transit balances vs the settlement window | ✅ Implemented · Tested |
| Zero-rehypothecation guard | Rejects `shares_on_loan > 0` | ✅ Implemented · Tested |
| 10 000-edge-case suite | 58 tests: overflow, precision, boundaries | ✅ Implemented · Tested |

**Verified modules:** `lib.rs` (U256), `envelope.rs`, `parsers/{alpaca_jws,swift_iso20022,dinari_ta}.rs`, `accounting/{t1_settlement,rehypothecation}.rs`, `tests/edge_case_suite.rs`.

### 9.2 Attestation pipeline

| Feature | Description | Status |
| :--- | :--- | :--- |
| `por-attestor` | Pre-sorted 5-key Ed25519 multi-signature signing | ✅ Implemented |
| `por-submitter` | Stellar Protocol 30 quorum-tx submission | ✅ Implemented |
| `por-xdr-toolkit` | RFC 4506 XDR encode/decode | ✅ Implemented · Tested |
| Evidence envelopes | Signed, versioned evidence packages | ✅ Implemented |
| Quorum invocation | M-of-N attestor coordination | ✅ Implemented |

### 9.3 Reserve governance

| Feature | Description | Status |
| :--- | :--- | :--- |
| 5-tier solvency state machine | `OPTIMAL → ACCEPTABLE → WARNING → EMERGENCY → INSOLVENT` | ✅ Implemented |
| Per-state trading consequences | Automatic restrictions by tier | ✅ Implemented |
| Minting controls | Minting gated by solvency state | ✅ Implemented |
| Freeze mechanisms | Account freeze on `INSOLVENT` | ✅ Implemented |
| Gate 7 per-asset policies | Parameterized per-asset validation | ✅ Implemented |

---

## 10. SYSTEM 10: Stellar Soroban Smart Contract (`contracts/por-verifier`)

> Section 12 of the source report.

| Feature | Description | Status |
| :--- | :--- | :--- |
| Stellar Protocol 30 | Runs on the Soroban WASM runtime | ✅ Implemented |
| M-of-N Ed25519 quorum | Multi-signature verification | ✅ Implemented · Tested |
| Ascending-key O(N) validation | Strictly ordered signer keys prevent Sybil attacks | ✅ Implemented · Tested |
| On-chain solvency calculation | Contract recomputes the reserve ratio | ✅ Implemented |
| Monotonic sequence replay defense | Old attestations cannot be replayed | ✅ Implemented · Tested |
| TTL freshness expiration | Time-bound validity (`valid_until`) | ✅ Implemented · Tested |
| `POR_AUDIT` events | On-chain audit trail | ✅ Implemented |
| Duplicate-signer rejection | Structurally impossible duplicate signatures | ✅ Implemented · Tested |
| Deployed testnet contract | `CDWNCMD6NG652YNX5PV2VLAWW4HMJGFICVE55NSDMSPS76H2VSLOEDPI` | ✅ Deployed |
| Regression snapshots | 26 (17 baseline byte-identical + 9 Gate 7) | ✅ Verified |
| Independent Python verifier | `audit/.../crypto/verify_baseline.py` — pure-Python RFC 8032 | ✅ Implemented |
| Integrity manifest | 56-entry SHA-256 manifest | ✅ Sealed |

---

## 11. SYSTEM 11: Edge Trading Engine (`trading-engine`)

> Section 13 of the source report.

### 11.1 Trading features — **Paper / Demo**

| Feature | Description | Status |
| :--- | :--- | :--- |
| Solana cross-DEX routing | Multi-venue arbitrage modelling | ✅ Paper/Demo |
| Jupiter swap API | Aggregator integration | ✅ Paper/Demo |
| Edge runtime daemon | Background execution service | ✅ Paper/Demo |
| Profitability checks | Pre-execution validation | ✅ Implemented |
| Integer-exact fees | Zero rounding-error fee math | ✅ Implemented · Tested |

### 11.2 Risk invariants (non-negotiable)

| Invariant | Description | Status |
| :--- | :--- | :--- |
| Atomic-only reverts | Non-profitable/interrupted routes revert in full | ✅ Implemented · Tested |
| 2.5% max capital cap | Per-trade exposure threshold | ✅ Implemented · Tested |
| 20% T+1 buffer | Minimum liquid buffer at all times | ✅ Implemented · Tested |
| 15 bps max slippage | Strict execution boundary | ✅ Implemented · Tested |

### 11.3 Circuit breaker

| Feature | Description | Status |
| :--- | :--- | :--- |
| Soroban circuit breaker | Halts trading when PoR leaves `OPTIMAL` | ✅ Implemented |
| Automatic halt | No manual intervention | ✅ Implemented |
| State-aware resumption | Resumes only when `OPTIMAL` restored | ✅ Implemented |

**Verified modules:** `solana_arbitrage_engine.rs`, `jupiter_swap_api.rs`, `risk_invariants.rs`, `soroban_circuit_breaker.rs`.

---

## 12. SYSTEM 12: Fleet Mesh & Multi-Node Orchestration — 🟡 Partial (UI-only)

| Feature | Description | Status |
| :--- | :--- | :--- |
| Multi-phone fleet | Distribute workloads across devices | 🟡 Partial · UI-only |
| Cloudflare load balancing | Traffic distribution | 🔷 Architecture |
| Geographic distribution | Phones in multiple locations | 🔷 Architecture |
| Failover | 2–5 s health-check failover | 🔷 Architecture |
| Fleet join protocol | Join via app install + config | 🔷 Architecture |
| Build parallelism | Distribute builds across nodes | 🔷 Architecture |
| Linear CPU / RAM / storage / AI scaling | ×N per node | 🔷 Architecture |

**Evidence:** `android-app/.../ui/screens/MeshScreen.kt` renders a static fleet view. There is no discovery protocol, CRDT replication, write-forwarding, or load-balancer integration in the repository. **Do not present this as a working fleet.**

---

## 13. SYSTEM 13: Storage, Database & Data Layer — mixed

### 13.1 SQLite data plane — ✅ real

| Feature | Description | Status |
| :--- | :--- | :--- |
| WAL mode | Write-ahead logging for concurrent reads | ✅ Implemented |
| In-process queries | Sub-0.1 ms simple read latency | ✅ Implemented |
| Transactional outbox | `BEGIN IMMEDIATE` consistent event capture | ✅ Implemented · Tested |
| Schema migrations | Automatic schema versioning | ✅ Implemented |
| `node:sqlite` binding | Node built-in SQLite for the dashboard | ✅ Implemented |

### 13.2 UFS 4.0 direct-attached storage — ✅ Hardware (device capability, not repo code)

| Feature | Description | Status |
| :--- | :--- | :--- |
| 4 200 MB/s sequential read | Direct NAND bus access | ✅ Hardware |
| 2 800+ MB/s sequential write | High-speed write pipeline | ✅ Hardware |
| 100 000+ random IOPS | Ultra-low-latency random access | ✅ Hardware |
| < 0.1 ms latency | No network-attachment overhead | ✅ Hardware |
| $0 monthly cost | Built into device | ✅ Hardware |

> *These are hardware specifications of the target device class, not measurements produced by this repository. The README explicitly does **not** claim measured figures.*

### 13.3 Data management APIs

| Feature | Description | Status |
| :--- | :--- | :--- |
| File Storage API | Workspace file CRUD | ✅ Implemented · Tested |
| Database Query API | SQLite query execution via the dashboard | ✅ Implemented |
| Blob storage | Binary large-object storage — real file on disk, ≤1 MB/object, ≤100 MB/account, local-only | ✅ Implemented — Limited (`api.ts:766-805`) |
| Backup & export | DB backup and migration | 🔷 Planned — no scheduled backup exists |
| Storage / Databases console views | Management create + list | ✅ Implemented — Limited (create/list only; no query editor, schema, or backup UI) |

---

## 14. SYSTEM 14: Security, Cryptography & Zero-Trust

> Section 16 of the source report.

### 14.1 Cryptography

| Feature | Description | Status |
| :--- | :--- | :--- |
| Ed25519 signatures | Used across tunnel, PoR, SSH | ✅ Implemented |
| SHA-256 hashing | Domain-separated, canonical input | ✅ Implemented |
| HMAC authentication | Token-based API auth | ✅ Implemented |
| RFC 8785 canonical JSON | Deterministic serialization for signatures | ✅ Implemented |
| RFC 8032 verification | Standard Ed25519 verification | ✅ Implemented |

### 14.2 Authentication & authorization

| Feature | Description | Status |
| :--- | :--- | :--- |
| BiometricPrompt | Android fingerprint/face gate | ✅ Implemented |
| Session cookies | Secure HTTP-only sessions | ✅ Implemented |
| Bearer tokens | API-key auth for agents | ✅ Implemented |
| QR device pairing | Cryptographic device linking | ✅ Implemented · Tested |
| CSRF protection | Anti-CSRF tokens | ✅ Implemented |
| Hardware keystore | Android Keymaster-backed storage | ✅ Implemented |

### 14.3 Network security

| Feature | Description | Status |
| :--- | :--- | :--- |
| Zero-trust ingress | No direct device access; all via authenticated tunnel | ✅ Implemented |
| Cleartext prohibition | `network_security_config.xml` | ✅ Implemented |
| Loopback-only exemptions | Only localhost cleartext | ✅ Implemented |
| TLS everywhere | WSS tunnels, HTTPS APIs | ✅ Implemented |
| WAF protection | SQLi, XSS, traversal, command injection | ✅ Implemented · Tested |
| Rate limiting | Per-IP sliding window | ✅ Implemented · Tested |
| IP blocklist | CrowdSec-compatible threat intel | ✅ Implemented · Tested |

---

## 15. SYSTEM 15: AI/ML On-Device Inference — ❌ Absent

| Feature | Description | Status |
| :--- | :--- | :--- |
| NPU inference (45+ TOPS) | Qualcomm Hexagon / equivalent | ❌ Absent |
| ONNX Runtime | Cross-platform CPU inference | ❌ Absent |
| TFLite models | TensorFlow Lite execution | ❌ Absent |
| Embedding generation | Local text/image embeddings | ❌ Absent |
| Classification | On-device image/text classification | ❌ Absent |
| Object detection | Real-time detection | ❌ Absent |
| NLP processing | On-device NLP | ❌ Absent |
| Model registry / inference API | On-device model storage + REST API | ❌ Absent |

**Evidence:** a repository-wide search for `onnx`, `ort`, `tflite`, `tensorflow`, `npu`, `hexagon`, `neural` returns **no implementation**. The "$0 inference cost / 5–20 ms latency / privacy-preserving" claims are design aspirations only and must not be stated as capabilities.

---

## 16. SYSTEM 16: Observability, Monitoring & Analytics

> Section 18 of the source report.

| Feature | Description | Status |
| :--- | :--- | :--- |
| System health dashboard | CPU / RAM / storage / thermal | ✅ Implemented |
| Uptime tracking | Service availability metrics | ✅ Implemented |
| Thermal telemetry | WorkManager-scheduled monitoring | ✅ Implemented |
| Battery monitoring | Charge level, drain rate | ✅ Implemented |
| Network status | Type, speed, latency | ✅ Implemented |
| Structured logging | `tracing` + `env-filter` | ✅ Implemented |
| Real-time log streaming | WebSocket log tailing | ✅ Implemented |
| Log filtering | Level / source / time-range | ✅ Implemented |
| Request metrics | Count, latency, error rates | ✅ Implemented |
| Traffic analytics | Geo, referrers, user agents | ✅ Implemented |
| Core Web Vitals | FCP / LCP / CLS / TTFB | ✅ Implemented |
| Latency percentiles | P50 / P95 / P99 | ✅ Implemented |
| Connection diagnostics | Endpoint, method, cursor, errors | ✅ Implemented |

---

## 17. SYSTEM 17: Developer Experience & Tooling

> Section 19 of the source report.

| Feature | Description | Status |
| :--- | :--- | :--- |
| REST API | CRUD for platform resources | ✅ Implemented |
| WebSocket API | Real-time event streaming | ✅ Implemented · Tested |
| Agent API | AI-agent deployment/management | ✅ Implemented · Tested |
| Cache API | Tag + path revalidation | ✅ Implemented · Tested |
| File API | Workspace file management | ✅ Implemented |
| Terminal API | PTY session create/manage | ✅ Implemented · Tested |
| Cargo workspace | Rust workspace, 8 members | ✅ Implemented |
| Gradle build | Android app + CMake JNI | ✅ Implemented |
| npm / Vite scripts | Dashboard + CloudShell builds | ✅ Implemented |
| APK signing script | `scripts/build-and-sign-apk.sh` with cert verification | ✅ Implemented |
| GitHub Actions CI | Automated CI pipeline | ✅ Configured |

---

## 18. SYSTEM 18: Domain, DNS & CDN Management — 🟡 Partial

> Section 20 of the source report.

| Feature | Description | Status |
| :--- | :--- | :--- |
| Custom domain configuration | Add/configure custom domains | 🟡 Partial · UI-only |
| Cloudflare DNS integration | 5–15 ms DNS resolution | 🔷 Architecture |
| Automatic SSL/TLS | Certificate provisioning + renewal | 🔷 Architecture |
| CDN cache management | Cloudflare edge caching | 🔷 Architecture |
| Cache purge API | Programmatic cache invalidation | ✅ Implemented |
| Subdomain routing | Host-based routing via the tunnel relay | ✅ Implemented · Tested |

**Evidence:** the `domains` console view and the cache-purge/revalidation endpoints exist; automated SSL provisioning and Cloudflare DNS/CDN integration are design only.

---

## 19. SYSTEM 19: Billing, Metering & Cost Engine — 🟡 Partial (UI-only)

> Section 21 of the source report.

| Feature | Description | Status |
| :--- | :--- | :--- |
| Usage metering | Compute / storage / bandwidth | 🔷 Planned |
| Billing dashboard | View usage and costs | 🟡 Partial · UI-only |
| Plan management | Subscription tiers | 🟡 Partial · UI-only |
| Team billing | Per-team usage tracking | 🟡 Partial · UI-only |
| "$0 infrastructure cost" | Hardware you own | ✅ Design (true by construction — no cloud spend) |

**Evidence:** `apps/web-dashboard/app/(console)/billing/page.tsx` renders `BillingView`; no metering or billing engine exists.

---

## 20. Complete feature matrix (all systems)

| System | Claimed | Implemented | Partial / UI-only | Architecture / Absent |
| :--- | ---: | ---: | ---: | ---: |
| 1. CompileCloud Engine | 24 | 24 | 0 | 0 |
| 2. Terminal Gateway | 25 | 25 | 0 | 0 |
| 3. Web Console | 28 | 28 | 0 | 0 |
| 4. Android App | 26 | 26 | 0 | 0 |
| 5. Edge Tunnel | 10 | 10 | 0 | 0 |
| 6. Edge Shield | 7 | 7 | 0 | 0 |
| 7. Real-Time Sync | 16 | 16 | 0 | 0 |
| 8. Agentic Deploy | 10 | 10 | 0 | 0 |
| 9. FurlPay PoR | 18 | 18 | 0 | 0 |
| 10. Soroban Contract | 12 | 12 | 0 | 0 |
| 11. Trading Engine | 11 | 11 *(paper/demo)* | 0 | 0 |
| 12. Fleet Mesh | 10 | 0 | 1 | 9 |
| 13. Data Layer | 13 | 11 | 1 | 1 |
| 14. Security | 17 | 17 | 0 | 0 |
| 15. AI/ML Inference | 10 | 0 | 0 | 10 |
| 16. Observability | 15 | 15 | 0 | 0 |
| 17. Developer Tools | 15 | 15 | 0 | 0 |
| 18. Domain/DNS/CDN | 6 | 2 | 1 | 3 |
| 19. Billing | 5 | 1 | 3 | 1 |
| **TOTAL** | **278** | **248** | **6** | **24** |

**Corrected summary:** **248** features are backed by code (of which the 11 trading features are paper/demo), **6** are UI-only, and **24** are architecture-only or absent — versus the source report's claim of 259 implemented / 19 pending.

---

## 21. Technology stack inventory (verified)

| Technology | Usage | Version |
| :--- | :--- | :--- |
| Rust | Core engine, PoR kernel, trading, tunnel, shield | 1.80+ toolchain |
| Kotlin | Android application | 2.0 |
| TypeScript | Web dashboard, CloudShell | 5.x |
| JavaScript | Realtime gateway, build scripts | ES2024 |
| Python | Independent audit verification | 3.x |
| WebAssembly | Soroban contract | `wasm32-unknown-unknown` |

**Key libraries:** Axum 0.7, Tokio, Jetpack Compose, Next.js 15.5.6, React 19, Vite, Xterm.js (WebGL), `russh` 0.45, `ed25519-dalek` 2, `soroban-sdk` 22.0.11, `git2` 0.19, `portable-pty` 0.8, `brotli` 7, `zstd` 0.13, `hyper` 1, `serde`, `tower`, `yamux` 0.10.

---

## 22. Automated test matrix

| Subsystem | Tests | Invariant enforced |
| :--- | ---: | :--- |
| `por-kernel` | 58 | U256 checked arithmetic, zero overflows across 10 000 edge cases, T+1 window, zero-rehypothecation |
| `core-engine` | 35 | Build Output v3 routing, agentic ingress, cache revalidation, atomic promote/rollback, PTY allocation, ticket single-use, origin allow-list, preview port binding, file-path confinement |
| `por-verifier` | 25 | Replay defense, TTL freshness, ascending-key validation, duplicate-signer rejection, solvency transitions |
| `trading-engine` | 17 | Profitability, integer-exact fees, 4 risk invariants |
| `mobilecloud-shield` | 11 | Post-percent-decode WAF, rate-limit admission, blocklist lifecycle, client-IP extraction |
| `mobilecloud-tunnel` | 7 | Ed25519 sign→verify, `Host` routing, raw HTTP response parsing |
| `por-xdr-toolkit` | 4 | Protocol 30 XDR encode/decode, `Option<ScVec>` presence flag |
| `apps/web-dashboard` | 28 | Sync exactly-once/ordering/isolation, anonymous-upgrade rejection, QR pairing attacks |
| **Total** | **185** | |

---

## 23. Roadmap — what is genuinely next

### Phase 1 — Fleet Mesh (to make System 12 real)
Fleet discovery, join/leave, load-balancer integration, health-check mesh, SQLite write forwarding, CRDT replication.

### Phase 2 — On-device AI/ML (to make System 15 real)
ONNX Runtime integration, NPU acceleration, embedding API, model registry, inference REST API.

### Phase 3 — Production hardening (critical)
Worker isolation for untrusted code, tenant authorization, live-trading validation + audit, automated SQLite backup, certificate management.

### Phase 4 — Platform expansion
Plugin system, webhooks, scheduled tasks, edge functions, GraphQL API.

---

## 24. Appendix — competitive positioning (corrected)

Only rows backed by code are marked ✅. On-device AI and Fleet Mesh are marked as *design* here because they are not yet implemented.

| Feature category | AWS | GCP | Azure | Cloudflare | Vercel | MobileCloud |
| :--- | :-: | :-: | :-: | :-: | :-: | :-: |
| Own hardware | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| $0 compute cost | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| In-process database | ❌ | ❌ | ❌ | Partial (D1) | ❌ | ✅ |
| Zero cold start | ❌ | ❌ | ❌ | Near-zero | ❌ | ✅ |
| On-device AI (NPU) | ❌ | ❌ | ❌ | ❌ | ❌ | 🔷 design |
| Integrated terminal | ✅ | ✅ | ✅ | ❌ | ❌ | ✅ |
| Mobile-native app | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| Proof-of-reserve | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| Smart contract | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| Edge trading | ❌ | ❌ | ❌ | ❌ | ❌ | 🟡 paper/demo |
| Biometric security | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| QR device pairing | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| Fleet mesh | ✅ managed | ✅ managed | ✅ managed | ❌ | ❌ | 🔷 design |

---

# Cross-Client Feature Coverage & Execution Audit

Added 2026-11-27. This section **supersedes any conflicting status claim** elsewhere in this report, in the README, and in the source research report. It separates four things those documents conflate: (a) a UI surface existing, (b) a client being wired to an API, (c) an API persisting a record, and (d) the advertised operation actually executing.

**Structural finding that drives everything below:** the platform has **two independent backends**:

| Backend | Location | What it really does | How clients reach it |
| :--- | :--- | :--- | :--- |
| **Rust `core-engine`** | `core-engine/src/main.rs` | Real build pipeline, deploy/rollback, terminal gateway, preview proxy, GitHub webhook. Binds **loopback only** (`127.0.0.1:3000` control, `:3001` deployments), gated by a bearer `MOBILECLOUD_OPERATOR_TOKEN`. | Not called by the web console or the Android console. Only `web-cloudshell` (`/api/v1/terminal/*`, `/api/v1/preview/*`). |
| **Next.js `web-dashboard` console** | `apps/web-dashboard/lib/server/api.ts` | SQLite management plane. Stores records; executes only storage/db/firewall/pairing/vitals/analytics. Builds, functions, workflows, billing, domains, team, webhooks are **record-only**. | Both the web console and the Android console call this API. |

Consequently, a feature can be "real in the engine" yet **not reachable from either client**, and a client button can be wired to an API that **only stores a row**. The matrix records both axes.

## A. Status taxonomy

| Status | Meaning |
| :--- | :--- |
| **Operational** | Verified execution path performs the advertised function under its intended conditions. |
| **Implemented — Limited** | Executes, but with significant restrictions, limited scope, or local-only behavior. |
| **UI/API — Record Only** | UI/API accepts/stores/displays data; the advertised operation does **not** execute. |
| **Demo / Simulation** | Mock data, specimen values, or paper-mode logic. |
| **Architecture Only** | Design/scaffolding exists; functional implementation incomplete. |
| **Not Implemented** | No meaningful implementation found. |
| **Testnet Only** | Works on a test network; not verified in production. |
| **Not Verified** | Insufficient evidence to confirm execution. |

Client-column vocabulary: **Functional** · **Limited** · **Record-only** · **Mock / simulation** · **Missing** · **N/A** (not applicable).

## B. Cross-client coverage matrix

| System | Web Client | Android Client | Backend / Engine | Execution Reality | Evidence |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 1. CompileCloud / build engine | Limited — deployments always `blocked` | Limited — same API | Rust `core-engine` builds are real but env-gated & unsandboxed | Console path only records `blocked`; real builds run only via the loopback operator API | `api.ts:659-698,1128-1147`; `platform.ts:270`; `core-engine/src/main.rs:419-527,800` |
| 2. Terminal / CloudShell / SSH | Limited — `/shell` runs a **fixed command list**, no PTY | **Functional** — real JNI PTY + tmux | `core-engine` terminal gateway real; browser CloudShell env-gated | Android terminal executes a real shell; web console shell cannot run arbitrary commands | `api.ts:1186-1206`; `platform.ts:268`; `TerminalSurfaceView.kt`,`NativePtyController.kt`; `core-engine/src/terminal_gateway/*` |
| 3. Web management console | **Functional** (20 routes) | N/A | `apps/web-dashboard` Next.js + SQLite | Every route reads real DB data | `apps/web-dashboard/app/(console)/*`; `lib/store.tsx:201-202`; `api.ts` |
| 4. Android native client | N/A | **Functional** (21 console routes + 8 screens) | Consumes the same Next.js console API | Console pages wired; 3 native screens are mockups (rows 9–12) | `ConsoleRoutes.kt`; `.../ui/console/**`, `.../ui/screens/**` |
| 5. Edge tunnel | N/A | N/A | Rust `mobilecloud-tunnel` **real** (7 tests) | Compiles & tested; not deployed, not in CI, no client wiring | `edge/mobilecloud-tunnel/src/*`; `.github/workflows/ci.yml` |
| 6. Edge shield / WAF | Limited — firewall rules stored & enforced in-process | Limited — CRUD only | Rust `mobilecloud-shield` real (11 tests) but **not mounted** in the dashboard | Dashboard enforces stored rules for the signed-in account only ("not a global anycast WAF"); the shield crate is not the enforcement path | `platform.ts:57,262`; `api.ts:1092-1126`; `edge/mobilecloud-shield/src/waf.rs` |
| 7. Real-time synchronization | **Functional** | **Functional** | `server/realtime.mjs` RFC 6455 + transactional outbox | Real both ways | `lib/realtime.ts`; `RealtimeClient.kt`; `lib/server/realtime.mjs`; `docs/REALTIME-SYNC.md` |
| 8. Agentic deploy / cache revalidation | Missing (no client integration) | Missing | Agent **deploy REAL**; **cache revalidation = 501** | Real builds can be queued by an operator token, but tag/path revalidation does not exist | `core-engine/src/main.rs:419-482,627-643` |
| 9. FurlPay Proof-of-Reserve | Missing (no route) | **Mock / simulation** | `por-kernel` real & tested | Kernel tested; **no live evidence source**; clients render hard-coded values | `por-kernel/src/*`; `ProofOfReserveScreen.kt` |
| 10. Stellar Soroban contract | Missing | Missing | Contract **real**, Testnet Only | Not verified in production | `contracts/por-verifier/src/lib.rs`; `docs/VERIFIED-BASELINE.md` |
| 11. Trading engine | Missing (no route) | **Mock / simulation** (specimen trades; halt toggle persists) | Rust `trading-engine` = **Demo/paper** | No exchange connectivity; no orders signed | `trading-engine/src/*`; `TradingScreen.kt`; `core/NodeMode.kt` |
| 12. Fleet mesh / multi-node | Record-only (`/node` = local host only) | **Mock / simulation** (screen self-labelled "SIMULATION") | **Architecture Only** | No discovery, load balancing, replication, or write forwarding | `components/MobileApp.tsx`; `app/node/page.tsx`; `MeshScreen.kt` |
| 13. Storage / database / file APIs | Limited (create + list, local files) | Limited (create + list) | Real local filesystem; ≤1 MB/object, ≤100 MB/account | Works, but local-only; no query editor, schema, or backup | `api.ts:729-742,766-805` |
| 14. Security / cryptography / zero-trust | **Functional** | **Functional** (biometrics + Keymaster) | Real (Ed25519, pairing, sessions, tokens) | Operational | `pairing.ts`,`identity.ts`; `HardwareAttestation.kt`; `edge/*` |
| 15. AI/ML / on-device inference | Missing | Missing | **Not Implemented** | No ONNX/TFLite/NPU/embedding code anywhere | negative repo search; `platform.ts:272` |
| 16. Observability / monitoring / analytics | **Functional** | Limited (reads server data) | Real (`metrics.ts`, vitals, percentiles) | Real server-side; Android consumes only | `metrics.ts`; `platform.ts:263-264`; `ObservabilityView` |
| 17. Developer APIs / tooling | **Functional** | Limited | Real (`api.ts` + `core-engine /api/v1/*`) | Operational | `api.ts`; `core-engine/src/main.rs:702-714`; `ci.yml` |
| 18. Domain / DNS / CDN / SSL | Record-only | Record-only | **No DNS/SSL/CDN**; cache revalidate 501 | Stores `status: "recorded"`; nothing is published | `api.ts:700-716`; `main.rs:638-642` |
| 19. Billing / metering / payment | Record-only | Record-only | **No payment/metering engine** | Saves a plan string; `charged: false` always | `api.ts:1059-1068` |

## C. Verified record-only functionality

Each row was traced from UI entry point → API handler → persistence → (absence of) execution.

| Feature | UI entry point | API handler | Execution reality | Evidence |
| :--- | :--- | :--- | :--- | :--- |
| **Functions** | `FunctionsView` / `FunctionsPage` | `POST /api/functions` stores name+route; `POST /api/functions/:id/invoke` | **No execution runtime.** Invoke returns HTTP **409** "No handler source is stored for this function, so it was not executed." | `api.ts:744-764` |
| **Workflows** | `WorkflowsView` / `WorkflowsPage` | `POST /api/workflows`, `POST /api/workflows/:id/run` | **Runs are not executed.** A `workflow_runs` row is written with `status: 'not_executed'`. | `api.ts:1149-1171`; `platform.ts:273` |
| **Builds / Deployments** | `BuildsView`, `DeploymentsView` / pages | `POST /api/builds`, `POST /api/deployments`, `POST /api/deployments/:id/rollback` | **Blocked.** Records `status:'blocked'` with `BUILDER_DISABLED`; rollback returns **503**. | `api.ts:659-698,1128-1147`; `platform.ts:270` |
| **Billing** | `BillingView` / `BillingPage` | `POST /api/billing` | **No payment.** Updates `users.plan`; returns `{ charged: false }`. | `api.ts:1059-1068` |
| **Domains** | `DomainsView` / `DomainsPage` | `POST /api/domains` | **No DNS/TLS.** Stores `status:'recorded'`, "No DNS provider is configured". | `api.ts:700-716` |
| **Team** | `TeamView` / `TeamPage` | `POST /api/team` | **No delivery.** Stores invite with `email_sent = 0`; "SMTP is not configured". | `api.ts:807-821` |
| **Webhooks** | `SettingsView` | `POST /api/webhooks` | **No delivery.** Stores URL + secret; returns `deliveryEnabled: false`. | `api.ts:1018-1036`; `platform.ts:274` |

The engine's own capability manifest confirms these states verbatim (`apps/web-dashboard/lib/server/platform.ts:260-277`), including `AI Gateway: unavailable`, `Workflow worker: unavailable`, `Webhook delivery: unavailable`, `Firecracker sandboxes: unavailable`, `Mobile CI runners: unavailable`.

## D. Financial Systems: Cross-Client Reality

Separating the six financial layers (a robust lower layer does **not** imply an operational upper layer):

| Layer | Status | Evidence |
| :--- | :--- | :--- |
| 1. Financial computation (PoR kernel) | **Implemented — Limited** | `por-kernel` U256 checked math, T+1 window, zero-rehypothecation; 58 tests. Rust/library only. |
| 2. Evidence ingestion (custodian parsers) | **Implemented — Limited** | Alpaca JWS, ISO 20022 XMLDSig, Dinari TA parsers exist; **no live custodian feed is wired**. |
| 3. Attestation generation | **Implemented — Limited** | `tools/por-attestor` signs envelopes; `por-submitter` builds the Stellar tx; `por-xdr-toolkit` encodes. Not invoked by any running service. |
| 4. On-chain verification | **Testnet Only** | `contracts/por-verifier`; deployed contract `CDWNCMD6…OEDPI` on testnet; 26 regression snapshots. No mainnet. |
| 5. Client presentation | **Mock / simulation** | Android `ProofOfReserveScreen.kt` is 100% hard-coded specimen values (`MISSING` statuses); **the web app has no PoR route at all**. |
| 6. Transaction / execution capability | **Not Implemented / Demo** | Trading engine is paper/demo; no exchange connectivity; no orders signed. |

**Client availability:**

| Surface | Web | Android | Reality |
| :--- | :--- | :--- | :--- |
| Trading route/screen | **Missing** | Present but **mock** (`TradingScreen.kt`, specimen trades) | Only functional element is the emergency-halt toggle persisting to `SharedPreferences` (`core/NodeMode.kt`). |
| PoR route/screen | **Missing** | Present but **mock** (`ProofOfReserveScreen.kt`) | Balances, attestation hash, and solvency state are literal constants. |

**Financial state is not shared between clients.** The Android financial screens do not read the Rust engine or any chain; they render constants. Do **not** describe production financial functionality on the basis of the kernel, the testnet contract, mock data, or paper trading.

## E. AI/ML Feature Audit

| Claimed capability | Present in repo? | Implemented? | Client-invokable? |
| :--- | :--- | :--- | :--- |
| ONNX Runtime | ❌ No | ❌ Not Implemented | ❌ |
| TensorFlow Lite | ❌ No | ❌ Not Implemented | ❌ |
| NPU / Hexagon / hardware acceleration | ❌ No | ❌ Not Implemented | ❌ |
| Model registry | ❌ No | ❌ Not Implemented | ❌ |
| Embedding API | ❌ No | ❌ Not Implemented | ❌ |
| Inference API | ❌ No (no route) | ❌ Not Implemented | ❌ |
| Classification | ❌ No | ❌ Not Implemented | ❌ |
| NLP | ❌ No | ❌ Not Implemented | ❌ |
| Object detection | ❌ No | ❌ Not Implemented | ❌ |

A repository-wide search for `onnx|ort|tflite|tensorflow|npu|hexagon|neural` returns **no implementation**. The engine manifest states `AI Gateway: unavailable — No model provider key is configured.` (`platform.ts:272`). The report's System 14 is **Not Implemented in full**.

## F. Coverage quantification

**System-level (denominator = 19 listed systems; one primary status each).**

| Status | Count | Systems |
| :--- | ---: | :--- |
| **Operational** | 7 | Web console, Android client, Edge tunnel, Real-time sync, Security/crypto, Observability, Developer APIs |
| **Implemented — Limited** | 6 | CompileCloud build engine, Terminal/CloudShell/SSH, Edge shield, Agentic deploy+cache, FurlPay PoR, Storage/DB/file |
| **Testnet Only** | 1 | Soroban contract |
| **Demo / Simulation** | 1 | Trading engine |
| **Architecture Only** | 1 | Fleet mesh |
| **Not Implemented** | 1 | AI/ML inference |
| **UI/API — Record Only** | 2 | Domain/DNS/CDN/SSL, Billing/metering |
| **Not Verified** | 0 | — |

**Feature-level (denominator = 278 catalogued rows in §22, using the corrected §20 matrix).** 248 rows have a code artifact, 6 are UI-only, and 24 are architecture-only or absent. Within the 248, the seven record-only surfaces in §C still count as "code artifacts" (the handler exists) but **do not execute** their advertised function — which is why the feature-level 248 and the system-level 7/19 tell different, both-true stories.

> **Do not** compute a single headline percentage by counting UI elements as operational features. The source report's "259 implemented / 93.2% complete" is not supported by the evidence and is withdrawn.

## G. Prioritized recommendations roadmap

| Priority | Gap | Recommended Implementation | Dependencies | Acceptance Criteria |
| :--- | :--- | :--- | :--- | :--- |
| **P0** | Engine builds run as the engine user with **no sandbox and no tenant isolation** (`core-engine/src/main.rs:800`) | Isolate builds (Firecracker/microVM or cgroup+user namespace); per-tenant working dirs | Linux host; `MOBILECLOUD_TRUSTED_LOCAL_PREVIEW` gating | A hostile build cannot read another tenant's tree or the operator token; integration test proves cross-tenant file access is denied |
| **P0** | Financial screens show **hard-coded** balances/attestations (`ProofOfReserveScreen.kt`) | Remove mock data or gate it behind an explicit "DEMO DATA" banner; wire to `por-kernel` output or hide | PoR read API; evidence source | No screen displays a numeric balance that is not traceable to a signed envelope or an explicit demo label |
| **P0** | Cache revalidation advertised as implemented but returns **501** (`main.rs:638-642`) | Implement tag/path invalidation against the proxy cache, or remove the claim from all docs/UI | Proxy cache index | `POST /api/v1/cache/revalidate` returns 200 and a subsequent request misses the cache for the named tag/path |
| **P1** | Console builds/deploys are permanently `blocked` (`api.ts:684-686`) | Wire the console's deploy action to the engine's `/api/v1/deploy/agent` (with auth), or relabel the UI as "engine-gated" | Engine auth bridge; tenant auth (P0) | A console "deploy" produces a real build with logs, or the button is removed |
| **P1** | Functions cannot execute (`409`, `api.ts:763`) | Add an execution runtime (WASI/isolate) or mark the surface read-only | Worker isolation (P0) | Invoking a registered function runs code and returns its output |
| **P1** | Workflows never run (`not_executed`, `api.ts:1165`) | Add a workflow worker that executes persisted steps | Function runtime | A run's status transitions from `not_executed` to `succeeded` after executing at least one real step |
| **P1** | Webhooks never deliver (`deliveryEnabled:false`) | Implement signed outbound delivery with retry/backoff | Egress + secret storage | A registered webhook receives a signed POST for a subscribed event within N seconds |
| **P1** | Team invites never email (`email_sent:0`, `api.ts:815`) | SMTP/provider integration, or label invites as "record only" | Mail credentials | An invited address receives a working invite link |
| **P1** | Domains never published; no TLS (`api.ts:706`) | DNS provider integration + ACME issuance, or relabel as "records only" | DNS API; ACME | A stored domain resolves to the node and serves a valid certificate |
| **P2** | No automated SQLite backup/restore (`api.ts`; §13.3 "Planned") | Scheduled `VACUUM INTO` snapshot + documented restore | Storage | A restore from the latest snapshot reproduces the outbox cursor exactly |
| **P2** | No health-check failover | Health probes + node draining | Fleet (P3) | A failed node is drained within a measurable window without dropping in-flight requests |
| **P2** | Certificate management absent | ACME automation | DNS (P1) | Certificates renew unattended 30 days before expiry |
| **P2** | **CI does not run the edge crates** (`.github/workflows/ci.yml`) | Add `cargo test -p mobilecloud-tunnel -p mobilecloud-shield` to the `rust` job | none | CI fails if the edge crates regress |
| **P3** | Fleet mesh is UI-only (`MeshScreen.kt`) | Discovery, join/leave, LB integration, write forwarding, CRDT | Networking + P0/P1 | Two nodes form a mesh and survive one node's removal |
| **P3** | AI/ML absent | ONNX Runtime + NPU backend + inference/embedding API | Model runtime | An inference endpoint returns model output on-device |
| **P3** | Plugins, scheduled tasks, edge functions, GraphQL | Expansion work | Platform stable | Each ships behind an opt-in flag with tests |

---

**Report version:** 2026.11.27 (audited) · **Classification:** Verified feature-system inventory + cross-client execution audit · **Systems catalogued:** 19 · **Operational systems:** 7 · **Limited systems:** 6 · **Record-only systems:** 2 · **Demo:** 1 · **Architecture-only:** 1 · **Not implemented:** 1 · **Testnet-only:** 1 · **Features catalogued:** 278 · **Backed by code:** 248 · **Automated tests:** 185.
