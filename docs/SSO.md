# Custom SSO Provider

**Status:** implemented in the control plane and covered by the dashboard test
suite. This document describes the identity provider that sits on top of the
existing passkey/session authentication: OpenID Connect, SAML 2.0, SCIM 2.0,
and single logout.

The provider is part of `apps/web-dashboard`. It stores clients, service
providers, signing keys and provisioning tokens in the same SQLite database as
the rest of the platform, and it uses the same account, passkey and session
model. There is no second user store.

---

## 1. Public endpoints

The implementation lives in the catch-all API route, and `next.config.mjs`
rewrites the standard paths onto it, so a relying party is configured from the
discovery document alone. Direct `/api/...` paths also work.

| Purpose | Public path | Implementation path |
| :--- | :--- | :--- |
| OIDC discovery | `/.well-known/openid-configuration` | `/api/.well-known/openid-configuration` |
| JWKS | `/.well-known/jwks.json` | `/api/.well-known/jwks.json` |
| Authorization | `/oauth/authorize` | `/api/oauth/authorize` |
| Token | `/oauth/token` | `/api/oauth/token` |
| UserInfo | `/oauth/userinfo` | `/api/oauth/userinfo` |
| Revocation (RFC 7009) | `/oauth/revoke` | `/api/oauth/revoke` |
| End session | `/oauth/logout` | `/api/oauth/logout` |
| SAML metadata | `/saml/metadata` | `/api/saml/metadata` |
| SAML SSO | `/saml/sso` | `/api/saml/sso` |
| SCIM 2.0 | `/scim/v2/...` | `/api/scim/v2/...` |

The issuer is the configured public origin (`MOBILECLOUD_PUBLIC_ORIGIN`), with
no path suffix. In production it must be HTTPS.

---

## 2. OpenID Connect

Supported: Authorization Code with PKCE (`S256`) only. The implicit and
password grants are not exposed. Access tokens are opaque `mc_…` values; the
ID token is a signed JWT.

### 2.1 Discovery

`GET /.well-known/openid-configuration` returns the issuer, authorization,
token, userinfo, JWKS, revocation and end-session endpoints, `RS256` ID-token
signing, `S256` challenges, the supported scopes and claims, and
`backchannel_logout_supported: true`.

### 2.2 Authorization

```
GET /oauth/authorize
  ?response_type=code
  &client_id=…
  &redirect_uri=https%3A%2F%2Fapp.example.com%2Fcallback
  &scope=openid%20profile%20email
  &state=…
  &nonce=…
  &code_challenge=…
  &code_challenge_method=S256
```

The request is validated against the registered client before the consent page
is shown: the client must exist, the redirect URI must be in its exact list,
the challenge must be a 43-character base64url S256 digest, and every scope
must be allowed for that client. The browser then sees `/authorize`, which
explains the requested scopes and posts an approve/deny decision.

On approval the server stores a single-use code (five minutes) with the PKCE
challenge, redirect URI, scope, nonce and authenticated user, and redirects to
`redirect_uri?code=…&state=…`.

### 2.3 Token

```
POST /oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code
&code=…
&redirect_uri=…
&client_id=…
&code_verifier=…
```

* The verifier must hash to the stored challenge.
* A confidential client authenticates with HTTP Basic (`client_secret_basic`) or
  `client_secret_post`; a public client sends only `client_id`.
* The response contains `access_token`, `token_type`, `expires_in`,
  `refresh_token`, `scope`, and — when `openid` was granted — `id_token`.
* Access tokens for OIDC clients live 15 minutes by default
  (`MOBILECLOUD_OIDC_ACCESS_TTL`); refresh tokens rotate on every use and a
  replayed token revokes the whole family.
* The authorization code is consumed even when the exchange fails after
  validation, so it cannot be retried with a different verifier.

ID token claims: `iss`, `sub` (the account id), `aud`, `azp`, `iat`, `exp`,
`auth_time`, `nonce` (when sent), `sid` (when the ceremony came from a
session), and the claims for the granted scopes — `email`/`email_verified` for
`email`, `name`/`preferred_username` for `profile`.

### 2.4 UserInfo and revocation

`GET /oauth/userinfo` with `Authorization: Bearer mc_…` returns the same claims
the scopes allow, plus `role`. An unknown or expired token answers `401` with
`WWW-Authenticate: Bearer error="invalid_token"`.

