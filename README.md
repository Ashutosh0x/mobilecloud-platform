# MobileCloud & FurlPay Platform (2026)

**The Unified Dual-Engine Paradigm** — autonomous smartphone edge clouds, an
inbuilt CloudShell, and institutional Proof-of-Reserve on Stellar & Acurast,
implemented end-to-end from the 2026 blueprint corpus.

```
+----------------------------------------------------------------------------------------------------+
|  [ ENGINE 1: MOBILECLOUD ]                             [ ENGINE 2: FURLPAY PROOF-OF-RESERVE ]      |
|  Autonomous On-Device Edge Cloud                       Verifiable Institutional RWA Telemetry      |
|  --------------------------------------------------    ------------------------------------------  |
|  • Vercel Build Output API v3 compliant router         • RFC 8785 canonical evidence envelopes     |
|  • 16.5s Next.js builds on 3nm ARM64 silicon           • Checked 256-bit reconciliation kernel   |
|  • 1.97W wall draw ($0.23/mo electricity)              • Alpaca JWS / ISO 20022 / Dinari TA feeds |
|  • Zero-millisecond battery hardware UPS               • Acurast 3-of-5 hardware TEE quorum mesh  |
|  • Tri-Modal Terminal (App, Browser, SSH)              • Stellar Soroban M-of-N Ed25519 contract  |
|  • Anycast ingress via Cloudflare tunnel               • 5-tier reserve state governance machine  |
|  • Solana atomic arbitrage + Jito MEV bundles          • Soroban circuit breaker + risk invariants|
+----------------------------------------------------------------------------------------------------+
```

## Repository Layout

| Crate / Module | Purpose |
| :--- | :--- |
| [`por-kernel/`](por-kernel) | FurlPay deterministic reconciliation engine: checked `U256` fixed-point math, RFC 8785 canonical JSON, Alpaca JWS / ISO 20022 XMLDSig / Dinari TA parsers, NSCC/DTC **T+1** clearing transit math, strict zero-rehypothecation validation, and the **10,000-case edge suite**. |
| [`contracts/por-verifier/`](contracts/por-verifier) | Hardened **Stellar Soroban** contract: M-of-N Ed25519 threshold attestation with O(N) strictly-ascending signer validation (duplicate signers structurally impossible), monotonic sequence replay defense, domain-separated SHA-256 digest, independent on-chain ratio calculation, issuer-governance freeze. |
| [`core-engine/`](core-engine) | Native ARM64 supervisor daemon (`mobilecloud-core`): Build Output v3 router + warm Bun/Node worker pool, Brotli/Zstd compression, libvips image pipeline, libgit2 shallow fetcher, framework detector, Bun/Turbopack builder with thermal governor, atomic symlink promotion (< 15 ms rollback), and the tri-modal terminal gateway (PTY + WebSocket + russh SSH on :2222). |
| [`trading-engine/`](trading-engine) | Edge trading daemon: Solana cross-DEX/CLOB atomic arbitrage with Jito MEV bundles (integer-exact fee model), the four non-negotiable risk invariants (atomic-only, 2.5% cap, 20% T+1 buffer, 15 bps slippage), Android thermal/bypass supervisor, and the Soroban circuit-breaker client. |
| [`android-app/`](android-app) | Production Android node (`com.mobilecloud.node`, Kotlin 2.0 + Compose, CIDS design system): onboarding wizard, Dashboard / Trading / PoR Oracle / CloudShell / Mesh / Safety screens, forkpty JNI bridge, foreground supervisor + dual-WAN services, boot receiver. **GitHub-app-derived hardening (decompilation report §17/§20): biometric App Lock gate (FragmentActivity + BiometricPrompt, 60 s background re-arm), WorkManager CoroutineWorkers (15-min thermal telemetry, hourly PoR attestation), two Glance home-screen widgets (Edge Status, PoR Solvency) over a SharedPreferences widget state store, loopback-only cleartext network security config, empty-state + progressive-loading CIDS components. Full 3-layer CIDS token architecture (§20.14.2–3): 21-step Primer gray scale + 7 chromatic scales, semantic success/danger/warning/info tokens decoupled from hue, dark+light diff-view token sets, Material3 Typography (7-step 13–24 sp scale) + Shapes, Material Motion curves (§20.8.1), and the 3-token badge spec (bg 16% α + label + stroke 32% α).** |
| [`web-cloudshell/`](web-cloudshell) | Browser CloudShell: Xterm.js WebGL renderer with resilient auto-reconnecting WebSocket (exponential backoff + jitter). |
| [`config/`](config) | Caddyfile (loopback proxy + rate limits), cloudflared tunnel spec, ADB phantom-process-killer bootstrap. |
| [`scripts/`](scripts) | `build-and-sign-apk.sh` (NDK 16 KB pages → zipalign -P 16 → apksigner v1–v4), `devnet-up.sh` (Stellar quickstart + Anvil forks + WireMock custodian). |
| [`benchmarks/`](benchmarks) | k6 ingress load test (2,500 VUs, p95 < 35 ms). |
| [`.github/workflows/ci.yml`](.github/workflows/ci.yml) | CI: 10k-case suites, chaos tests, WASM build, tagged APK sign pipeline. |

