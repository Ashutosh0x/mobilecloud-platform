# Sessions and Logout

Four different things are commonly called "logout". They are independent:

| Action | What ends | What does not |
| :--- | :--- | :--- |
| FurlPay logout | FurlPay's own session | MobileCloud session, other apps |
| MobileCloud browser logout | The `mc_session` row and its CSRF cookie | FurlPay's session, CLI tokens, other browser sessions |
| Federated identity logout (`?all=1`) | Every MobileCloud session and token for the account | FurlPay's separate session (unless FurlPay also logs out) |
| Device/token revocation | One device, access token or refresh chain | Other sessions |

## MobileCloud sessions

Each client has an independent `sessions` row with `client_type`, device
binding, IP and timestamps. `GET /api/auth/sessions` lists them (session and
CLI/API token credentials), `DELETE /api/auth/sessions/{id}` revokes one.

## Refresh rotation

Refresh tokens are single use; rotation writes the new pair in one transaction.
Presenting a consumed token revokes the family for that client and returns
`invalid_grant`. Reuse is written to the auth audit trail.

## OIDC end session

`GET|POST /oauth/logout`:

* clears `mc_session`/`mc_csrf` and deletes the browser session;
* accepts `id_token_hint`, `client_id`, `state` and
  `post_logout_redirect_uri`;
* redirects only to a URI registered for that client;
* `all=1` also deletes every session of the account, expires access tokens and
  revokes refresh tokens;
* sends a signed back-channel logout token to the named client, or every client
  with a registered URI, best effort with a two-second timeout.

Access tokens remain valid until expiry after a back-channel logout. Keep the
OIDC access-token lifetime at 15 minutes or use introspection/resource-server
checks for high-value APIs.

## Not implemented

No OIDC front-channel iframe logout, no SAML SLO, no automatic cross-application
session termination. Closing FurlPay does not end MobileCloud, and vice versa —
by design.
