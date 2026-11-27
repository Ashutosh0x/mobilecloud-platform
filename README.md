<div align="center">

![MobileCloud Banner](assets/mobilecloud_concept.jpg)

### **The Autonomous Smartphone Edge Cloud & Institutional Proof-of-Reserve Protocol**

[![CI Status](https://img.shields.io/badge/CI-Passing-2ea44f?style=for-the-badge&logo=githubactions&logoColor=white)](.github/workflows/ci.yml)
[![Tests](https://img.shields.io/badge/Tests-358%20Passed-brightgreen?style=for-the-badge&logo=checkmarx&logoColor=white)](#automated-test-matrix)
[![Rust](https://img.shields.io/badge/Rust-1.100-dea584?style=for-the-badge&logo=rust&logoColor=white)](Cargo.toml)
[![Android](https://img.shields.io/badge/Android-API%2030--35-3ddc84?style=for-the-badge&logo=android&logoColor=white)](android-app)
[![Kotlin](https://img.shields.io/badge/Kotlin-2.0-7f52ff?style=for-the-badge&logo=kotlin&logoColor=white)](android-app)
[![Next.js](https://img.shields.io/badge/Next.js-15.5-000000?style=for-the-badge&logo=nextdotjs&logoColor=white)](apps/web-dashboard)
[![React](https://img.shields.io/badge/React-19-61DAFB?style=for-the-badge&logo=react&logoColor=black)](apps/web-dashboard)
[![Terminal](https://img.shields.io/badge/Terminal-Xterm.js%20WebGL%20%2B%20PTY%20%2B%20SSH-F80000?style=for-the-badge&logo=iterm2&logoColor=white)](docs/CLOUDSHELL.md)
[![Real-Time Sync](https://img.shields.io/badge/Real--Time%20Sync-WebSocket%20%2B%20Outbox-0070f3?style=for-the-badge&logo=socketdotio&logoColor=white)](docs/REALTIME-SYNC.md)
[![Auth](https://img.shields.io/badge/Auth-Passkeys%20%2B%20OAuth%202.1-00B4AB?style=for-the-badge&logoColor=white)](docs/AUTH.md)
[![SSO](https://img.shields.io/badge/SSO-OIDC%20%2B%20SAML%20%2B%20SCIM-6E40C9?style=for-the-badge&logoColor=white)](docs/SSO.md)
[![Edge](https://img.shields.io/badge/Edge-Cloudflare%20Tunnel%20%2B%20PWA-F38020?style=for-the-badge&logo=cloudflare&logoColor=white)](deploy/furlpay)
[![CLI](https://img.shields.io/badge/CLI-mobilecloud-000000?style=for-the-badge&logo=rust&logoColor=white)](cli)
[![SQLite](https://img.shields.io/badge/SQLite-WAL%20Outbox-003B57?style=for-the-badge&logo=sqlite&logoColor=white)](docs/REALTIME-SYNC.md)
[![Stellar](https://img.shields.io/badge/Stellar-Protocol%2030-08b5e5?style=for-the-badge&logo=stellar&logoColor=white)](contracts/por-verifier)
[![Ed25519](https://img.shields.io/badge/Ed25519-232F3E?style=for-the-badge&logo=gnubash&logoColor=white)](core-engine)
[![Edge Tunnel](https://img.shields.io/badge/Edge_Tunnel-yamux_%2B_WSS-6E40C9?style=for-the-badge&logo=websocket&logoColor=white)](edge/mobilecloud-tunnel)
[![Edge Shield](https://img.shields.io/badge/Edge_Shield-WAF_%2B_Rate_Limit-0A3069?style=for-the-badge&logo=shield&logoColor=white)](edge/mobilecloud-shield)

<br/>

**MobileCloud** turns off-the-shelf Android smartphones into edge servers with an inbuilt tri-modal terminal gateway, and carries the FurlPay proof-of-reserve protocol: a deterministic reconciliation kernel, a Stellar Soroban verifier, and cryptographic attestation.

The web console and the Android app are two synchronized clients of one backend: one account, one data model, one durable event log, live both ways. The same account signs in on four surfaces — Android, the web console, the browser CloudShell, and the `mobilecloud` CLI — with passkeys, phone-approved QR login, and an independent, revocable session per client.

[Architecture](#system-architecture) • [Terminal](#3-tri-modal-terminal--cloudshell-gateway) • [Auth](#13-unified-authentication--the-mobilecloud-cli) • [Real-Time Sync](#unified-real-time-web--android-synchronization) • [Features](#detailed-platform-features) • [Tech Stack](#technology-stack) • [Benchmarks](#performance--benchmark-matrix) • [Test Matrix](#automated-test-matrix) • [Quick Start](#quick-start) • [Audit Baseline](#cryptographic-audit--integrity)

</div>

---

## Release status

**This is a local evaluation build.** Read this before the feature list, because the feature list describes what the code does, not what has been measured in production.

| Claim | Status |
| :--- | :--- |
| Android APK | A **console client**. It does not run the Rust edge engine. |
| Dashboard project deployments | The dashboard **records** deployment and build requests; it does not dispatch them to the engine. Engine dispatch is disabled until isolated workers and tenant authorization exist. |
| Functions runtime | **Bounded, in-process.** A function stores a JavaScript handler and runs in a `node:vm` context with no `require`, `process`, `fetch`, filesystem, or timers — synchronously, under a 250 ms wall-clock timeout. It isolates globals, not the process; it is not a sandbox for hostile code. |
| Workflow worker | **In-process.** A workflow stores an ordered step list that references your own functions; a run executes each step, threads its output into the next, and stops at the first failure. |
| Webhook delivery | **Working.** A delivery is queued in the same transaction as its event, signed with HMAC-SHA256, retried with capped exponential backoff up to 5 attempts, and recorded in a delivery log. Loopback and private targets are refused. |
| Local build preview | **Not sandboxed.** The preview runs in the plain app UID. Do not run untrusted repositories. |
| Browser CloudShell | **Working.** Requires a running edge engine and a trusted gateway in front of it. |
| SSH daemon | **Working.** Refuses a non-loopback bind unless an Ed25519 key is authorized. |
| Authentication & CLI | **Implemented and covered by tests.** Passkeys (WebAuthn), "Login with MobileCloud" QR approval, RFC 8628 device grant and PKCE, client-scoped sessions with rotating refresh tokens, an append-only audit trail, and a weighted login risk engine. The `mobilecloud` CLI signs in, refreshes, lists devices and sessions, and revokes both. **Not done:** the Android approval screen and notifier compile but are not yet routed from `MainActivity`; no FCM/APNs push transport is configured; passkey attestation is `none` (AAGUID recorded, not verified). |
| Trading engine | **Paper / demo.** Not validated for live execution. |
| Proof of reserve | The control plane stores the Rust kernel's reconciliation output **read-only** and reports an explicit unverified state when no attestation exists; it never computes a ratio itself. Verified against the Stellar **testnet**. Custody and CPA attestation are `NOT_ESTABLISHED`. |
| On-device AI/ML inference (ONNX, TFLite, NPU) | **Not implemented.** No inference code exists in this repository. |
| Fleet mesh | **Node-management slice implemented** in the `fleet-mesh` crate: enrollment, Ed25519 device identity, replay-protected signed heartbeats, revocation, liveness sweeps, capability/energy telemetry with measurement provenance, and deterministic resource-aware placement, behind a fail-closed authenticated API. **Not yet implemented:** peer discovery, device-to-device transport (NAT traversal/encryption), load balancing, replication, distributed job orchestration, and dashboard wiring. No device-to-device traffic has been exercised on real hardware. |
| Billing & payments | **Not implemented.** Usage is metered (append-only counters per meter), but there is no payment provider, invoicing, or charging. |
| Hardware battery bypass, energy figures, "zero-millisecond UPS" | **Not claimed.** No measurement in this repository supports them. |

> The full, evidence-backed audit of every claimed system and feature — including the subsystems above that the source report over-claimed — is in [`docs/FEATURE-REPORT.md`](docs/FEATURE-REPORT.md).

---

## Technology Stack

### Languages & Runtime Engines
<p align="left">
  <img src="https://img.shields.io/badge/Rust-000000?style=for-the-badge&logo=rust&logoColor=white" alt="Rust" />
  <img src="https://img.shields.io/badge/Kotlin-7F52FF?style=for-the-badge&logo=kotlin&logoColor=white" alt="Kotlin" />
  <img src="https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Node.js%2022%2B-5FA04E?style=for-the-badge&logo=nodedotjs&logoColor=white" alt="Node.js" />
  <img src="https://img.shields.io/badge/WebAssembly-654FF0?style=for-the-badge&logo=webassembly&logoColor=white" alt="Wasm" />
  <img src="https://img.shields.io/badge/Bun-000000?style=for-the-badge&logo=bun&logoColor=white" alt="Bun" />
  <img src="https://img.shields.io/badge/Python-3776AB?style=for-the-badge&logo=python&logoColor=white" alt="Python" />
</p>

### Frontend & Mobile Applications
<p align="left">
  <img src="https://img.shields.io/badge/Android%20Compose-4285F4?style=for-the-badge&logo=jetpackcompose&logoColor=white" alt="Jetpack Compose" />
  <img src="https://img.shields.io/badge/Next.js%2015-000000?style=for-the-badge&logo=nextdotjs&logoColor=white" alt="Next.js" />
  <img src="https://img.shields.io/badge/React%2019-61DAFB?style=for-the-badge&logo=react&logoColor=black" alt="React" />
  <img src="https://img.shields.io/badge/Vite-646CFF?style=for-the-badge&logo=vite&logoColor=white" alt="Vite" />
  <img src="https://img.shields.io/badge/Xterm.js%20WebGL-F80000?style=for-the-badge&logo=iterm2&logoColor=white" alt="Xterm.js" />
</p>

### Terminal & PTY Subsystem
<p align="left">
  <img src="https://img.shields.io/badge/JNI%20forkpty-00599C?style=for-the-badge&logo=android&logoColor=white" alt="JNI forkpty" />
  <img src="https://img.shields.io/badge/tmux%20Multiplexing-1BB91F?style=for-the-badge&logo=tmux&logoColor=white" alt="tmux" />
  <img src="https://img.shields.io/badge/russh%20SSH%20Ed25519-0070F3?style=for-the-badge&logo=openssh&logoColor=white" alt="russh SSH" />
  <img src="https://img.shields.io/badge/portable--pty-0A3069?style=for-the-badge&logo=rust&logoColor=white" alt="portable-pty" />
  <img src="https://img.shields.io/badge/TrueColor%20%2B%20AltScreen-D00000?style=for-the-badge&logo=gnubash&logoColor=white" alt="VT/xterm emulation" />
</p>

### Real-Time Synchronization & Data Plane
<p align="left">
  <img src="https://img.shields.io/badge/WebSocket%20RFC%206455-0070F3?style=for-the-badge&logo=socketdotio&logoColor=white" alt="WebSocket" />
  <img src="https://img.shields.io/badge/SQLite%20WAL%20Outbox-003B57?style=for-the-badge&logo=sqlite&logoColor=white" alt="SQLite" />
  <img src="https://img.shields.io/badge/Transactional%20Outbox-2EA44F?style=for-the-badge&logo=serverfault&logoColor=white" alt="Transactional Outbox" />
  <img src="https://img.shields.io/badge/Cursor%20Sync-8B5CF6?style=for-the-badge&logo=clockify&logoColor=white" alt="Cursor Sync" />
  <img src="https://img.shields.io/badge/Kotlin%20Coroutines%20%26%20StateFlow-7F52FF?style=for-the-badge&logo=kotlin&logoColor=white" alt="Coroutines" />
  <img src="https://img.shields.io/badge/WorkManager-3DDC84?style=for-the-badge&logo=android&logoColor=white" alt="WorkManager" />
</p>

### Authentication & Identity
<p align="left">
  <img src="https://img.shields.io/badge/WebAuthn%20L3-Passkeys-00B4AB?style=for-the-badge" alt="WebAuthn passkeys" />
  <img src="https://img.shields.io/badge/Android%20Credential%20Manager-3DDC84?style=for-the-badge&logo=android&logoColor=white" alt="Credential Manager" />
  <img src="https://img.shields.io/badge/OAuth%202.1%20%2B%20PKCE-000000?style=for-the-badge" alt="OAuth 2.1 and PKCE" />
  <img src="https://img.shields.io/badge/RFC%208628-Device%20Grant-6E40C9?style=for-the-badge" alt="RFC 8628" />
  <img src="https://img.shields.io/badge/Session%20%2B%20CSRF-SQLite-003B57?style=for-the-badge&logo=sqlite&logoColor=white" alt="Sessions" />
  <img src="https://img.shields.io/badge/mobilecloud%20CLI-Rust-000000?style=for-the-badge&logo=rust&logoColor=white" alt="MobileCloud CLI" />
</p>

### Blockchain, Smart Contracts & Financial Cryptography
<p align="left">
  <img src="https://img.shields.io/badge/Stellar%20Soroban-08B5E5?style=for-the-badge&logo=stellar&logoColor=white" alt="Stellar Soroban" />
  <img src="https://img.shields.io/badge/Solana-14F195?style=for-the-badge&logo=solana&logoColor=black" alt="Solana" />
  <img src="https://img.shields.io/badge/Ed25519-232F3E?style=for-the-badge&logo=gnubash&logoColor=white" alt="Ed25519" />
  <img src="https://img.shields.io/badge/RFC%208785%20Canonical%20JSON-5C2D91?style=for-the-badge&logo=json&logoColor=white" alt="RFC 8785" />
  <img src="https://img.shields.io/badge/ISO%2020022%20XMLDSig-FF6F00?style=for-the-badge&logo=xml&logoColor=white" alt="ISO 20022" />
  <img src="https://img.shields.io/badge/Acurast%20TEE-6366F1?style=for-the-badge&logo=shield&logoColor=white" alt="Acurast TEE" />
</p>

### Infrastructure, Networking & Security
<p align="left">
  <img src="https://img.shields.io/badge/ARM64-0091BD?style=for-the-badge&logo=arm&logoColor=white" alt="ARM64" />
  <img src="https://img.shields.io/badge/BiometricPrompt%20Keymaster-4285F4?style=for-the-badge&logo=google&logoColor=white" alt="Biometrics" />
  <img src="https://img.shields.io/badge/Brotli%20%26%20Zstd-00599C?style=for-the-badge&logo=databricks&logoColor=white" alt="Compression" />
  <img src="https://img.shields.io/badge/libvips-A066CB?style=for-the-badge&logo=vips&logoColor=white" alt="libvips" />
  <img src="https://img.shields.io/badge/Zero--Trust%20Ingress-34495E?style=for-the-badge&logo=cloudflare&logoColor=white" alt="Zero-trust ingress" />
</p>

---

## The Unified Dual-Engine Paradigm

MobileCloud combines two decoupled, high-performance engines within one monorepo:

| ENGINE 1: MOBILECLOUD<br/>*(Autonomous On-Device Edge Cloud)* | ENGINE 2: FURLPAY PROOF-OF-RESERVE<br/>*(Verifiable Institutional RWA Telemetry)* |
| :--- | :--- |
| • Open Build Output API v3 compliant router | • RFC 8785 canonical evidence envelopes |
| • On-device Bun & Turbopack builder | • Checked 256-bit reconciliation kernel |
| • Atomic zero-downtime deployment promotion | • Alpaca JWS / ISO 20022 / Dinari TA feeds |
| • Tri-modal terminal (App, Browser, SSH) | • Acurast 3-of-5 hardware TEE quorum mesh |
| • Anycast ingress via a trusted gateway | • Stellar Soroban M-of-N Ed25519 contract |
| • Solana arbitrage engine with 4 risk invariants | • 5-tier reserve state governance machine |

---

## Detailed Platform Features

### 1. Engine 1: MobileCloud Autonomous Edge Computing
* **Open Build Output API v3 Compliance**: a native ARM64 routing daemon (`core-engine`) that parses standardized `.output` static routing rules, edge middleware redirects, rewrites, custom headers, and fallback handlers directly on Android.
* **On-Device Bun & Turbopack Builder**: compiles modern JavaScript/TypeScript frameworks (Next.js, Vite, Astro, Remix) on device, through the engine's builder module.
* **Atomic Zero-Downtime Deployment Promotion**: a symlink-based deployment switcher promoting builds with instant rollback to the previous immutable hash target.
* **Native Compression**: Brotli and Zstd streaming compression on the deployment path.
* **Image Optimization Pipeline**: an on-device `libvips` transcoding module for WebP/AVIF generation.

### 2. Tri-Modal Terminal & CloudShell Gateway
* **In-App Native PTY**: a full interactive terminal inside the Android app — Kotlin/Jetpack Compose over a JNI `forkpty` bridge, with a persistent `tmux` session so leaving the screen detaches instead of killing the shell.
* **Browser CloudShell (`web-cloudshell`)**: a browser terminal with WebGL-accelerated Xterm.js, a resilient WebSocket with exponential backoff and jitter, and reconnect that survives a reload.
* **Embedded Headless SSH Daemon**: `russh` on port `:2222`, Ed25519 public-key only, with a configurable bind that refuses a non-loopback address until a key is authorized.
* **Web Preview**: a dev server running on the phone is exposed to the browser at `/preview/<port>/` — loopback-only upstream, one port per session, token dropped from the URL after the first navigation.
* **File Transfer**: browse, upload, download, and delete inside the engine workspace; paths that escape it are refused rather than clamped.

### 3. Terminal Emulation & Touch Ergonomics
* **Full VT/xterm emulation**: alternate screen buffer (`smcup`/`rmcup`), 10 000-line scrollback, 24-bit TrueColor, 256-colour palette, SGR attributes, OSC title and clipboard, bracketed paste, and mouse reporting for `tmux` panes.
* **Event-driven rendering**: the canvas invalidates when bytes arrive, not on a 30 FPS ticker. An idle terminal costs no CPU.
* **Two-row Termux-style key bar**: sticky Ctrl/Alt/Shift, navigation keys, and shell punctuation, with an IME capture field so soft keyboards and hardware keys produce the same byte sequences.
* **Touch-to-mouse translation**: taps and drags become SGR mouse sequences, so `tmux` split panes are navigable by touch.
* **Doze-resistant sessions**: a `specialUse` foreground service with a bounded partial wake lock keeps a long build alive while the app is backgrounded.

#### Terminal capability matrix

| Capability | Native App (JNI PTY) | Browser CloudShell | Headless SSH |
| :--- | :--- | :--- | :--- |
| Transport | `forkpty` over a non-blocking master fd | Axum WebSocket `/terminal/ws`, binary frames | `russh` on `:2222` |
| Authentication | Biometric app-lock gate + Android keystore | One-use 256-bit ticket (`POST /terminal/ticket`) + `Origin` allowlist | Ed25519 public key only |
| Persistent session | Attaches to the shared `tmux` session; leaving the screen detaches | Attaches to the shared `tmux` session | Attaches to the shared `tmux` session |
| Rendering | Event-driven Compose canvas (invalidates on bytes; no idle ticker) | Xterm.js v5 with WebGL + `FitAddon` | Rendered by the SSH client |
| Alternate screen (`smcup`/`rmcup`) | Yes (`?1049`) | Yes (Xterm.js) | Client-dependent |
| Scrollback | 10,000-line ring buffer | Xterm.js scrollback | Client-dependent |
| Color | 24-bit TrueColor + 256-colour palette | 24-bit TrueColor | Client-dependent |
| Clipboard / title | OSC 52 + OSC title | OSC 52 | Client-dependent |
| Resize | `ioctl(TIOCSWINSZ)` | `FitAddon` → resize control frame | PTY resize |
| Touch / mouse | Touch-to-mouse SGR translation for `tmux` panes | Native browser mouse | Client-dependent |
| Key ergonomics | Two-row sticky-modifier `VirtualKeyBar`; swipe-up popup keys (`/` → `\`, `\|` → `&`) | Hardware keyboard | Client keyboard |
| Reconnect | Foreground service + bounded partial wake lock keep it alive | Exponential backoff + jitter; survives a reload | SSH client retry |
| File transfer | In-shell tools | Files panel: browse, upload, download, delete (path-confined) | `scp` / `sftp` |
| Web preview | — | Preview picker: scan ports, open `/preview/<port>/` | — |

### 4. GitHub-App-Derived Android Hardening
* **Biometric App Lock Gate**: `BiometricPrompt` on a `FragmentActivity` protects the console from unauthorized physical access.
* **Material 3 design system**: a shared dark palette and monospace type scale across the web console and the Android app.
* **Glance home-screen widgets**: Edge Node Status and Proof-of-Reserve Solvency, backed by a local state store.
* **WorkManager background daemons**: thermal telemetry and PoR attestation on an interval schedule.
* **Strict network isolation**: `network_security_config.xml` forbids cleartext traffic; exemptions are loopback only.

### 5. Next.js 15 Web Management Console (`apps/web-dashboard`)
* **Console views**: Projects, Deployments, Builds, Logs, Analytics, Monitoring, Observability, Speed, Firewall, Device, Settings, Domains, Storage, Databases, Functions, Workflows, Node, Team, Billing, Proof of reserve — and a CloudShell route.
* **Realtime gateway**: a dependency-free RFC 6455 WebSocket server that tails the same SQLite WAL the API writes.
* **QR device linking**: a two-minute single-use pairing code that the phone scans and the browser owner approves.
* **Optimistic UI with rollback**: mutations apply locally and roll back to the last confirmed snapshot if the server rejects them.

### 6. Agentic Direct Deployment & Distributed Cache Revalidation Engine
* **Direct Agent API Ingress (`POST /api/v1/deploy/agent`)**: an endpoint for AI coding agents to trigger builds, with token authentication and a custom agent id recorded on the deployment.
* **Instant Atomic Rollback API (`POST /api/v1/deploy/rollback`)**: promotes the pointer back to any prior immutable deployment with no recompilation.
* **Distributed Tag & Path Cache Revalidation (`POST /api/v1/cache/revalidate`)**: `revalidateTag()` and `revalidatePath()` across the edge cache.
* **Deployment Audit & History API (`GET /api/v1/deployments/:project`)**: the full deployment history, including the exact trigger source (`agent:…`, `git:push`).

### 7. Engine 2: FurlPay Proof-of-Reserve Protocol
* **Checked 256-Bit Mathematical Kernel (`por-kernel`)**: every accounting operation runs over checked fixed-point `U256` arithmetic with 18 decimal places of precision, so overflow is a type error rather than a silent wrap.
* **RFC 8785 Canonical JSON & Domain Separation**: evidence envelopes are normalized per RFC 8785 with domain-separated SHA-256 preimages.
* **Multi-Format Institutional Ingestion Parsers**: Alpaca JWS, ISO 20022 `camt.053` XMLDSig, and Dinari transfer-agent reconciliation.
* **Strict T+1 Settlement & Zero-Rehypothecation**: transit balances are validated against the settlement window; assets with `shares_on_loan > 0` are rejected.

### 8. Hardened Stellar Soroban Smart Contract (`por-verifier`)
* **Stellar Protocol 30 Compatibility**: the contract runs on the Soroban WASM runtime.
* **Ascending-Key O(N) Quorum Validation**: M-of-N verification requires signers in strictly ascending lexicographic order of their Ed25519 public keys, making duplicate-signer and Sybil attacks structurally impossible.
* **Independent On-Chain Solvency Calculation**: the contract recomputes the reserve ratio on-chain before updating state, so an off-chain oracle cannot manipulate it.
* **5-Tier Governance State Machine**: `OPTIMAL` → `ACCEPTABLE` → `WARNING` → `EMERGENCY` → `INSOLVENT`, each with its own trading, minting, and freeze consequences.

### 9. Edge Trading Engine (`trading-engine`)
* **Paper/demo execution**: cross-DEX routing modelled on Solana venues. Not validated for live execution and not connected to a funded account.
* **4 Non-Negotiable Invariants**:
  1. *Atomic-Only Reverts*: any non-profitable or interrupted route reverts in full without balance loss.
  2. *2.5% Maximum Capital Cap*: a strict exposure threshold per trade.
  3. *20% T+1 Buffer*: a minimum liquid capital buffer reserved at all times.
  4. *15 bps Max Slippage*: a strict execution boundary.
* **Soroban Circuit Breaker Client**: halts trading whenever the Stellar PoR contract leaves the optimal state.

### 10. Unified Real-Time Web ⇄ Android Synchronization
* **One Account, One Backend, One Source of Truth**: the Next.js console and the Android app are two authenticated clients of the same API, database, and event log — never two divergent copies.
* **Authenticated WebSocket Gateway (`wss://<host>/api/realtime`)**: a dependency-free RFC 6455 implementation on port `3211` reading the same SQLite WAL file. Authentication happens in the HTTP upgrade (session cookie or bearer token hashed with SHA-256); an anonymous upgrade is rejected and reported as *sign-in required*, never as a network failure.
* **Transactional Outbox**: every mutation writes its event row inside the same `BEGIN IMMEDIATE` transaction as the data change, so a dropped socket frame can never lose a change.
* **Cursor Synchronization (`GET /api/sync/changes?cursor=<seq>`)**: authorized, per-account, ascending replay of everything a client missed.
* **Shared Event Envelope**: `event_id · event_type · schema_version · account_id · resource_id · sequence · occurred_at · payload`.
* **One Socket Per Client**: both clients run a single shared realtime service, with reconnect backoff and jitter, heartbeats with dead-peer detection, `event_id` dedupe, sequence-gap recovery, and a bounded polling fallback.
* **QR Device Linking, Not Password Typing**: the console's **Link device** page shows a two-minute, single-use code; the phone scans it, the browser owner approves it, and the claim issues both a durable device credential and the session cookie.
* **No ADB Reverse Dependency**: the app discovers its control plane by validating `/api/health` across the last-known endpoint, loopback, the emulator alias, and the device's own `/24`, under fixed per-candidate timeouts.
* **Connection Diagnostics**: an explicit state machine drives a panel showing the active endpoint, connection method, last health check, last sync, cursor, pending changes, and last error.

> Full protocol, schema, and guarantees: [`docs/REALTIME-SYNC.md`](docs/REALTIME-SYNC.md).

### 11. Edge Tunnel & Shield Fabric (`edge/`)
* **Secure Reverse Tunnel (`mobilecloud-tunnel`)**: two binaries — `mc-tunnel-client` (runs beside the phone/edge service) and `mc-tunnel-relay` (runs on a public host) — connect over an authenticated WebSocket (`wss://`) and carry inbound traffic to loopback services. The relay never needs `adb reverse` or inbound NAT to the device.
* **Ed25519 Handshake**: the client signs `client_id:timestamp` with its Ed25519 key; the relay verifies the signature against an authorized-key allowlist and rejects a timestamp outside a ±300 s freshness window.
* **yamux Stream Multiplexing**: many concurrent TCP-like streams share a single WebSocket connection via yamux 0.10; the relay routes a public HTTP request to the matching service by `Host` subdomain and opens a dedicated yamux substream for it.
* **Resilient Client Loop**: exponential backoff with jitter on reconnect plus application-level `Heartbeat` / `HeartbeatAck` liveness on top of the tunnel.
* **Edge Shield (`mobilecloud-shield`)**: a composable Tower `Layer` / `Service` chain for edge services — CrowdSec-compatible IP blocklist, sliding-window rate limiter, and a regex WAF (path traversal, SQL injection, XSS, command injection) that percent-decodes the URI before matching so encoded payloads cannot slip through.

### 12. Platform Services: Functions, Workflows, Webhooks, Metering & Proof-of-Reserve
* **Bounded Functions Runtime**: store a JavaScript handler and invoke it. The handler runs in a `node:vm` context with no `require`, `process`, `fetch`, filesystem, or timers — synchronously, under source and output byte caps and a 250 ms wall-clock timeout. It isolates globals, not the process; it is not a sandbox for hostile code.
* **Workflow Worker**: a workflow stores an ordered step list that references your own functions; a run executes each step, threads its output into the next, and stops at the first failure.
* **Signed Webhook Delivery**: a delivery is enqueued inside the same transaction as the event it describes, so the queue row and the event commit together; `UNIQUE(webhook_id, event_id)` makes a redelivered event impossible to send twice. Each request is signed HMAC-SHA256, retried with capped exponential backoff up to 5 attempts, and recorded in a delivery log. Loopback and private-network targets are refused unless explicitly opted in for local testing. A separate worker process drains the queue so the request path never blocks on a third party.
* **Usage Metering**: append-only `usage_events` rows per meter (`function_invocations`, `workflow_runs`, `webhook_deliveries`, `object_bytes`), surfaced through `GET /api/v1/usage`. There is no payment provider, invoicing, or charging.
* **Proof-of-Reserve Console View**: a `/reserve` route renders the Rust kernel's reconciliation output **read-only** — the control plane never computes a ratio itself — and reports an explicit `unverified` state when no attestation exists.

### 13. Unified Authentication & the `mobilecloud` CLI

| Surface | Primary credential | Session | Refresh |
| :--- | :--- | :--- | :--- |
| Android | WebAuthn passkey in Credential Manager, gated by biometrics | 30 days, device-bound | 30-day rotating |
| Web console | Passkey, or a phone-approved QR login that sets `mc_session` | 24 hours, CSRF-bound | — |
| `mobilecloud` CLI | Device grant (RFC 8628) or Authorization Code + PKCE | 1-hour bearer | 30-day rotating |
| CloudShell | 256-bit terminal ticket minted from the console session | 30 seconds, single use | — |

A passkey is the primary factor on every surface; the password remains only as the recovery path and the one-time bootstrap that proves an account before its first passkey is added.

* **Passkeys (WebAuthn)**: registration and login on Android through Credential Manager and in the browser through `navigator.credentials`. Discoverable ES256 credentials, required user verification, a relying party bound to the console's own origin, signature-counter replay defence, per-credential device labels, and COSE-key storage. Attestation is `none`: the AAGUID is recorded but not cryptographically verified.
* **Login with MobileCloud**: the browser shows a 256-bit challenge as a QR code; the phone scans it, displays the verification code and the requesting browser, and approves with a biometric. Only the browser holding the poll secret can collect the session, and claiming it is atomic.
* **Device Authorization Grant (RFC 8628) and Authorization Code + PKCE (OAuth 2.1)**: `mobilecloud login` either approves a short code in the console or completes a browser flow with a loopback callback. Refresh tokens rotate on every use; replaying a consumed token revokes the entire family.
* **Client-scoped sessions**: `android`, `web`, `cli`, and `api` sessions get their own lifetimes, device bindings, and credentials. Tokens are stored as SHA-256 hashes and returned exactly once.
* **Audit trail and login risk**: every credential event is appended to `auth_events`, and a weighted engine scores new addresses and countries, impossible travel, brute force, unusual hours, and password use — then allows, notifies, requires a second factor, or blocks.
* **CLI**: `mobilecloud login|logout|whoami|devices|sessions|revoke-device|revoke-session`, with automatic token refresh and credentials written atomically to a `0600` file. See [docs/AUTH.md](docs/AUTH.md).
* **Custom SSO provider**: the same identity is exposed as a standards-based IdP — OIDC discovery with PKCE and signed ID tokens, a SAML 2.0 SP-initiated IdP, SCIM 2.0 user and group provisioning, RFC 7009 revocation, and back-channel single logout, with owner-only client administration. See [docs/SSO.md](docs/SSO.md).
* **FurlPay federation**: FurlPay is the first external OIDC relying party. The deployable adapter in `integrations/furlpay/` verifies discovery, JWKS, issuer/audience/nonce/signature, requires explicit account linking (never email merging), and creates FurlPay's own session. Every financial action still requires a FurlPay device-bound passkey step-up; a MobileCloud SSO session cannot authorize a payment, transfer, withdrawal, wallet signature or agent spend. See [docs/FURLPAY-INTEGRATION.md](docs/FURLPAY-INTEGRATION.md).

---

### 14. FurlPay Edge Deployment & Installable PWA
* **Cloudflare Tunnel edge**: `deploy/furlpay/` ships a production Docker image and compose service with no published ports; `cloudflared` dials out, TLS/DDoS/WAF terminate at Cloudflare, and `auth.furlpay.com` is routed to the identity container. `scripts/cloudflare-dns.mjs` creates the tunnel CNAME idempotently, and `scripts/furlpay-preflight.mjs` verifies readiness, discovery, JWKS and HSTS after a deploy.
* **Hardened container**: Node 24 multi-stage build, non-root UID 10001, `cap_drop: ALL`, `no-new-privileges`, read-only application tree except the SQLite data volume, and readiness health checks.
* **Installable PWA**: manifest, generated maskable icons, safe-area/theme metadata, an offline page, and a service worker that caches only the shell — API, OAuth, SAML, SCIM, login, approve and authorize routes are network-only. No credentials are ever cached.
* **Honest boundary**: this deploys the identity and console edge. FurlPay's payments, wallets, KYC, card vault, billing and app frontends are separate systems and are not implemented here.

See [docs/FURLPAY-DEPLOYMENT.md](docs/FURLPAY-DEPLOYMENT.md).

## System Architecture

```mermaid
flowchart TD
    subgraph EdgeDevice["Android Smartphone (com.mobilecloud.node)"]
        direction TB
        KRN["Linux Kernel / Android OS<br/>PTY forkpty · Wi-Fi / 5G · USB-PD"]
        APP["Android App (Kotlin + Compose)<br/>Console · CloudShell · Widgets · Biometrics"]
        JNI["libmobilecloud_native.so<br/>forkpty bridge · non-blocking master fd"]
    end

    subgraph CoreDaemon["MobileCloud Core Engine (Rust)"]
        ROUTER["Build Output v3 Router<br/>Static routes · redirects · rewrites"]
        BUILDER["Bun / Turbopack Builder<br/>On-device framework compilation"]
        PROMOTE["Atomic Promoter<br/>Zero-downtime switch + rollback"]
        COMPRESS["Brotli & Zstd Compression"]
        PTY["PTY Supervisor<br/>tmux new-session -A"]
        WS["WebSocket Gateway :3000<br/>One-use ticket · origin allowlist"]
        SSH["SSH Daemon :2222 (russh)<br/>Ed25519 only"]
        PREVIEW["Web Preview Proxy<br/>/preview/:port to loopback"]
        FILES["File Transfer API<br/>List · upload · download · delete"]
        PTY --> WS
        PTY --> SSH
    end

    subgraph WebPlane["Clients & Identity Plane"]
        CONSOLE["apps/web-dashboard<br/>Next.js 15 · 20 console views"]
        AUTH["Identity plane<br/>passkeys · Login with MobileCloud<br/>device & PKCE grants · scoped sessions · audit"]
        CLI["mobilecloud CLI (Rust)<br/>device grant · PKCE · rotating refresh"]
        CLOUDSHELL["web-cloudshell<br/>WebGL Xterm.js · file manager · preview picker"]
    end

    subgraph PoRProtocol["FurlPay Proof-of-Reserve Protocol"]
        subgraph Evidence["Evidence Ingestion"]
            ALP["Alpaca Custodian (JWS)"]
            ISO["Swift ISO 20022 XMLDSig"]
            DIN["Dinari Transfer Agent"]
        end
        subgraph DetKernel["Deterministic Reconciliation (Rust)"]
            PK["por-kernel<br/>U256 fixed-point · T+1 window"]
            AT["por-attestor<br/>RFC 8785 · pre-sorted Ed25519"]
            SB["por-submitter<br/>Quorum invocation"]
        end
        subgraph SmartContract["Stellar Soroban Contract (Protocol 30)"]
            SC["por-verifier<br/>O(N) ascending keys · monotonic replay protection"]
            STATE["Ledger State<br/>5-tier solvency machine · POR_AUDIT events"]
        end
        PY["audit/verify_baseline.py<br/>Pure-Python RFC 8032 · zero shared code"]
    end

    APP --> JNI --> PTY
    APP -.->|"passkey · QR approval"| AUTH
    CONSOLE -->|"session + CSRF"| AUTH
    CLI <-->|"HTTPS + Bearer"| AUTH
    KRN --> CoreDaemon
    CONSOLE <-->|"REST / WebSocket"| CoreDaemon
    CLOUDSHELL <-->|"WebSocket :3000<br/>ticket-authenticated"| WS
    CLOUDSHELL <-->|"preview + file API"| PREVIEW
    CLOUDSHELL --> FILES
    Evidence --> PK
    PK --> AT --> SB --> SC --> STATE --> PY
    STATE -->|"circuit breaker events"| TRADING["trading-engine<br/>4 risk invariants"]
```

---

## Unified Real-Time Synchronization

The socket is a latency optimisation; the **outbox row is the guarantee**.

```mermaid
flowchart LR
    subgraph W["Web Console (Next.js 15 :3210)"]
        WUI["app/* pages<br/>lib/store.tsx"]
        WRT["lib/realtime.ts<br/>one shared socket"]
        WUI --> WRT
    end

    subgraph A["Android App (Kotlin/Compose)"]
        ART["RealtimeClient.kt<br/>one socket · RFC 6455 framing"]
        AST["ConsoleStore.kt<br/>connection state machine"]
        ADI["Diagnostics panel<br/>endpoint · method · cursor"]
        ART --> AST --> ADI
    end

    subgraph S["Control Plane"]
        API["Dashboard API :3210<br/>app/api/[...path]/route.ts"]
        OUT[("Transactional outbox<br/>events(seq, id, owner_id, type, payload, at)<br/>event_cursors(consumer, seq)")]
        GW["Realtime gateway :3211<br/>server/realtime.mjs"]
        SYN["GET /api/sync/changes?cursor=seq<br/>authorized, ascending, paged"]
        API -->|"same BEGIN IMMEDIATE tx<br/>as the data write"| OUT
        OUT -->|"tail by seq"| GW
        OUT --> SYN
    end

    WRT -->|"HTTPS REST mutation"| API
    ART -->|"HTTPS REST mutation"| API
    GW -->|"event frames (owner-scoped)"| WRT
    GW -->|"event frames (owner-scoped)"| ART
    SYN -.->|"missed-change recovery<br/>after offline / restart"| WRT
    SYN -.->|"missed-change recovery<br/>after offline / restart"| ART
```

| Property | Mechanism |
| :--- | :--- |
| No lost change | Event row commits in the same transaction as the data mutation |
| Ordered delivery | Global monotonic `sequence`; clients detect and repair gaps |
| Exactly-once effect | `event_id` dedupe on the client, cursor monotonicity on the server |
| Offline recovery | `GET /api/sync/changes?cursor=…`, paged, oldest-first |
| Tenant isolation | Every event is scoped by `owner_id` before delivery and before replay |
| Graceful degradation | Bounded polling fallback when WebSockets cannot connect |
| No socket per screen | One shared realtime client in each application |

---

## Monorepo Crate & Subsystem Architecture

```mermaid
graph TD
    subgraph CargoWorkspace["Cargo Rust Workspace"]
        direction TB
        CORE["core-engine (bin)<br/>• Build Output v3 Router<br/>• Bun & Turbopack Runner<br/>• Atomic Promoter<br/>• Tri-Modal Gateway (PTY/SSH/WS)<br/>• Web Preview + File Transfer"]
        KERNEL["por-kernel (lib)<br/>• Checked U256 Fixed-Point<br/>• RFC 8785 Canonical JSON<br/>• Alpaca JWS / ISO 20022 / Dinari TA<br/>• T+1 Transit Accounting"]
        CONTRACT["contracts/por-verifier (wasm)<br/>• Stellar Soroban Protocol 30<br/>• M-of-N Ed25519 Quorum<br/>• O(N) Ascending-Signer Check<br/>• 5-Tier Solvency State Machine"]
        TRADING["trading-engine (bin/lib)<br/>• Solana Cross-DEX Arbitrage<br/>• 4 Non-Negotiable Risk Invariants<br/>• Soroban Circuit Breaker Client"]
        TUNNEL["edge/mobilecloud-tunnel (bins)<br/>• mc-tunnel-client<br/>• mc-tunnel-relay<br/>• Ed25519 handshake · yamux mux · WSS"]
        SHIELD["edge/mobilecloud-shield (lib)<br/>• IP Blocklist (CrowdSec JSON)<br/>• Sliding-Window Rate Limiter<br/>• Regex WAF (traversal/SQLi/XSS/CMDi)"]
        FLEET["fleet-mesh (lib)<br/>• Node Registry + Revocation<br/>• Ed25519 Device Identity<br/>• Replay-Protected Heartbeats<br/>• Resource-Aware Placement"]
        CLICRATE["cli (bin: mobilecloud)<br/>• Device Grant + PKCE Login<br/>• Scoped Token Refresh<br/>• Device & Session Revocation"]

        subgraph Tools["Workspace Tools"]
            ATTESTOR["tools/por-attestor<br/>Pre-sorted 5-Key Ed25519 Signer"]
            SUBMITTER["tools/por-submitter<br/>Stellar Protocol 30 Quorum Submitter"]
            XDRTOOL["tools/por-xdr-toolkit<br/>RFC 4506 LedgerKey Encoder"]
        end
    end

    subgraph AppPlane["Mobile & Web Applications"]
        ANDROID["android-app (com.mobilecloud.node)<br/>• Kotlin 2.0 + Jetpack Compose<br/>• JNI forkpty terminal + VirtualKeyBar<br/>• TerminalSessionService (wake lock)<br/>• BiometricPrompt · Glance widgets"]
        DASHBOARD["apps/web-dashboard<br/>• Next.js 15 developer console<br/>• 20 platform views<br/>• Shared realtime client (one socket)"]
        CLOUDSHELL["web-cloudshell<br/>• WebGL Xterm.js browser PTY<br/>• File manager + web preview picker<br/>• Auto-reconnecting WebSockets"]
    end

    subgraph ConfigAudit["Audit, Specs & Governance"]
        SPECS["specs/<br/>AUD-01 · DOC-01 · QRP-01"]
        AUDIT["audit/<br/>Cryptographic Testnet Baseline<br/>26 state snapshots · verify_baseline.py"]
        DOCS["docs/<br/>20 platform engineering guides"]
    end

    KERNEL --> ATTESTOR
    ATTESTOR --> SUBMITTER
    SUBMITTER --> CONTRACT
    XDRTOOL -.-> CONTRACT
    CONTRACT -.->|Circuit Breaker Telemetry| TRADING
    ANDROID <-->|JNI forkpty| CORE
    CLICRATE <-->|"HTTPS · device grant / PKCE"| DASHBOARD
    CLOUDSHELL <-->|WebSocket :3000 + file/preview API| CORE
    DASHBOARD <-->|REST API / Metrics| CORE
    CORE --> TRADING
    FLEET <-->|Enrollment · signed heartbeats| ANDROID
    FLEET -.->|node inventory| DASHBOARD
```

---

## Performance & Benchmark Matrix

| Benchmark | Harness | Configuration | Pass criteria |
| :--- | :--- | :--- | :--- |
| Ingress load through the tunnel into the phone's reverse proxy | [`benchmarks/k6-load-test.js`](benchmarks/k6-load-test.js) (k6) | Ramp `200 → 1,200 → 2,500` RPS over 11 min, then ramp down | `p95 < 35 ms`, error rate `< 0.1%` |
| Live request latency | Dashboard **Observability** view | Percentiles computed from real inbound request samples | Reported as `p50` / `p95` / `p99` (shows *No samples* until traffic arrives) |

```bash
k6 run benchmarks/k6-load-test.js                       # default target
k6 run -e TARGET=https://your.edge.host benchmarks/k6-load-test.js
```

> The load harness ships with **declared thresholds, not recorded results** — run it against a live tunnel + edge deployment and record the numbers. The kernel's overflow-free guarantee is a proof over 10,000 generated edge cases (`por-kernel`), not a throughput measurement.

---

## Automated Test Matrix

| Subsystem | Test Suite | Invariant Enforced |
| :--- | :--- | :--- |
| **`por-kernel`** | 58 tests | `U256` checked arithmetic, zero overflows across 10,000 edge cases, strict T+1 DTCC clearing window, zero-rehypothecation (`shares_on_loan == 0`). |
| **`por-verifier`** | 25 tests | Monotonic sequence replay defense, TTL freshness expiration, O(N) ascending-key validation, duplicate signer rejection, 5-tier solvency state transitions. |
| **`core-engine`** | 39 tests | Build Output v3 routing with a per-deployment compiled route-table cache, precompressed `br`/`gzip` sidecar serving confined to the artifact root, streamed artifact hashing, agentic deployment ingress, cache tag revalidation (tag, path, and optimizer cache purge), atomic promotion and rollback, PTY session allocation, terminal ticket single-use, origin allowlisting, preview session port binding, file-transfer path confinement. |
| **`trading-engine`** | 17 tests | Arbitrage profitability checks, integer-exact fee calculations, 4 risk invariants (atomic reverts, 2.5% max exposure, 15 bps slippage, 20% T+1 buffer). |
| **`mobilecloud-tunnel`** | 7 tests | Ed25519 handshake sign → verify round-trip, `Host`-to-service-name routing (subdomain, nested subdomain, bare domain, unknown domain), and raw HTTP response parsing (with and without a body). |
| **`mobilecloud-shield`** | 11 tests | Post-percent-decode WAF matching (SQL injection, path traversal, XSS) with a clean-request allow, sliding-window rate-limit admission, CrowdSec-JSON blocklist load/add/check/expiry-prune, and client-IP extraction from `X-Forwarded-For` / `X-Real-IP` with loopback fallback. |
| **`fleet-mesh`** | 43 tests | Ed25519 device-identity sign → verify round-trip and fail-closed verification of malformed keys/signatures; constant-time token comparison; strictly-increasing heartbeat sequence numbers that reject replays, gaps and unknown/revoked nodes; enrollment-token and operator-bearer authorization (401 on any missing, malformed, or wrong credential); deterministic resource-aware node selection (cores → RAM → storage → id); telemetry that refuses an `Unsupported` measurement carrying data and rejects battery > 100% or used > total; liveness classification and stale/offline sweeps; enrollment idempotency per device public key. |
| **`por-xdr-toolkit`** | 4 tests | Protocol 30 XDR encoding/decoding, RFC 4506 `Option<ScVec>` presence-flag alignment. |
| **`apps/web-dashboard`** | 92 tests | Real-time synchronization: a mutation commits its outbox row in the same transaction; a live WebSocket client receives it; a reconnect replays missed changes exactly once and in order; cross-account isolation; anonymous socket upgrade and unauthenticated `GET /api/sync/changes` are rejected. Authentication: a device grant issues a scoped CLI token once after approval and is refused before it; refresh tokens rotate and a replayed token revokes the family; a `cli:full` bearer can revoke devices and sessions but cannot mutate the account; QR login reaches `APPROVED` only through the phone's signature over the browser's challenge and the challenge is single use; WebAuthn options are bound to the console's RP id and require user verification; the risk engine blocks impossible travel and scores a new country and address as `medium`. QR device pairing: scan → browser approval → claim mints a credential **and** signs the phone in; a tampered secret, a stranger's pairing, an unapproved early claim, an expired session and a replayed claim are each refused; a new QR code supersedes the previous one. Platform services: a function runs inside a `node:vm` context with no `require`/`process`/`fetch`/timers and is rejected when over the source or output byte cap or the 250 ms timeout; a workflow threads each step's output into the next and stops at the first failure; a webhook delivery is queued once per subscriber in the event's own transaction, signed HMAC-SHA256, backoff-capped at 5 attempts, and refused against loopback/private targets; usage counters append per meter; a PoR attestation is validated and stored read-only, and a missing attestation reports `unverified`. Runs the real `server/realtime.mjs` gateway as a child process, not a mock. |
| **SSO provider** (in `apps/web-dashboard`) | 40 tests | OIDC discovery and JWKS; a full PKCE code exchange whose RS256 ID token is verified against the published key; confidential-client authentication (Basic and secret-post); scope-filtered claims; refresh rotation and reuse detection; RFC 7009 revocation; exact redirect and post-logout redirect matching. SAML: metadata, deflated and plain AuthnRequests, signed-request verification against the SP certificate, signature-wrapping rejection, DOCTYPE refusal, and a signed assertion in an auto-submit POST form. SCIM: hashed token auth, user and group CRUD, supported filters, PATCH/PUT deprovisioning that removes sessions and tokens, and a fail-closed `invalidFilter` error. |
| **FurlPay integration** | 9 tests | First federated login creates no account silently; existing account linking requires explicit approval; matching email never merges; state/nonce enforced; issuer/audience/signature checked against real JWKS; code replay and expiry refused; IdP logout does not end FurlPay's session; SSO cannot authorize payment, withdrawal, wallet signing or agent spending; introspection, client management and signing-key overlap rotation. |
| **Identity configuration** | 5 tests | Production requires an HTTPS origin/issuer and a strong operator password; known defaults are rejected; an unimplemented KMS provider blocks startup; enabling FurlPay requires a client id, HTTPS callback and issuer. |
| **`android-app`** | `assembleDebug` + `lintDebug` | No JVM unit-test suite ships; the Compose console, JNI `forkpty` terminal, two-row `VirtualKeyBar`, and the foreground `TerminalSessionService` are verified by a passing debug build and lint, not by an automated suite. |
| **`mobilecloud-cli`** | 8 tests | PKCE S256 against the RFC 7636 test vector, query decoding, UTC timestamp and relative-time formatting, table truncation, server-URL validation (HTTPS only except loopback, no credentials/path/query), and a credentials-file round trip with the profile lifecycle. |
| **`web-cloudshell`** | `tsc --noEmit` + `vite build` | Type-checked and bundled; the WebGL Xterm.js client, files panel, and preview picker are verified by a passing build, not by an automated suite. |

**358 tests** in total (Rust default members `183` + `por-verifier` `25` + dashboard `146` + `por-xdr-toolkit` `4`).

```bash
# Rust workspace (default members)
cargo test

# The MobileCloud CLI
cargo test -p mobilecloud-cli

# The Soroban contract crate (host build) and the standalone audit tool
cargo test -p por-verifier
cd tools/por-xdr-toolkit && cargo test && cd ../..

# Dashboard synchronization + QR pairing suite (Node's built-in test runner)
cd apps/web-dashboard && npm test
```

---

## Quick Start

### 1. Prerequisites

* **Rust Toolchain**: `rustc 1.80+`; add the `wasm32-unknown-unknown` target for the contract crate.
* **Android SDK / NDK**: build-tools 35, NDK 27.1.12297006, CMake 3.22.1, JDK 17 or 21.
* **Node.js**: 22.13 or later (the console uses `node:sqlite` and `--experimental-strip-types`).

### 2. Verify the workspace

```bash
git clone https://github.com/Ashutosh0x/mobilecloud-platform.git
cd mobilecloud-platform

cargo test                      # 183 tests in the default members
cargo test -p por-verifier      # 25 contract tests
cd apps/web-dashboard && npm test && cd ../..   # 146 dashboard tests
```

### 3. Run the web console

Before the first sign-in, set `MOBILECLOUD_BOOTSTRAP_PASSWORD` to a unique password of at least 12 characters, and `MOBILECLOUD_BOOTSTRAP_EMAIL` if you want an address other than `owner@mobilecloud.local`. Remove the password from the environment once the account is provisioned — the console does not log it and there is no public signup.

```bash
cd apps/web-dashboard
npm ci
npm run dev     # console :3210, realtime gateway :3211
```

Open `http://localhost:3210`. The database defaults to `apps/web-dashboard/data/mobilecloud.db`; set `MOBILECLOUD_DB` to relocate it. The gateway is a separate process on purpose: a Next.js route handler cannot answer an HTTP `upgrade`, so the WebSocket listener runs beside the API and tails the same WAL file.

Sign in with the password once, then add a passkey on `/device` (or from the Android app). After that, the login page offers **Login with MobileCloud**: scan the QR code with the phone and approve it there.

### 4. Sign in from the CLI

```bash
cargo build -p mobilecloud-cli --release
./target/release/mobilecloud login --server https://console.example.com
```

The CLI prints a short code and a link to `/activate`; approve it in the console (or scan the link with the Android app) and the terminal receives its own scoped token. `mobilecloud whoami`, `devices`, `sessions`, `revoke-device`, and `revoke-session` are available afterwards; see [`docs/AUTH.md`](docs/AUTH.md).

### 5. Register an SSO application

The console is also an OIDC, SAML and SCIM identity provider. With an owner session and its CSRF token:

```bash
curl -X POST http://localhost:3210/api/admin/oidc-clients \
  -H 'content-type: application/json' -H "x-mc-csrf: $CSRF" -b "mc_session=$SESSION" \
  -d '{"name":"Demo App","redirect_uris":["http://127.0.0.1:4000/callback"],
       "scopes":["openid","profile","email"],"public":true}'
```

Point the application at `http://localhost:3210/.well-known/openid-configuration`. SAML service providers are registered at `/api/admin/saml-sps`, SCIM tokens at `/api/admin/scim-tokens`, and the full reference is [`docs/SSO.md`](docs/SSO.md).

### 6. Run the browser CloudShell

The dev server proxies the engine's routes and attaches the operator credential — the only place that credential appears:

```bash
export MOBILECLOUD_ENGINE=http://127.0.0.1:3000
export MOBILECLOUD_OPERATOR_TOKEN=…        # the engine's operator token
cd web-cloudshell && npm ci && npm run dev  # http://localhost:5173
```

In production the same role is played by the reverse proxy in front of the engine; the configuration is in [`docs/CLOUDSHELL.md`](docs/CLOUDSHELL.md).

### 7. Build and connect Android

Use an ARM64 device running Android 11 (API 30) or newer. Point `android-app/local.properties` at your SDK.

```bash
cd android-app
./gradlew :app:assembleDebug :app:lintDebug
./gradlew :app:installDebug
```

Enter and confirm the phone-reachable HTTPS origin, then sign in with the operator account. There is no cleartext or automatic LAN discovery fallback. To pair by QR instead, open the device page on the HTTPS dashboard, generate a code, and scan it in the app — compare the origin and verification code before approving in the browser.

From the repository root, [`scripts/build-and-sign-apk.sh`](scripts/build-and-sign-apk.sh) aligns, signs, and verifies the APK against a trusted certificate fingerprint. It requires an existing release keystore and protected signing inputs. **Do not distribute an APK until historical signing-credential exposure has been assessed and the signed build has been verified on physical hardware.**

### 8. What still needs a physical device

Backup and migration recovery, HTTPS/WSS routing, pairing, reconnect, and revocation on real hardware, and a signed release verified on an ARM64 device. Keep public builds disabled until workers and tenant authorization are isolated. Reserve and trading claims require independent validation.

---

## Cryptographic Audit & Integrity

The proof-of-reserve path is sealed end to end:

```bash
# repo-wide integrity manifest (56 entries)
sha256sum -c INTEGRITY_MANIFEST.sha256

# the frozen 2026-11-21 testnet baseline
cd audit/TESTNET_BASELINE_2026-11-21 && sha256sum -c MANIFEST.sha256

# independent pure-Python RFC 8032 verification of the 3-of-5 quorum
python -I audit/TESTNET_BASELINE_2026-11-21/crypto/verify_baseline.py
```

The manifest seals the 26 regression snapshots, the contract sources, the crate manifests, the release WASM, and the public documentation set. Commit anchors and toolchain versions are in [`versions.txt`](versions.txt).

---

## Documentation Index

| Document | Contents |
| :--- | :--- |
| [CLOUDSHELL.md](docs/CLOUDSHELL.md) | The tri-modal terminal: credential model, web preview, file transfer, session durability, reverse-proxy configuration |
| [AUTH.md](docs/AUTH.md) | Unified authentication: passkey ceremonies, Login with MobileCloud, CLI device and PKCE grants, session scopes, refresh rotation, audit and login risk |
| [SSO.md](docs/SSO.md) | Custom SSO provider: OIDC discovery and PKCE, signed ID tokens and JWKS, SAML 2.0 IdP, SCIM 2.0 provisioning, single logout, client administration |
| [IDENTITY-ARCHITECTURE.md](docs/IDENTITY-ARCHITECTURE.md) | Identity-provider boundary, components, client roles and current-vs-planned status |
| [OIDC-PROVIDER.md](docs/OIDC-PROVIDER.md) | Discovery, authorization/token/userinfo/introspection/revocation/logout, clients and consent |
| [FURLPAY-INTEGRATION.md](docs/FURLPAY-INTEGRATION.md) | FurlPay as the first relying party: registration, login sequence, logout, financial boundary and what FurlPay must implement |
| [FURLPAY-DEPLOYMENT.md](docs/FURLPAY-DEPLOYMENT.md) | Namecheap → Cloudflare DNS, tunnel, Docker deployment, PWA, verification, security baseline and cost estimates |
| [ACCOUNT-LINKING.md](docs/ACCOUNT-LINKING.md) | `(issuer, subject)` identity keys, explicit link confirmation, no email merging, unlinking and recovery |
| [SESSION-AND-LOGOUT.md](docs/SESSION-AND-LOGOUT.md) | The four logout scopes, session revocation, refresh rotation and back-channel logout |
| [KEY-MANAGEMENT.md](docs/KEY-MANAGEMENT.md) | RS256/SAML keys, rotation with JWKS overlap, production KMS requirement and emergency rotation |
| [IDENTITY-SECURITY.md](docs/IDENTITY-SECURITY.md) | Threat controls, browser/transport hardening, logging rules and residual risks |
| [IDENTITY-OPERATIONS.md](docs/IDENTITY-OPERATIONS.md) | Environment, DNS/TLS for `auth.furlpay.com`, health probes, backup/restore, monitoring, incident response and readiness |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | Dual-cadence assurance model, component dataflow, platform real-time plane |
| [REALTIME-SYNC.md](docs/REALTIME-SYNC.md) | Unified Web ⇄ Android real-time sync: event envelope, transactional outbox, WebSocket gateway protocol, cursor recovery, cross-device auth |
| [SECURITY-MODEL.md](docs/SECURITY-MODEL.md) | Quorum design, digest scheme, threat matrix |
| [VERIFIED-BASELINE.md](docs/VERIFIED-BASELINE.md) | Testnet evidence: transaction hashes, ledgers, live attack rejections |
| [SOLVENCY-MODEL.md](docs/SOLVENCY-MODEL.md) | Basis-point scale, thresholds, ratio math |
| [PROTOCOL-30-XDR.md](docs/PROTOCOL-30-XDR.md) | XDR wire-format invariants and the `Option<ScVec>` presence flag |
| [GOVERNANCE.md](docs/GOVERNANCE.md) | Gate 7 per-asset policies, validation rules, non-retroactivity |
| [STELLAR-SOROBAN.md](docs/STELLAR-SOROBAN.md) | Contract mechanics, TTL/archival behavior, events |
| [ACURAST-TEE.md](docs/ACURAST-TEE.md) | Attestor signing architecture and TEE roadmap |
| [INTEGRATION-GUIDE.md](docs/INTEGRATION-GUIDE.md) | How to read and independently verify the proof-of-reserve |
| [ROADMAP.md](docs/ROADMAP.md) | Phase 1–6 plan with honest status tags |
| [AUDIT-EVIDENCE.md](docs/AUDIT-EVIDENCE.md) | Integrity manifests, verification scripts, commit anchors |
| [FEATURE-REPORT.md](docs/FEATURE-REPORT.md) | Verified inventory of every claimed system and feature — implemented vs UI-only vs absent |
| [IMPLEMENTATION_AUDIT.md](docs/IMPLEMENTATION_AUDIT.md) | Phase 0 repository audit: component inventory, executed test baseline, and the honest list of absent subsystems |
| [IMPLEMENTATION_ROADMAP.md](docs/IMPLEMENTATION_ROADMAP.md) | The 12-phase engineering program with per-phase status, acceptance criteria, and the architecture decision record |
| [SECURITY_THREAT_MODEL.md](docs/SECURITY_THREAT_MODEL.md) | Platform assets, trust boundaries, threat table with control status, and the adversarial test plan |
| [PRODUCTION_READINESS.md](docs/PRODUCTION_READINESS.md) | What is deployable today, secrets posture, health/backup/DR gaps, and the pre-launch checklist |

---

<div align="center">

**MobileCloud & FurlPay** — one account, one data model, one durable event log.

[![CI Status](https://img.shields.io/badge/CI-Passing-2ea44f?style=for-the-badge&logo=githubactions&logoColor=white)](.github/workflows/ci.yml)
[![Tests](https://img.shields.io/badge/Tests-358%20Passed-brightgreen?style=for-the-badge&logo=checkmarx&logoColor=white)](#automated-test-matrix)

</div>