## Quick Start

### 1. Verify the kernels (host)

```bash
cargo test -p por-kernel        # 10,000 reconciliation + envelope + T+1 cases
cargo test -p por-verifier      # contract suite incl. chaos attacks
cargo build -p core-engine      # supervisor daemon
cargo test -p trading-engine    # arbitrage + risk invariant gates
```

### 2. Deploy the Soroban contract (testnet)

```bash
cargo build -p por-verifier --target wasm32-unknown-unknown --release
stellar contract optimize --wasm target/wasm32-unknown-unknown/release/por_verifier.wasm
stellar keys generate --network testnet furlpay-deployer
stellar keys fund furlpay-deployer --network testnet
stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/por_verifier.optimized.wasm \
  --source furlpay-deployer --network testnet
```

### 3. Run the core engine on-device

```bash
MOBILECLOUD_HOME=/var/mobilecloud \
MOBILECLOUD_WEBHOOK_SECRET=<strongbox-provisioned-secret> \
./target/release/mobilecloud-core
# listening on 127.0.0.1:3000 — behind cloudflared / Caddy (config/)
```

### 4. Build & sideload the Android node

```bash
scripts/build-and-sign-apk.sh
adb install -r -d -g dist/mobilecloud-release-signed.apk
adb shell dumpsys deviceidle whitelist +com.mobilecloud.node
adb shell am start-foreground-service \
  -n com.mobilecloud.node/.service.CloudSupervisorService
adb shell cat /sys/class/power_supply/battery/status   # expect: Not charging (bypass)
```

### 5. Local devnet + load test

```bash
scripts/devnet-up.sh           # Stellar :8000 · Arbitrum :8545 · Base :8546 · Custodian :8080
k6 run benchmarks/k6-load-test.js
```

## Key Invariants (encoded in tests)

| Invariant | Where enforced |
| :--- | :--- |
| Duplicate signers structurally rejected (ascending-key O(N)) | `por-verifier` chaos suite |
| Monotonic sequence + TTL replay defense | envelope + contract |
| Strictly zero rehypothecation (`shares_on_loan == 0`) | envelope, TA parser, entitlement proof |
| T+1 transit cash counts only inside the clearing window | `accounting::t1_settlement` |
| Independent on-chain ratio recomputation | `submit_attestation` |
| Freeze only via issuer governance keys | contract `freeze_asset` |
| Atomic-reverts-only trading; 2.5% cap; 20% T+1 buffer; 15 bps slippage | `trading_engine::risk_invariants` |
| Battery at 0.00 mA under USB-PD bypass | `BatteryBypassDetector` + supervisor loop |
| Biometric gate re-arms after 60 s backgrounded | `AppLockManager` + `MainActivity` ON_STOP/ON_START observer |
| Cleartext WAN forbidden; loopback-only exception | `res/xml/network_security_config.xml` |

## Source Blueprint Corpus

All 18 workspace research documents (master blueprint, PoR production spec,
power mathematics, terminal architecture, build benchmarks, trading strategy,
UI/UX design system, APK build manual, testing protocol, …) live one level
above this repository in `Mobile cloud/` and are cross-referenced from the
module headers throughout the code.

---
*Compiled from the Antigravity Engineering Architecture Group blueprint
corpus (November 2026).*
