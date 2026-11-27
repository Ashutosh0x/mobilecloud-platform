# Audit Remediation — 2026-11-27

Tracks the priority-tier audit against the code. **Fixed** means code or CI now
enforces it; **partial** means a real mitigation landed but a documented gap
remains; **open** is not done.

| ID | Status | What changed / what remains |
| :--- | :--- | :--- |
| P0-1 secrets | partial | `LICENSE`, `SECURITY.md`, secret-free `.gitignore` and the security checklist landed. **Rotation is an operator action and was not performed**: rotate the release keystore, operator token, bootstrap password and any HMAC/JWT secrets; run gitleaks/trufflehog over full history. |
| P0-2 vm isolation | fixed (fail-closed) | Production refuses Functions/Workflows unless `MOBILECLOUD_IN_PROCESS_RUNTIME=1`; routes answer 503. A separate worker is still the only true sandbox. |
| P0-3 builds/previews | partial | Deploy/build routes return 403 and never dispatch; builder remains disabled. Core-engine agent ingress still needs its own scoped-token review. |
| P1-1 WS Origin | fixed | `server/realtime.mjs` builds an Origin allowlist from `MOBILECLOUD_PUBLIC_ORIGIN` and rejects other origins before cookie auth. |
| P1-2 preview origin | partial | Preview responses now carry CSP `sandbox` (opaque origin, no ambient console cookie/API access) and `Referrer-Policy: no-referrer`; the one-time token→cookie exchange already existed. A separate preview subdomain is still preferred. |
| P1-3 QR/device phishing | open | Client name and code are shown; requester IP/location/UA are not yet sent to the approving phone. |
| P1-4 cli:full revocation | open | A `cli:full` token can still revoke devices/sessions; separate scope/step-up and OS keychain storage are not implemented. |
| P1-5 password fallback | open | Password login remains enabled. Lockout/throttle exist, but passkey-only mode and recovery codes do not. |
| P2-1 tunnel replay | open | Handshake still signs `client_id:timestamp`; relay nonce/binding is not implemented. |
| P2-2 forwarded headers | open | Shield trusts `X-Forwarded-For` without a trusted-proxy allowlist. |
| P2-3 WAF | open | Regex deny-list; documented as defence in depth, not a control. |
| P2-4 webhook SSRF | partial | Private/loopback refusal exists; DNS-rebinding-safe connect and redirect/size/time caps still need work. |
| P2-5 protocol code | open | Hand-rolled WebSocket/HTTP parsers remain; fuzzing is not wired. |
| P2-6 terminal/files | partial | Operator token rotation procedure documented; per-client scoped tokens and permission audit remain. |
| P3 PoR wording | open | `NOT_ESTABLISHED` remains for custody/CPA; Sybil/“off-chain oracle” claims still need rewording. |
| P4-3 Android auth | partial | Approval intent is now routed from `MainActivity` through `ConsoleRoot` to the biometric approval screen; there is still no FCM/APNs transport. |
| P4-4 Android backup | fixed | `android:allowBackup="false"` is set. Data-extraction rules should still be added for API 31+. |
| P5 tests | partial | Added runtime-gate and build-403 tests; Android and CloudShell still have no automated suites; authorization-matrix and fuzz targets are open. |
| P6 claims drift | fixed | `features/status.json` is authoritative; `docs/FEATURE-STATUS.md` is generated and CI fails on drift. |
| P7-1 manifest | fixed | `scripts/integrity-manifest.mjs` verifies/regenerates; CI job added. |
| P7-2 tamper evidence | open | Manifest is same-repo only; signed tags/cosign/external anchor are not set up. |
| P7-3 supply chain | partial | SBOM and security-check scripts exist; Actions are not SHA-pinned, no Dependabot/CodeQL/cargo-deny workflow yet. |
| P7-4 review | partial | `CODEOWNERS` added; branch protection is a repository setting and was not applied. |
| P8-4 append-only audit | fixed | Migration v8 adds a `BEFORE DELETE` trigger rejecting deletes on `auth_events`. |
| P8 others | open | Off-device encrypted backups, WAL starvation testing, relay HA and tracked remediation issues remain. |
| P9-1 licence/security | fixed | Apache-2.0 `LICENSE`, `SECURITY.md`, `CONTRIBUTING.md`. |
| P9-2 notices | partial | `NOTICE` lists major dependencies; a generated full licence inventory is still needed (libvips is LGPL). |
| P9-3/4/5 legal | open | Counsel review, retention policy and an independent audit are external actions. |

## Verification this pass

- `npm test` (dashboard), `tsc --noEmit`, Next.js production build.
- `cargo test -p core-engine` after the preview CSP change.
- `node scripts/integrity-manifest.mjs` and `render-feature-status.mjs --check`.
