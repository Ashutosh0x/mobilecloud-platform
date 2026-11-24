# MobileCloud & FurlPay

![MobileCloud concept illustration](assets/mobilecloud_concept.jpg)

MobileCloud is a web management console and an Android companion client. Both use the same account data. The Rust edge engine and FurlPay proof-of-reserve components are separate preview and research projects.

**Release status: local evaluation only.** The Android APK is a console client; it does not run the Rust engine. The dashboard records build and deployment requests but does not execute them. The trusted local build preview is not sandboxed; do not run untrusted repositories.

## Components

| Component | Location | What is available |
| --- | --- | --- |
| Web console | [apps/web-dashboard](apps/web-dashboard) | Next.js UI and API, SQLite, and a separate realtime gateway. |
| Browser CloudShell | [web-cloudshell](web-cloudshell) | Full terminal in the browser (xterm.js + WebGL) over the phone's PTY, with a file manager and one-click web preview. |
| Android console | [android-app](android-app) | Kotlin/Compose client with HTTPS sign-in, camera-based QR pairing, same-origin WSS, and a real on-device terminal. |
| Edge engine | [core-engine](core-engine) | Loopback-only operator and static deployment listeners, plus the tri-modal terminal gateway. Not a multi-tenant build service. |
| Proof-of-reserve research | [contracts/por-verifier](contracts/por-verifier) | Stellar Soroban verifier and test fixtures. These do not verify live reserves or custody. |
| Trading demo | [trading-engine](trading-engine) | Paper/demo trading code. Not validated for live execution. |

## The terminal

One shell, three surfaces — the Android app, a browser tab, and SSH — all
attached to the same `tmux` session, so a build started on the phone survives
a reload, a screen lock, and a move to a laptop.

| Surface | Transport | Credential |
| --- | --- | --- |
| Android app | JNI `forkpty` bridge to a persistent `tmux` server | none (local) |
| Browser | WebSocket at `/terminal/ws` | one-use ticket, 30 s, single redemption |
| SSH | `russh` on port 2222 | Ed25519 public key |

The browser terminal has the full feature set a shell needs: alternate screen
buffer, 10 000 lines of scrollback, 24-bit colour, mouse reporting for
`tmux` panes, bracketed paste, OSC 52 clipboard, and automatic reconnection.
The Android terminal has the same emulation, plus a two-row Termux-style key
bar with sticky modifiers, touch-to-mouse translation, and a foreground
service that keeps a long build alive through Doze.

Two features close the gap with Google Cloud Shell and AWS CloudShell:

* **Web preview** — a dev server running on the phone is exposed to the
  browser at `/preview/<port>/`. The upstream is always loopback, the engine's
  own ports are refused, and the session token is bound to one port and
  dropped from the URL after the first navigation.
* **File transfer** — browse, upload, download, and delete inside the
  engine's workspace. Every path is resolved inside that workspace; a path
  that escapes it is refused rather than clamped.

See [docs/CLOUDSHELL.md](docs/CLOUDSHELL.md) for the credential model, the
reverse-proxy configuration, and the API surface.

### Run the browser CloudShell

The dev server proxies the engine's routes and attaches the operator
credential, which is the only place that credential appears:

```bash
export MOBILECLOUD_ENGINE=http://127.0.0.1:3000
export MOBILECLOUD_OPERATOR_TOKEN=…          # the engine's operator token
cd web-cloudshell && npm ci && npm run dev    # http://localhost:5173
```

In production the same role is played by the reverse proxy in front of the
engine; the configuration is in [docs/CLOUDSHELL.md](docs/CLOUDSHELL.md).

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
| `web-cloudshell` | `npm ci && npx tsc --noEmit && npx vite build` |
| Repository root | `cargo test` |
| `android-app` | `bash ./gradlew :app:assembleDebug :app:lintDebug :app:assembleRelease` |

The local remediation checks passed 28 dashboard regression tests, 110 workspace
tests (35 edge-engine, 58 proof-of-reserve kernel, 17 trading engine), the
dashboard and CloudShell production builds, and Android debug and unsigned
release builds plus lint. These checks do not validate production ingress, a
signed release, on-device pairing, or a live engine behind a reverse proxy.

Before public rollout, verify backup and migration recovery, HTTPS/WSS routing,
and pairing, reconnect, and revocation on a physical Android device. Keep
public builds disabled until workers and tenant authorization are isolated.
Reserve and trading claims require independent validation.

## Further reading

- [CI workflow](.github/workflows/ci.yml)
- [CloudShell: tri-modal terminal, credential model, preview, file transfer](docs/CLOUDSHELL.md)
- [Realtime design](docs/REALTIME-SYNC.md)
- [Architecture and threat model](docs/ARCHITECTURE.md) · [Security model](docs/SECURITY-MODEL.md)
- [Soroban verifier design](docs/STELLAR-SOROBAN.md) · [Historical verification baseline](docs/VERIFIED-BASELINE.md)