`POST /oauth/revoke` accepts `token` and revokes an access token together with
its refresh chain, or a refresh token by itself. It answers `200` for unknown
tokens as RFC 7009 requires, so it cannot be used as a token oracle.

### 2.5 Signing keys

RS256 keys live in `signing_keys` with their public JWK. On first use a 2048-bit
RSA key is generated; an operator can inject one with
`MOBILECLOUD_OIDC_PRIVATE_KEY` (PEM, `\n` accepted). `/.well-known/jwks.json`
publishes every active key, which gives a rotation overlap window: insert the
new key as active before retiring the old one.

The private key is stored in the database. For production, encrypt that column
or replace it with a KMS/HSM signer; the signing call is isolated in
`lib/server/oidc.ts`.

### 2.6 Registering a client

Owner session + CSRF required:

```bash
curl -X POST https://console.example.com/api/admin/oidc-clients \
  -b 'mc_session=…' -H 'x-mc-csrf: …' -H 'content-type: application/json' \
  -d '{
    "name": "Example App",
    "redirect_uris": ["https://app.example.com/callback"],
    "post_logout_redirect_uris": ["https://app.example.com/signed-out"],
    "scopes": ["openid", "profile", "email"],
    "grant_types": ["authorization_code", "refresh_token"],
    "public": true,
    "backchannel_logout_uri": "https://app.example.com/backchannel-logout"
  }'
```

The response includes `client_id` and, for a confidential client,
`client_secret` **once**. Only its SHA-256 is stored. Redirect URIs are exact:
HTTPS anywhere, or HTTP only for `127.0.0.1`/`localhost` development clients.

Other administration endpoints:

| Method and path | Purpose |
| :--- | :--- |
| `GET /api/admin/oidc-clients` | List clients (never secrets). |
| `DELETE /api/admin/oidc-clients/{id}` | Delete a client. |
| `GET /api/admin/saml-sps` | List SAML service providers. |
| `POST /api/admin/saml-sps` | Register one. |
| `DELETE /api/admin/saml-sps/{id}` | Remove one. |
| `GET /api/admin/scim-tokens` | List provisioning tokens. |
| `POST /api/admin/scim-tokens` | Issue one (shown once). |
| `DELETE /api/admin/scim-tokens/{id}` | Revoke one. |
| `GET /api/admin/sso` | Issuer, clients, SPs and the active key id. |

---

## 3. SAML 2.0

The IdP supports SP-initiated SSO with the HTTP-Redirect binding to
`/saml/sso`, and answers with a signed assertion in an auto-submitting
HTTP-POST form to the SP's registered ACS URL.

* `/saml/metadata` publishes an `EntityDescriptor` with the SSO endpoint and the
  IdP signing certificate.
* A service provider is registered by entity id with its ACS URL and, when it
  signs its requests, its X.509 certificate:
  `POST /api/admin/saml-sps`.
* The ACS URL is always taken from the registration, never from the request.
  `Destination` must match the IdP SSO URL, and an unknown issuer is refused.
* Requests are checked for DOCTYPE/ENTITY declarations before parsing (XXE
  guard), then parsed with `@xmldom/xmldom`. A signed request is verified with
  `xml-crypto` against the SP certificate; an SP registered with a certificate
  must sign its requests.
* The assertion is signed with RSA-SHA256 over exclusive canonicalisation,
  includes the audience restriction, subject confirmation, `InResponseTo`,
  conditions, and `email`, `name` and `uid` attributes.

Binding notes: the session cookie is `SameSite=Lax`, so a cross-site HTTP-POST
to `/saml/sso` does not carry it. SP-initiated flows should use the Redirect
binding; the POST path works for same-site portals and IdP-initiated launches
where a session already exists. SAML single logout is not implemented — use
OIDC back-channel logout or short sessions.

---

## 4. SCIM 2.0

Provisioning tokens are separate from user tokens: `scim_<48 hex>`, stored only
as SHA-256, scoped to the owner account that issued them.

```bash
curl -X POST https://console.example.com/api/admin/scim-tokens \
  -b 'mc_session=…' -H 'x-mc-csrf: …' -H 'content-type: application/json' \
  -d '{"name":"Okta"}'
```

Use the returned token as `Authorization: Bearer scim_…`.

