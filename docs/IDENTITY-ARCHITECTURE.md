# Identity Architecture

**Status:** MobileCloud is the identity provider. FurlPay is the first external
relying party. Financial authorization remains entirely inside FurlPay.

## The boundary

```
                    identity proof                      local authorization
User ── passkey/QR/password ──► MobileCloud IdP  ──►  FurlPay RP
                                      │                    │
                                      │ OIDC ID token      │ FurlPay session
                                      │ (who the user is)  │ passkey step-up
                                      ▼                    ▼
                              identity_audit_events   wallets, payments,
                                                      transfers, signing
```

MobileCloud answers **who**. FurlPay answers **what may be done**. An ID token
is never a payment authorization, and MobileCloud never holds wallet keys,
signing keys, spending policies or transaction approvals.

## Components

| Component | Location | Responsibility |
| :--- | :--- | :--- |
| Identity provider | `apps/web-dashboard/lib/server/oidc.ts`, `api.ts` | Discovery, JWKS, authorization, token, userinfo, introspection, revocation, logout |
| Authentication | `passkey.ts`, `qrlogin.ts`, `oauth.ts`, `sessions.ts` | Passkeys, QR approval, device grant, PKCE, sessions, refresh rotation |
| Identity data | `db.ts` (schema v7) | Users, credentials, sessions, clients, consents, external links, audit events |
| Administration | `/api/oauth/clients`, `/api/admin/*` | Client registration, SAML SPs, SCIM tokens, key rotation |
| FurlPay adapter | `integrations/furlpay/` | Relying-party client, linking, session handoff, financial boundary |

## Client roles

| Client | Flow | Session owner |
| :--- | :--- | :--- |
| FurlPay | OIDC Authorization Code + PKCE | FurlPay |
| MobileCloud dashboard | OIDC / existing session | MobileCloud |
| Android | Passkeys + QR approval (OIDC PKCE migration pending) | MobileCloud |
| CLI | RFC 8628 device grant or PKCE | CLI credential store |
| CloudShell | Short-lived terminal ticket | MobileCloud |

## Current vs planned

Implemented: OIDC provider, JWKS and rotation, passkeys, QR approval, device
grant, refresh rotation, revocation, introspection, consent persistence,
account-linking model, FurlPay reference adapter.

Not implemented in this repository: a FurlPay backend (their session/financial
engine), dynamic client registration, KMS-backed signing, Android OIDC PKCE
migration, and SCIM-managed organizations/tenants. These are production
blockers for the affected surfaces, not hidden behaviour.
