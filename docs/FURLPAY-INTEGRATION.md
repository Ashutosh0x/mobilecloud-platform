# FurlPay Integration

MobileCloud is the identity provider. FurlPay is the relying party and retains
all financial authority. The deployable adapter lives in
`integrations/furlpay/`; its README is the integration contract for the FurlPay
team.

## Registration

Set the service environment and start the dashboard once; the client is
upserted on database open:

```bash
FURLPAY_OIDC_ENABLED=1
FURLPAY_OIDC_CLIENT_ID=furlpay
FURLPAY_OIDC_CLIENT_SECRET=...            # omit for a public PKCE client
FURLPAY_OIDC_REDIRECT_URI=https://furlpay.com/auth/mobilecloud/callback
FURLPAY_OIDC_SCOPES="openid profile email"
FURLPAY_OIDC_POST_LOGOUT_REDIRECT_URI=https://furlpay.com/signed-out
FURLPAY_OIDC_BACKCHANNEL_LOGOUT_URI=https://furlpay.com/auth/mobilecloud/backchannel
```

Invalid values fail startup. The same values are the RP configuration consumed
by `loadFurlPayConfig`.

## Login sequence

1. FurlPay generates `state`, `nonce` and a PKCE verifier, stores the transaction
   server-side, and redirects to `authorization_endpoint`.
2. MobileCloud authenticates the user (passkey, QR approval, or the password
   fallback) and, if no consent exists, asks for it.
3. MobileCloud redirects to the exact registered callback with `code` and
   `state`.
4. FurlPay verifies `state`, exchanges the code with the verifier, and verifies
   the ID token: RS256 signature against JWKS, `iss`, `aud`, `azp` when
   multi-audience, `exp`/`iat` with 60-second skew, and `nonce`.
5. FurlPay resolves the local account using `(iss, sub)` only. First-time users
   are `create_account`; an existing FurlPay account is `link_required` and needs
   explicit approval (see ACCOUNT-LINKING.md).
6. FurlPay creates its own session and applies its own authorization.

## Financial boundary

`integrations/furlpay/src/financial.ts` enumerates financial actions
(`payment.initiate`, `withdrawal.create`, `wallet.sign`, `agent.spend`, limit and
policy changes, card operations, KYC decisions) and refuses them unless the
session has a FurlPay passkey/WebAuthn step-up, bound to the device, completed
within five minutes. `ssoOnlyContext()` demonstrates the negative case, and the
integration test asserts it for payment, withdrawal, wallet signing and agent
spending.

MobileCloud does not expose financial scopes, and the ID token contains no
financial claims. Do not add any.

## Logout

* FurlPay logout ends only the FurlPay session.
* `GET /oauth/logout` (RP-initiated) ends the MobileCloud browser session and
  redirects only to a registered post-logout URI.
* `?all=1` revokes every MobileCloud session and token for the account.
* FurlPay-registered `backchannel_logout_uri` receives a signed `logout_token`
  best-effort; verify it against JWKS, `iss`, `aud`, `iat`/`exp` and the
  back-channel event claim.

## What FurlPay must do

1. Deploy the adapter (or port its logic) with the environment above.
2. Store login transactions (`state`, `nonce`, verifier, redirect URI) keyed to
   the browser session, single use and short lived.
3. Implement `resolveLocalAccount()` without email lookups.
4. Render an explicit link-approval screen for `link_required`.
5. Keep its financial step-up, transaction signing, risk, limits and compliance
   decisions unchanged. SSO must not weaken them.

## Status

The MobileCloud provider and the reference adapter are implemented and tested
(9 integration tests). FurlPay's own backend is **not** in this repository, so
the callback into FurlPay's production account/session store is a contract and a
deployable module, not a verified live integration. A staging round trip against
`auth.furlpay.com` is still required.
