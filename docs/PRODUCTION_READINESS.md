# MobileCloud — Production Readiness

**Purpose:** an honest statement of what is deployable today, what the
operational tooling actually is, and what is missing before a real production
launch. This is the Phase 0/12 production view; it is not a marketing page.

Status tags: `READY` (exists and is exercised) · `PARTIAL` · `NOT_ESTABLISHED`.

---

## 1. What exists today

| Capability | Status | Evidence |
| :--- | :--- | :--- |
| CI pipeline | `READY` | `.github/workflows/ci.yml` — jobs: Rust kernel/contract/engine tests, Web-CloudShell build, Next.js console tests+build, Android debug compile+lint, and a tag-gated signed-release-APK job. |
| Signed Android release | `READY` | Tag `v*` builds, signs, and verifies the APK from GitHub Actions secrets (`RELEASE_KEYSTORE_BASE64`, `KEYSTORE_PASSWORD`, `KEY_ALIAS`, `KEY_PASSWORD`, `RELEASE_CERT_SHA256`). |
| Edge container stack | `READY` | `edge/docker/docker-compose.yml`: `mc-relay` (tunnel relay), `crowdsec`, `openobserve` (logs/metrics/traces), `caddy` (TLS + reverse proxy), on a private bridge network, with `nofile` ulimits raised. |
| Public TLS ingress | `READY` | `config/Caddyfile`: loopback-bound `:8080`, `zstd/br/gzip` encoding, HSTS + `nosniff` + `no-referrer`; **operator routes are answered `404`** and credential headers (`Authorization`, `Cookie`, `X-Api-Key`, `X-Terminal-Token`, `X-Hub-Signature-256`) are **stripped** before proxying to the public deployment listener `:3001`. |
| Relay service | `READY` | `edge/systemd/mc-relay.service`; `edge/Makefile`; relay authorised-key env `MC_AUTHORIZED_KEY`. |
| Health / metrics endpoints | `READY` | `/healthz` and `/metrics` exist and are explicitly excluded from public ingress by the Caddyfile. |
| Data durability (single node) | `PARTIAL` | SQLite in WAL mode; transactional outbox gives crash-safe event recovery. |
| Observability backend | `PARTIAL` | OpenObserve is deployed in the edge stack; **application-side** structured logging/tracing/alert rules are not wired (Phase 11). |
| Edge device provisioning | `PARTIAL` | `config/adb-bootstrap.sh`, `scripts/devnet-up.sh`, `config/cloudflared.yml`. |
| Secrets handling | `PARTIAL` | CI secrets + env vars only; no secret manager integration. |

---

## 2. Environment separation

| Environment | Status | Notes |
| :--- | :--- | :--- |
| Development | `READY` | `cargo test`, `npm test`, `scripts/devnet-up.sh`, `config/adb-bootstrap.sh`. |
| Staging | `NOT_ESTABLISHED` | No staging manifest/config exists. Phase 12. |
| Production | `PARTIAL` | `edge/docker/docker-compose.yml` + `config/Caddyfile` + systemd unit form a real single-host production stack; no hardened multi-env config layering. |

---

## 3. Secrets — current state and required posture

- Android release keystore: GitHub Actions **secrets** (never in the repo). ✔
- Relay authorised key: `MC_AUTHORIZED_KEY` env. Requires external secret injection in production.
- Console bootstrap: `MOBILECLOUD_BOOTSTRAP_PASSWORD` (≥12 chars) / `MOBILECLOUD_BOOTSTRAP_EMAIL`; the password must be removed from the environment after first provisioning.
- **Must change before any real launch:** `docker-compose.yml` ships `OBS_PASSWORD:-changeme` for OpenObserve — this default must be overridden with a real secret and the default removed from the manifest.

`NOT_ESTABLISHED`: no secret-manager (Vault/KMS/SSM) integration; no rotation policy; no automated secret scanning in CI.

---

## 4. Health, readiness, rollback

| Concern | Status | Notes |
| :--- | :--- | :--- |
| Liveness (`/healthz`) | `READY` | Excluded from public ingress. |
| Readiness probe | `NOT_ESTABLISHED` | No readiness distinction (DB/relay/engine dependency checks). |
| Container healthchecks | `NOT_ESTABLISHED` | Compose services declare none. |
| Deployment rollback | `PARTIAL` | `core-engine` promotes content-addressed deployments atomically and supports rollback; no orchestrator-level rollback automation. |
| Database migrations | `PARTIAL` | Dashboard uses SQLite; migrations are not automated/dry-run-validated in CI. |

---

## 5. Backup & disaster recovery

`NOT_ESTABLISHED`. There is no documented backup procedure, retention policy,
restore rehearsal, or RTO/RPO target. SQLite WAL provides crash consistency, not
durability against host loss. This is a Phase 12 deliverable.

---

## 6. Operational runbooks

`NOT_ESTABLISHED`. No documented runbooks for: relay outage, engine crash-loop,
SQLite corruption/recovery, certificate renewal, node mass-revocation, or
incident response. Phase 12 deliverable.

---

## 7. Supply chain

| Item | Status |
| :--- | :--- |
| Dependency vulnerability scan (`cargo audit`, `npm audit`) | `NOT_ESTABLISHED` — not in CI. |
| License/`cargo deny` policy | `NOT_ESTABLISHED`. |
| Reproducible builds | `PARTIAL` — pinned toolchain in CI, `Cargo.lock` committed. |
| SBOM generation | `NOT_ESTABLISHED`. |

---

## 8. Pre-launch checklist

Before this platform may be described as production-ready:

1. [ ] Build preview runs in a real sandbox (currently plain app UID).
2. [ ] Staging environment manifests exist and are exercised.
3. [ ] Secret manager integration + removal of the `changeme` default.
4. [ ] Readiness probes + container healthchecks.
5. [ ] Automated DB migration dry-run in CI.
6. [ ] Documented, rehearsed backup/restore + DR runbook.
7. [ ] `cargo audit` / `npm audit` in CI with a fail threshold.
8. [ ] Application-side structured logs, traces, and alert rules feeding OpenObserve.
9. [ ] Reproducible benchmark suite with recorded hardware/version provenance.

Until every box is ticked, the honest label is **local-evaluation build with a
real single-host edge stack**, which is what `README.md` §Release status states.

---

## 9. Deployment instructions (current, working)

```bash
# 1. Edge stack (relay + crowdsec + openobserve + caddy)
export MC_AUTHORIZED_KEY='<ed25519-authorised-key>'
export OBS_PASSWORD='<strong-password>'      # do not leave the changeme default
cd edge/docker && docker compose up -d

# 2. Web console
cd ../../apps/web-dashboard
export MOBILECLOUD_BOOTSTRAP_PASSWORD='<>=12 chars>'
npm ci && npm run build && npm start

# 3. Edge engine (operator :3000 loopback-only, deployment :3001 behind Caddy)
cargo build --release -p core-engine
./target/release/core-engine            # do NOT expose :3000 publicly

# 4. Android release (tag-gated in CI, or locally)
bash android-app/../scripts/build-and-sign-apk.sh
```

Never point the public reverse proxy or a tunnel at the operator listener on
`:3000` — the Caddyfile enforces this by answering operator paths with `404`.
