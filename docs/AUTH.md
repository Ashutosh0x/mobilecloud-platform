# Unified Authentication

**Status:** implemented and covered by the dashboard test suite. This document
describes what the code actually does, the wire protocols, and the limits that
are deliberately not claimed.

One account signs in on four surfaces — the Android app, the web console, the
CloudShell terminal, and the `mobilecloud` CLI — with one identity and a
separate, revocable session per client.

---

## 1. Identity model

| Object | Table | Purpose |
| :--- | :--- | :--- |
| Account | `users` | Email, display name, role, plan, optional password hash, lockout counters, timezone. A passkey-only account stores the sentinel `!`, never a password hash. |
| Passkey | `credentials` | COSE public key, signature counter, transports, AAGUID, backup flag, device label. |
| WebAuthn ceremony | `webauthn_challenges` | Hashed challenge, kind (`register`/`authenticate`), RP id and origin, five minute expiry, single use. |
| Session | `sessions` | SHA-256 of the session token, CSRF token, `client_type`, optional device and credential binding, IP, timestamps. |
| Device | `connected_devices` | A phone or browser that was linked, the access token that backs it, platform, method, revocation. |
| Access token | `access_tokens` | SHA-256 of an `mc_…` bearer token, scope, `client_type`, expiry. |
| Refresh token | `refresh_tokens` | SHA-256 of an `mcr_…` token, rotation chain (`used_at`, `replaced_by`), revocation. |
| Device grant | `oauth_device_codes` | Hashed `device_code`, display `user_code`, client, scope, approval, expiry. |
| PKCE code | `oauth_authorization_codes` | Hashed code, PKCE challenge, redirect URI, single use. |
| QR login | `qr_login_challenges` | Hashed challenge, hashed poll secret, display code, browser label, approval, claimed session. |
| Audit trail | `auth_events` | Append-only authentication events with risk score and factors. |

Every credential is stored as a hash. The raw value exists once, in the
response that hands it to the client.

`client_type` gives each surface its own lifetime (override with
`MOBILECLOUD_SESSION_TTL_<CLIENT>`, milliseconds):

| Client | Default lifetime | Refresh | Write authority |
| :--- | :--- | :--- | :--- |
| `android` | 30 days | 30-day rotating refresh token | Full, device-bound |
| `web` | 24 hours | none | Full, CSRF-bound cookie |
| `cli` | 1 hour access token | 30-day rotating refresh token | `cli:full` scope: revocation routes only |
| `api` | 24 hours | none | Read-only |

---

## 2. Flows

### 2.1 Passkey registration (Android or web)

```
POST /api/auth/passkey/register/begin    { email?, password?, deviceName, devicePlatform }
  → { challenge_id, publicKey: <creation options> }

navigator.credentials.create() / CredentialManager.createCredential()
  → authenticator verifies the user, creates a discoverable ES256 credential

POST /api/auth/passkey/register/finish   { challengeId, credential, deviceName, devicePlatform }
  → { user, credential_id, device_id } + Set-Cookie: mc_session, mc_csrf
```

A passkey never creates an account. With no session the caller must prove the
account once with its password; with a session the new passkey is simply added.
The ceremony is bound to the console's own origin and RP id (`passkeyConfig`),
the client data origin is checked, `userVerification` is required, and a
resident key is required.

### 2.2 Passkey login

```
POST /api/auth/passkey/login/begin     { email?, deviceName, devicePlatform }
  → { challenge_id, publicKey: { challenge, rpId, allowCredentials?, userVerification: "required" } }

navigator.credentials.get() / CredentialManager.getCredential()

POST /api/auth/passkey/login/finish    { challengeId, credential, deviceName, devicePlatform }
  → risk assessment, then { user, device_id } + session cookies
```

The assertion is verified against the stored COSE key, the authenticator data's
RP id hash, the user-presence and user-verification flags, and the signature
counter (a counter that moves backwards is refused). A blocked risk assessment
returns `403` before any session is created.

### 2.3 Login with MobileCloud (phone approves the browser)

