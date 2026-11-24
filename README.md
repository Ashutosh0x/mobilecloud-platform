# MobileCloud & FurlPay

![MobileCloud concept illustration](assets/mobilecloud_concept.jpg)

MobileCloud is a web management console and an Android companion client. Both use the same account data. The Rust edge engine and FurlPay proof-of-reserve components are separate preview and research projects.

**Release status: local evaluation only.** The Android APK is a console client; it does not run the Rust engine. The dashboard records build and deployment requests but does not execute them. Public signup, outbound webhook delivery, and browser CloudShell are disabled. The trusted local build preview is not sandboxed; do not run untrusted repositories.

## Components

| Component | Location | What is available |
| --- | --- | --- |
| Web console | [apps/web-dashboard](apps/web-dashboard) | Next.js UI and API, SQLite, and a separate realtime gateway. |
| Android console | [android-app](android-app) | Kotlin/Compose client with HTTPS sign-in, camera-based QR pairing, and same-origin WSS. |
| Edge engine | [core-engine](core-engine) | Loopback-only operator and static deployment listeners. Not a multi-tenant build service. |
| Proof-of-reserve research | [contracts/por-verifier](contracts/por-verifier) | Stellar Soroban verifier and test fixtures. These do not verify live reserves or custody. |
| Trading demo | [trading-engine](trading-engine) | Paper/demo trading code. Not validated for live execution. |

## Run the web console locally

Use Node.js 22.13 or later. Before first sign-in, set `MOBILECLOUD_BOOTSTRAP_PASSWORD` in your environment to a unique password of at least 12 characters. Set `MOBILECLOUD_BOOTSTRAP_EMAIL` if you want a different address from `owner@mobilecloud.local`. Remove the password from the environment after the account is provisioned. The console does not log it or offer public signup.

```bash
cd apps/web-dashboard
npm ci
npm run dev
```

Open `http://localhost:3210`. The launcher starts Next.js and a realtime gateway on loopback ports 3210 and 3211. Both use the same SQLite database, which defaults to `apps/web-dashboard/data/mobilecloud.db`. Set `MOBILECLOUD_DB` to use a different file. Back up any existing database before upgrading; the credential migration retires the legacy seeded account and invalidates legacy sessions.

For testing behind HTTPS, use `npm run build` and `npm start` with `MOBILECLOUD_PUBLIC_ORIGIN` set to the exact HTTPS origin. Keep both listeners private. Have a trusted reverse proxy route `/api/realtime` WebSocket upgrades to the gateway and all other console traffic to Next.js. Local HTTP development is browser-only; Android requires HTTPS even in debug builds.

## Build and connect Android

Use JDK 17, Android SDK and build-tools 35, NDK 27.1.12297006, and CMake 3.22.1. Use an ARM64 device running Android 11 (API 30) or newer. Configure the SDK in Android Studio or in `android-app/local.properties`.

```bash
cd android-app
bash ./gradlew :app:assembleDebug :app:lintDebug
```

To install the debug build on a connected test device, run `bash ./gradlew :app:installDebug`. Enter and confirm the phone-reachable HTTPS origin, then sign in with the operator account. There is no cleartext or automatic LAN discovery fallback.

To pair by QR, open the device page on the HTTPS dashboard, generate a code, and scan it in Android. Compare the origin and verification code before approving the request in the browser. The Android app switches accounts only after claiming the session and verifying it. The session is held in memory, and pairing does not attest to hardware identity. Revoking a device invalidates its linked session and bearer; the gateway rechecks active connections and disconnects revoked ones.

From the repository root, [the release script](scripts/build-and-sign-apk.sh) aligns, signs, and verifies the APK against a trusted certificate fingerprint. It requires an existing release keystore and protected signing inputs. Do not distribute an APK until historical signing credential exposure has been assessed and the signed build has been verified on physical hardware.

## Verify changes

Run each command from the indicated directory.

| Directory | Command |
| --- | --- |
| `apps/web-dashboard` | `npm ci && npm test && npm run build` |
| Repository root | `cargo test -p core-engine` |
| `android-app` | `bash ./gradlew :app:assembleDebug :app:lintDebug :app:assembleRelease` |

The local remediation checks passed 28 dashboard regression tests, 17 engine tests, the dashboard production build, browser smoke tests, and Android debug and unsigned release builds plus lint. These checks do not validate production ingress, a signed release, or on-device pairing.

Before public rollout, verify backup and migration recovery, HTTPS/WSS routing, and pairing, reconnect, and revocation on a physical Android device. Keep public builds disabled until workers and tenant authorization are isolated. Reserve and trading claims require independent validation.

## Further reading

- [CI workflow](.github/workflows/ci.yml)
- [Realtime design](docs/REALTIME-SYNC.md)
- [Architecture and threat model](docs/ARCHITECTURE.md) · [Security model](docs/SECURITY-MODEL.md)
- [Soroban verifier design](docs/STELLAR-SOROBAN.md) · [Historical verification baseline](docs/VERIFIED-BASELINE.md)