| Endpoint | Methods |
| :--- | :--- |
| `/scim/v2/ServiceProviderConfig` | GET |
| `/scim/v2/Users` | GET (filter), POST |
| `/scim/v2/Users/{id}` | GET, PUT, PATCH, DELETE |
| `/scim/v2/Groups` | GET (filter), POST |
| `/scim/v2/Groups/{id}` | GET, PATCH, DELETE |

Supported filters: `userName eq "…"`, `externalId eq "…"` on Users;
`displayName eq "…"`, `externalId eq "…"` on Groups. Unsupported filters answer
`400` with `scimType: "invalidFilter"` rather than being silently ignored.

Users created through SCIM get the `member` role, the community plan, and no
password (`!`). Deactivating a user (`active: false` via PUT or PATCH) sets
`users.active = 0`, deletes every session, expires access tokens, revokes
refresh tokens and writes an `auth.user.deactivated` audit event. Login,
passkey authentication, session lookup and bearer lookup all refuse an inactive
account. Reactivating restores the account without restoring old credentials.

SCIM responses use `application/scim+json` and the standard schemas, including
`meta.resourceType`, `meta.created`, `meta.lastModified` and `meta.location`.

---

## 5. Single logout

* **Front channel**: `GET /oauth/logout` clears `mc_session`/`mc_csrf`, deletes
  the browser session, and redirects to `post_logout_redirect_uri` only when it
  is registered for the named client. `state` is echoed back.
* **Everything**: `?all=1` also deletes every session of the account, expires
  its access tokens and revokes its refresh tokens.
* **Back channel**: when a client registered `backchannel_logout_uri`, the
  provider POSTs a signed `logout_token` (audience-bound, two-minute lifetime,
  `events` claim, `sid`) to it. Delivery is best effort with a two-second
  timeout and never blocks the logout. Clients must verify the token against
  the JWKS and check `iss`, `aud`, `iat`/`exp` and the event claim.

Access tokens remain valid until they expire after a back-channel logout. That
is the stateless-JWT limitation described in the report: keep the access-token
lifetime short (15 minutes by default) or check revocation server-side.

---

## 6. Security properties and limits

Implemented:

* exact redirect matching, PKCE S256, single-use codes, `state`/`nonce`
  pass-through, confidential-client authentication;
* SHA-256 at rest for client secrets, SCIM tokens, refresh tokens and session
  tokens;
* refresh rotation with family revocation; RFC 7009 revocation;
* owner-only, CSRF-protected, recent-login-gated administration;
* XML parsing with a DOCTYPE guard, signed-request verification, exact ACS URLs;
* back-channel logout tokens bound to one client and one event;
* every login, logout, code consent and deprovisioning writes an auth event.

Not implemented (do not claim otherwise):

* SAML single logout, SAML assertion encryption, or SAML artifact binding;
* DPoP, mTLS, or token binding;
* multi-tenant client ownership — clients and SPs are global to the deployment;
* a hosted admin UI for client registration (the JSON API is the interface);
* HSM-backed signing — the private key is a database column;
* SCIM bulk operations, `/Me`, or ETag concurrency control.

---

## 7. Configuration

| Variable | Effect |
| :--- | :--- |
| `MOBILECLOUD_PUBLIC_ORIGIN` | Issuer and endpoint origin. Required in production. |
| `MOBILECLOUD_OIDC_PRIVATE_KEY` | RS256 private key PEM injected instead of generating one. |
| `MOBILECLOUD_OIDC_ACCESS_TTL` | OIDC access-token lifetime in milliseconds (default 900000). |
| `MOBILECLOUD_DB` | Database holding clients, keys, SPs, tokens and accounts. |

The `mobilecloud-cli` client is seeded by migration so the CLI keeps working;
it is public, uses PKCE/device code, and is limited to the `cli:full` scope.

---

## 8. Tests

```bash
cd apps/web-dashboard
npm test
```

`oidc.test.ts` covers discovery/JWKS, the full PKCE exchange with a real
signature verification against the published key, userinfo, refresh rotation
and reuse detection, revocation, confidential-client authentication, redirect
rejection, and post-logout redirect validation. `saml.test.ts` and
`scim.test.ts` cover their protocols, including signature verification,
deprovisioning side effects and filter rejection.
