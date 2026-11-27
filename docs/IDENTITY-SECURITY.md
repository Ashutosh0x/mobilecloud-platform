# Identity Security

## Controls implemented

| Threat | Control |
| :--- | :--- |
| Authorization code interception | PKCE S256 required; code single use, 5 minutes, bound to client and redirect URI |
| CSRF on consent | `state` round trip; consent POST requires the session CSRF header; SameSite=Lax cookies |
| Redirect manipulation | Exact string match against registered URIs; HTTPS only (loopback HTTP for dev); no wildcards or fragments |
| Login CSRF / replay | `state` and `nonce` verified by the relying party; challenge single use |
| ID-token forgery | RS256 signature against pinned issuer JWKS; `iss`, `aud`, `azp`, `exp`/`iat` with skew; `kid` required |
| Refresh token theft | Rotation on every use; replay revokes the client's token family and writes an audit event |
| Token storage | Session, access, refresh, client secrets and SCIM tokens are SHA-256 hashed at rest; raw values returned once |
| Session fixation | New random session ID on every login; no session ID accepted from the client |
| Account enumeration | Generic login failure; link decisions only shown to an authenticated local account |
| Silent account merge | Identity key is `(iss, sub)`; email never links; explicit confirmation token bound to account and identity |
| SSRF via discovery/JWKS | HTTPS only, no credentials/fragments/redirects, private/loopback/link-local blocked, same-origin endpoints enforced |
| XXE / XML wrapping | DOCTYPE/ENTITY rejected before parsing; signed request reference URI must equal the request ID; SP certificate pinned |
| Brute force | Per-operation throttling, login throttle by email, account lockout counters, risk engine |
| Enumeration through introspection | Client-authenticated; unknown/expired tokens return `active:false` |
| Financial escalation through SSO | FurlPay adapter requires a device-bound passkey step-up for every financial action; SSO context always fails |

## Transport and browser controls

HTTPS is required in production; HSTS is emitted when the public origin is
HTTPS. `mc_session` is HttpOnly, Secure in production, SameSite=Lax;
`mc_csrf` is readable only for the double-submit header. `frame-ancestors
'none'`, `X-Frame-Options: DENY`, `nosniff`, and a referrer policy are set by
`next.config.mjs`. No CORS headers are emitted; browser clients are same-origin.

## Logging

Auth events record user id, event type, client type, credential type, session
and device ids, IP, user agent, geo, outcome, risk score and selected metadata.
Passwords, private keys, authorization codes, access tokens, refresh tokens,
client secrets and SCIM tokens are never logged. Error responses return a
description, not a stack trace.

## Residual risks and gaps

* Signing keys are database columns in this build; KMS/HSM is a production
  blocker.
* Access tokens are opaque and checked per request here, but a resource server
  that caches claims must honour `exp`.
* Back-channel logout is best effort; access tokens live until expiry.
* Discovery/JWKS SSRF checks are host-based; a hardened deployment should also
  resolve DNS and pin egress.
* Rate limiting is per process, not distributed.
* No DPoP, mTLS, PAR, JARM, or token exchange.
* Android still uses its cookie/passkey session rather than OIDC PKCE.
* FurlPay's own controls (step-up, limits, risk, compliance) are outside this
  repository and must be verified in its environment.
