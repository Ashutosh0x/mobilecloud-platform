# MobileCloud — Security Threat Model

**Scope:** the MobileCloud platform plane (edge engine, terminal gateway, web
console, Android client, tunnel/shield, fleet mesh). The FurlPay Proof-of-Reserve
trust path has its own threat matrix in [`SECURITY-MODEL.md`](SECURITY-MODEL.md)
and is referenced, not duplicated, here.

**Method:** asset inventory → trust boundaries → threat table (STRIDE-flavoured)
→ current control → status → residual risk. Status tags reuse the audit
taxonomy: `VERIFIED_SOURCE` (control exists in code + a passing test),
`PARTIAL`, `NOT_ESTABLISHED`.

**Posture:** fail-closed. Every authentication or validation failure must deny,
never degrade to allow.

---

## 1. Assets

| Asset | Why it matters |
| :--- | :--- |
| Host shell / PTY | Arbitrary code execution as the engine UID if reached. |
| Tenant data (SQLite) | Confidentiality + integrity across tenants. |
| Device identity keys | Impersonation of a fleet node / forged telemetry. |
| Infrastructure secrets | API tokens, webhook signing keys, SSH authorised keys. |
| Signing keys (FurlPay) | Forgery of a proof-of-reserve quorum (separate trust path). |
| Artifact store | Serving tampered app artifacts to users. |
| Fleet control plane | Directing work to (or revoking) devices. |

---

## 2. Trust boundaries

```
┌──────────────┐   untrusted internet   ┌────────────────────────────┐
│  Browser /   │ ─────────────────────► │ Edge (shield: WAF+ratelimit)│
│  Android app │                        └─────────────┬──────────────┘
└──────────────┘                                      │ trusted hop
                                                     ▼
                             ┌───────────────────────────────────────────┐
                             │ core-engine (:3000 op, :3001 deploy)       │
                             │  • proxy router (artifact root confinement)│
                             │  • terminal gateway (PTY/WS/SSH/preview)   │
                             └───────┬───────────────────────┬───────────┘
                                     │                       │
                             ┌───────▼──────┐        ┌───────▼──────────┐
                             │ SQLite WAL   │        │ fleet-mesh API   │
                             │ (outbox)     │        │ (Ed25519 nodes)  │
                             └──────────────┘        └──────────────────┘
```

Trust boundary crossings that receive the most scrutiny: (a) internet → shield,
(b) browser → terminal gateway, (c) device → fleet-mesh enrollment/heartbeat,
(d) engine → tenant data.

---

## 3. Threat table

### 3.1 Terminal / execution surface

| Threat | Current control | Status |
| :--- | :--- | :--- |
| Unauthorised PTY access | Terminal sessions require a **single-use ticket** + an **Origin allowlist**; preview sessions bind a specific port. | `VERIFIED_SOURCE` (`core-engine` terminal-gateway tests) |
| Path traversal via file transfer | Paths that escape the engine workspace are **refused**, not clamped. | `VERIFIED_SOURCE` |
| Command injection into PTY | PTY writes are session-scoped; no shell-string interpolation from request fields. | `PARTIAL` — adversarial suite is Phase 7. |
| Local build preview runs untrusted code | Preview runs in the **plain app UID**, not a sandbox. | **Known gap** (documented in README). Phase 7 item. |
| SSH exposure | SSH daemon **refuses a non-loopback bind** unless an Ed25519 key is authorised. | `VERIFIED_SOURCE` |
| Resource exhaustion (fork bombs, PTY floods) | Session limits exist; **process-level quotas/termination** are Phase 7 work. | `PARTIAL` |

### 3.2 Web console

| Threat | Current control | Status |
| :--- | :--- | :--- |
| CSRF on state-changing routes | `apps/web-dashboard/lib/csrf.ts` token check. | `VERIFIED_SOURCE` |
| Unauthenticated realtime stream | Anonymous WebSocket upgrade and unauthenticated `GET /api/sync/changes` are **rejected**. | `VERIFIED_SOURCE` (dashboard tests) |
| Cross-tenant data read | Sync frames and catch-up are **owner-scoped**; cross-account isolation asserted. | `VERIFIED_SOURCE` |
| SSR of untrusted repo content | Preview is engine-side, not dashboard-side. | `VERIFIED_SOURCE` |

### 3.3 Webhooks / outbound

| Threat | Current control | Status |
| :--- | :--- | :--- |
| SSRF via webhook target | **Loopback and private targets are refused.** | `VERIFIED_SOURCE` |
| Webhook forgery | Delivery signed **HMAC-SHA256**. | `VERIFIED_SOURCE` |
| Delivery storm | Backoff capped at **5 attempts**; queued once per subscriber in the event's own transaction. | `VERIFIED_SOURCE` |