```
POST /api/auth/qr-login/init            { browser }
  → { challenge_id, verification_code, qr_data_url, qr_payload, poll_secret, expires_in_ms }

browser renders qr_data_url; phone scans the payload:
  mobilecloud://login?v=1&api=https://console…&id=<32 hex>&challenge=<64 hex>&code=<6>&browser=…&expires=<ms>

POST /api/auth/qr-login/{id}/scan       { deviceName, devicePlatform }   → { ok: true }
POST /api/auth/qr-login/{id}/approve    { challenge, verification_code, credential? }
POST /api/auth/qr-login/{id}/deny       { }

GET  /api/auth/qr-login/{id}?poll=<poll_secret>
  → { status: WAITING | SCANNED | APPROVED | DENIED | EXPIRED | CONSUMED }
```

* The browser holds a 256-bit `poll_secret`; only its hash is stored, and only
  a request presenting the secret can read the challenge or claim the session.
* The phone signs the browser's challenge with its passkey, or approves with
  its own signed-in session when no passkey exists yet.
* Approval and session issuance are one transaction: the challenge is claimed
  with `UPDATE … WHERE status = 'approved'`, so two racing polls cannot both
  receive a credential.
* TTL is two minutes; the challenge is single use.

### 2.4 CLI: Device Authorization Grant (RFC 8628)

```
POST /api/oauth/device/code     { client_id: "mobilecloud-cli", scope: "cli:full" }
  → { device_code, user_code: "ABCD-1234", verification_uri: "<origin>/activate",
      verification_uri_complete, expires_in: 900, interval: 5 }

POST /api/oauth/device/verify   { user_code }            (console session + CSRF)
POST /api/oauth/device/{id}/approve                      (console session + CSRF)

POST /api/oauth/token           { grant_type: "urn:ietf:params:oauth:grant-type:device_code",
                                  device_code, client_id }
  → 428 authorization_pending until approved
  → { access_token: "mc_…", refresh_token: "mcr_…", expires_in: 3600, scope, token_type }
```

Tokens answer with RFC 6749 error documents (`error`, `error_description`), so a
client can distinguish `authorization_pending`, `slow_down`, `access_denied` and
`expired_token` without parsing prose.

### 2.5 CLI: Authorization Code + PKCE (browser)

```
GET  /api/oauth/authorize?response_type=code&client_id=…&redirect_uri=http://127.0.0.1:PORT/callback
     &code_challenge=…&code_challenge_method=S256&state=…&scope=cli:full
  → 302 to the console's /authorize consent page

POST /api/oauth/authorize        { client_id, redirect_uri, code_challenge, state, scope, decision }
  → 302 (or { redirect } when the page sends Accept: application/json)

POST /api/oauth/token            { grant_type: "authorization_code", code, code_verifier, … }
```

Only loopback redirects are accepted, on any port (RFC 8252). The verifier is
checked with S256 before a token is issued; the code is single use and expires
in five minutes.

### 2.6 Refresh rotation

A refresh token is single use. Presenting one twice means it was stolen or
replayed, so the whole family is revoked and the client must sign in again:

```
POST /api/oauth/token  { grant_type: "refresh_token", refresh_token, client_id }
```

`used_at` marks a consumed token; `replaced_by` links the chain; reuse sets
`revoked = 1` for every token in the family. Access tokens are hashed and
time-limited; a rotated pair is written in one transaction.

---

## 3. HTTP surface

