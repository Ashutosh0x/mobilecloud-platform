# OIDC Provider

Issuer: `MOBILECLOUD_ISSUER` (defaults to `MOBILECLOUD_PUBLIC_ORIGIN`). It must
be a bare HTTPS origin; the proposed production value is
`https://auth.furlpay.com`. Standards paths are rewritten by `next.config.mjs`
onto `/api/*`, so `https://auth.furlpay.com/oauth/token` and
`/api/oauth/token` reach the same handler.

## Discovery

`GET /.well-known/openid-configuration` publishes the issuer, authorization,
token, userinfo, JWKS, revocation, introspection and end-session endpoints,
`response_types_supported: ["code"]`, `S256`, RS256, supported scopes/claims,
and `backchannel_logout_supported: true`.

`GET /.well-known/jwks.json` publishes every RS256 key with `active IN (1,2)`;
key id, `use=sig`, `alg=RS256`, modulus and exponent.

## Flows

Only Authorization Code + PKCE S256 is accepted. Implicit, password and client
credentials grants are not exposed.

```
GET  /oauth/authorize?response_type=code&client_id=…&redirect_uri=…&scope=openid…
     &state=…&nonce=…&code_challenge=…&code_challenge_method=S256
POST /oauth/authorize        (consent; cookie + CSRF; JSON or accept: application/json)
POST /oauth/token            (form-encoded; client_secret_basic/post or public client)
GET  /oauth/userinfo         (Bearer mc_…)
POST /oauth/revoke           (RFC 7009)
POST /oauth/introspect       (RFC 7662; client-authenticated)
GET  /oauth/logout           (RP-initiated logout)
```

The authorization request is validated before the consent page: registered
client, exact redirect URI, 43-character base64url challenge, allowed scopes.
The code is single use, expires in five minutes, and records the nonce. On
approval the scope set is persisted in `identity_consents`.

The token response includes `access_token`, `token_type`, `expires_in`,
`refresh_token`, `scope` and, when `openid` was granted, `id_token`. OIDC access
tokens live 15 minutes by default (`MOBILECLOUD_OIDC_ACCESS_TTL`); refresh tokens
rotate on every use and replay revokes the client's token family.

ID token claims: `iss`, `sub`, `aud`, `azp`, `iat`, `exp`, `auth_time`, `nonce`,
`sid`, plus `email`/`email_verified` with the `email` scope and
`name`/`preferred_username` with `profile`.

## Client management

`GET|POST /oauth/clients`, `GET|PATCH|DELETE /oauth/clients/{id}`. Owner role,
CSRF, and a recent login are required. Redirect URIs are exact; HTTPS only,
except loopback HTTP for development. A confidential client's secret is returned
once and stored as SHA-256. `/api/admin/oidc-clients` remains as a compatibility
alias.

```bash
curl -X POST https://auth.furlpay.com/api/oauth/clients \
  -b 'mc_session=…' -H 'x-mc-csrf: …' -H 'content-type: application/json' \
  -d '{"name":"FurlPay","redirect_uris":["https://furlpay.com/auth/mobilecloud/callback"],
       "scopes":["openid","profile","email"],"public":true}'
```

## Consent

`GET /api/auth/consents` lists approvals; `DELETE /api/auth/consents/{client_id}`
revokes one. A changed scope set replaces the stored value, so expanded access
is presented again.

## Not implemented

Dynamic client registration, device-flow support for arbitrary OIDC clients
(only the CLI client has the device grant), PAR, JARM, DPoP/mTLS, and token
exchange. These are documented gaps rather than silent fallbacks.