### 3.4 Edge (shield / tunnel)

| Threat | Current control | Status |
| :--- | :--- | :--- |
| Encoded WAF bypass (traversal/SQLi/XSS/CMDi) | WAF **percent-decodes before matching**; clean requests allowed. | `VERIFIED_SOURCE` (`mobilecloud-shield` 11 tests) |
| Brute force / flooding | Sliding-window rate limiter; CrowdSec-compatible blocklist load/add/check/expiry-prune. | `VERIFIED_SOURCE` |
| Spoofed client IP | Client IP taken from `X-Forwarded-For` / `X-Real-IP` with loopback fallback. | `VERIFIED_SOURCE` |
| Tunnel handshake forgery | Ed25519 sign→verify handshake; `Host`→service routing. | `VERIFIED_SOURCE` (`mobilecloud-tunnel` 7 tests) |
| NAT traversal abuse | NAT traversal not implemented on the fleet path yet. | `NOT_ESTABLISHED` (Phase 3) |

### 3.5 Fleet control plane (`fleet-mesh`)

| Threat | Current control | Status |
| :--- | :--- | :--- |
| Impersonating a device | Enrollment binds a device's **Ed25519 public key** to a stable `NodeId`; heartbeats must be **signed**. | `VERIFIED_SOURCE` (43 tests) |
| Forged signature | `verify_strict` over a hex-decoded key; **fails closed** on any malformed input. | `VERIFIED_SOURCE` |
| Replay of a heartbeat | Strictly-increasing `seq`; replay → `409`, gap handled. | `VERIFIED_SOURCE` |
| Unauthorised enrollment / operator call | Constant-time comparison of `x-enrollment-token` and `Authorization: Bearer`; any failure → `401`. | `VERIFIED_SOURCE` |
| Zombie / revoked node keeps reporting | `revoked` set excludes the node from availability and rejects its heartbeats → `403`. | `VERIFIED_SOURCE` |
| Timing oracle on tokens | Constant-time equality (`ct_eq`, XOR accumulator, no early return). | `VERIFIED_SOURCE` |
| Duplicate enrollment | Enrollment is **idempotent per device public key** (same `NodeId`). | `VERIFIED_SOURCE` |
| Timestamp forgery / freshness | Replay defense is **sequence-based**; wall-clock freshness windows are Phase 3 work. | `PARTIAL` |
| Telemetry lying about hardware | `Measurement` type **refuses** an `Unsupported` value carrying data and rejects impossible values. | `VERIFIED_SOURCE` |
| Mesh rate limiting / abuse detection | Not implemented on the fleet path. | `NOT_ESTABLISHED` (Phase 3) |

### 3.6 Proof-of-Reserve (summary; see `SECURITY-MODEL.md`)

| Threat | Control | Status |
| :--- | :--- | :--- |
| Quorum forgery | 3-of-5 Ed25519 over a **domain-separated** SHA-256 digest. | `DEPLOYED` |
| Signer duplication / reordering | Signatures must be in **strictly ascending** public-key order. | `DEPLOYED` |
| Replay / stale attestation | Monotonic `seq` + `valid_until` freshness. | `DEPLOYED` |
| Arithmetic overflow | Checked `U256` throughout (10,000-case suite). | `VERIFIED_SOURCE` |

---

## 4. Adversarial test plan (Phase 7 / 12)

Each item below must exist as an executed test before the corresponding control
is upgraded from `PARTIAL` to `VERIFIED_SOURCE`:

1. Path traversal: `../`, encoded `%2e%2e%2f`, over-long paths, NUL bytes.
2. Command injection: shell metacharacters through every field reaching a PTY or exec.
3. SSRF: webhook/preview/tunnel targets resolving to loopback, RFC1918, link-local, and DNS-rebinding hosts.
4. Auth bypass: missing / malformed / wrong bearer; token of correct prefix; timing.
5. Replay: reused terminal ticket; reused heartbeat `seq`; reused pairing claim.
6. Tenant boundary: cross-tenant read/write on every sync and API surface.
7. Resource exhaustion: PTY floods, oversized uploads, oversized artifact packaging, decompression bombs.
8. Cryptographic misuse: malformed hex keys/signatures, wrong-length digests, non-canonical JSON.
9. Supply chain: `cargo audit` / `npm audit` in CI (Phase 12).

---

## 5. Residual risks and honest gaps

- **Local build preview is not sandboxed** — highest-impact known gap.
- **Fleet path has no transport, discovery, rate limiting, or trust scoring yet.**
- **No dependency-vulnerability scanning in CI.**
- **Android has no automated security test suite** (build + lint only).
- **No hardware attestation / secure-enclave guarantee is claimed or verified.**

Anything not listed as `VERIFIED_SOURCE` above must not be described as mitigated.