| Method and path | Session | CSRF | Notes |
| :--- | :--- | :--- | :--- |
| `POST /api/auth/login` | — | — | Email and password; same generic failure message for wrong email and wrong password. |
| `POST /api/auth/logout` | cookie or bearer | cookie | Deletes the session, revokes the token's refresh chain, and revokes a device-bound credential. |
| `GET /api/auth/me` | optional | — | `{ user, csrfToken, token }`; `user` is `null` when anonymous. |
| `GET /api/auth/sessions` | yes | — | Every credential of the account: browser/phone sessions (`kind: "session"`) and unattached CLI/API tokens (`kind: "token"`), with `clientType`, device, IP and `current`. |
| `DELETE /api/auth/sessions/{id}` | yes | cookie | Revokes one session, or one token together with its refresh chain; refuses the caller's own cookie session. |
| `GET /api/auth/events` | yes | — | The account's audit trail, newest first. |
| `POST /api/auth/passkey/register/begin` … | optional | cookie | See §2.1. |
| `POST /api/auth/passkey/login/begin` … | — | — | See §2.2. |
| `POST /api/auth/qr-login/init` | — | — | See §2.3. |
| `GET /api/auth/qr-login/{id}?poll=` | poll secret | — | See §2.3. |
| `POST /api/oauth/device/code` | — | — | Starts a CLI grant. |
| `POST /api/oauth/device/verify` | yes | cookie | Looks up a display code. |
| `POST /api/oauth/device/{id}/approve` / `deny` | yes | cookie | Answers a grant. |
| `POST /api/oauth/token` | — | — | Device, refresh and PKCE grants. |
| `GET/POST /api/oauth/authorize` | yes (POST) | cookie (POST) | Consent for the browser flow. |
| `GET /api/devices` | yes | — | Linked devices. |
| `PATCH /api/devices/{id}` | yes | cookie | Rename. |
| `DELETE /api/devices/{id}` | yes | cookie | Revoke the device and its sessions. |

Bearer tokens are read-only **except** for `cli:full` tokens, which may log
out, refresh, and revoke devices and sessions — the operations the CLI itself
performs. Anything that changes the account still requires a CSRF-bound cookie
session.

Pages:

| Route | Purpose |
| :--- | :--- |
| `/login` | Password fallback and "Login with MobileCloud" QR. |
| `/activate` | Device-code approval for the CLI. |
| `/authorize` | PKCE consent screen. |
| `/device` | QR pairing of a new phone (the reverse direction: browser shows, phone links). |

---

## 4. CLI

Build:

```bash
cargo build -p mobilecloud-cli --release     # target/release/mobilecloud
```

```text
mobilecloud login [--method device|browser] [--server URL] [--no-browser] [--scope cli:full]
mobilecloud logout
mobilecloud whoami [--json]
mobilecloud devices [--json] [--all]
mobilecloud sessions [--json]
mobilecloud revoke-device <id|prefix> [--yes]
mobilecloud revoke-session <id|prefix> [--yes]
```

* Global `--server` overrides the saved origin; `--profile` selects a saved
  credential set (`MOBILECLOUD_SERVER` / `MOBILECLOUD_PROFILE` are also read).
* `login` defaults to the device grant, which works over SSH; `--method browser`
  uses PKCE with a loopback callback.
* Ids may be abbreviated to a unique prefix; an ambiguous prefix is refused.
* `whoami` prints a masked token, never the full value.

Credentials live in `~/.config/mobilecloud/credentials.json`
(`%APPDATA%\mobilecloud\credentials.json` on Windows), written atomically with
mode `0600`. An existing file that other users can read is refused rather than
trusted. `MOBILECLOUD_CONFIG_DIR` relocates the file, primarily for tests and
portable installs.

```json
{
  "version": 1,
  "profiles": {
    "default": {
      "server": "https://console.example.com",
      "user_id": "…",
      "email": "alice@example.com",
      "access_token": "mc_…",
      "refresh_token": "mcr_…",
      "token_expires_at": 1732712400000,
      "scope": "cli:full",
      "client_type": "cli"
    }
  },
  "current_profile": "default"
}
```

A `401` triggers exactly one refresh attempt and a retry; the rotated pair is
written back before the retry. `logout` deletes the local profile even when the
server is unreachable, and reports which happened.

---

## 5. Android

New code lives under `com.mobilecloud.auth` and `com.mobilecloud.ui.auth`:

| File | Role |
| :--- | :--- |
| `auth/PasskeyManager.kt` | Credential Manager registration and login; maps cancellation separately from failure. |
| `auth/LoginApproval.kt` | Strict `mobilecloud://login` payload parser; scan/approve/deny calls. |
| `auth/AuthRequestNotifier.kt` | High-importance notification channel and intent routing for approval requests. |
| `ui/auth/LoginApprovalScreen.kt` | Approval UI with `BIOMETRIC_STRONG` or device credential before the network call. |

The Android UI is **not yet routed from `MainActivity`**: the screen and its
notification are complete, but the console shell must call the composable and
handle the `com.mobilecloud.AUTH_APPROVAL` intent. No FCM dependency is added —
the notifier is transport-agnostic and expects a push service (or polling) to
call it once credentials are configured.

---

## 6. Audit and risk

Every authentication event is appended to `auth_events`: register, passkey and
password logins, QR approval, device grant, logout, session and device
revocation, token creation/refresh/reuse, credential changes, and suspicious
activity.

`assessLoginRisk` sums independent signals and never judges from one alone:

| Signal | Weight |
| :--- | ---: |
| 5+ failures in 10 minutes | 0.40 |
| 3–4 failures in 10 minutes | 0.20 |
| Address never used in 30 days | 0.15 |
| Country never used in a year | 0.20 |
| Travel faster than 1,000 km/h since the last geolocated login | 0.50 |
| Unusual local hour (after 3+ known hours) | 0.10 |
| Password instead of a passkey | 0.10 |

Actions: `< 0.3` allow, `0.3–0.6` allow and notify, `0.6–0.8` require a second
factor, `>= 0.8` block. The assessment is written into the event, including the
factor list, so a block can be explained later.

Geography comes from a local CSV table (`MOBILECLOUD_GEOIP`, default
`<data>/geoip.csv`, format `CIDR,CC,lat,lon`). With no table, geographic
signals are simply absent; no login fails because a lookup is unavailable.

---

## 7. Deliberate limits

These are **not** implemented and must not be described as such:

* **WebAuthn attestation** is requested as `none`; the authenticator's model and
  provenance are recorded (AAGUID) but not cryptographically verified.
* **Hardware attestation is not bound to the passkey.** The existing Ed25519
  key in `HardwareAttestation.kt` still serves Soroban identity only.
* **Push approval** has no delivery transport. The server records the request
  and the Android notifier can display it, but no FCM/APNs credentials exist.
* **Suspicious-login responses** are limited to block/notify at login time; there
  is no step-up challenge endpoint yet.
* **GeoIP** is a static local table, not a live database.
* **Rate limiting** is per operation and per target inside one process, not a
  distributed limiter, and does not trust forwarded addresses for identity.
* **The Android approval screen is not wired into navigation** (see §5).

---

## 8. Configuration

| Variable | Effect |
| :--- | :--- |
| `MOBILECLOUD_PUBLIC_ORIGIN` | Canonical HTTPS origin. Passkey RP id and origin derive from it; production refuses to start an origin-dependent flow without it. |
| `MOBILECLOUD_BOOTSTRAP_EMAIL` / `MOBILECLOUD_BOOTSTRAP_PASSWORD` | Local operator provisioning only; no remote signup. |
| `MOBILECLOUD_SESSION_TTL_ANDROID` / `_WEB` / `_CLI` / `_API` | Session lifetime in milliseconds. |
| `MOBILECLOUD_GEOIP` | Path to the GeoIP CSV. |
| `MOBILECLOUD_CONFIG_DIR` | CLI credential directory. |
| `MOBILECLOUD_SERVER`, `MOBILECLOUD_PROFILE` | CLI defaults. |

---

## 9. Tests

```bash
cd apps/web-dashboard && npm test     # includes auth.test.ts, oauth.test.ts,
                                      # passkey.test.ts, qrlogin.test.ts, audit.test.ts
cargo test -p mobilecloud-cli         # PKCE vector, UTC formatting, credential file
```

The dashboard suite exercises the full device grant (including single use and
scope), refresh rotation with family revocation, CLI-bearer write limits, the
QR login handshake end to end, the WebAuthn option shapes, and the risk engine's
thresholds and ordering.
