# FurlPay — MobileCloud OIDC relying party

This directory is the integration FurlPay deploys. MobileCloud is the identity
provider; FurlPay remains the authority for every financial decision.

## What this module does

| Concern | Implementation |
| :--- | :--- |
| Configuration | `src/config.ts` — issuer, client id, optional secret, exact callback, scopes, insecure-loopback switch for local development only |
| Discovery and JWKS | `src/oidc-client.ts` — cached, same-origin enforced, SSRF-checked, refetches on an unknown `kid` |
| Login | `src/service.ts` — `beginLogin()` creates state/nonce/PKCE; `completeLogin()` verifies state, exchanges the code, verifies the ID token and resolves the local account |
| Account linking | `src/linking.ts` — identity key is `(issuer, subject)`; an existing FurlPay account must approve the link explicitly; email never merges accounts |
| Session | `src/session.ts` — FurlPay creates and owns its own session; IdP tokens are not the session |
| Financial boundary | `src/financial.ts` — every wallet/payment/transfer/signing action requires a FurlPay passkey step-up bound to the device; an SSO session cannot satisfy it |

## Flow

1. `beginLogin()` returns a MobileCloud authorization URL and a transaction
   `{ state, nonce, codeVerifier, redirectUri }`. Persist it server-side keyed
   by the browser session.
2. The browser visits the URL and signs in with MobileCloud (passkey, QR, or
   password fallback).
3. MobileCloud redirects to `FURLPAY_OIDC_REDIRECT_URI` with `code` and `state`.
4. The callback calls `completeLogin({ code, state, transaction, resolveLocalAccount })`.
   `resolveLocalAccount` returns the FurlPay account the user is already signed
   in to, or `null`; it must not query by email.
5. Outcomes:
   * `resolution.status === "linked"` → a FurlPay session is returned.
   * `"link_required"` → show "Link this MobileCloud identity to your FurlPay
     account?" and call `linking.beginExplicitLink(...)` then
     `confirmExplicitLink(token, { decision: "approve", authenticatedAccountId })`.
   * `"create_account"` → FurlPay creates its own account, then explicitly links.

No ID token, access token or refresh token is stored in a FurlPay session, and
none is accepted as proof of intent to move money.

## Environment

```bash
FURLPAY_OIDC_ISSUER=https://auth.furlpay.com
FURLPAY_OIDC_CLIENT_ID=furlpay
FURLPAY_OIDC_CLIENT_SECRET=...            # only for a confidential client
FURLPAY_OIDC_REDIRECT_URI=https://furlpay.com/auth/mobilecloud/callback
FURLPAY_OIDC_SCOPES="openid profile email"
FURLPAY_OIDC_POST_LOGOUT_REDIRECT_URI=https://furlpay.com/signed-out
FURLPAY_OIDC_ALLOW_INSECURE_LOOPBACK=0    # 1 only for local tests
```

## Tests

The integration is exercised from the MobileCloud app suite against the real
OIDC provider handlers (see `apps/web-dashboard/lib/server/furlpay.test.ts`):
first login, explicit linking, refusal of email-based merging, wrong
state/nonce/issuer/audience/signature, expired and replayed codes, logout, and
the rule that an SSO session cannot authorize a payment.

```bash
cd apps/web-dashboard && npm test
```

## Deployment

This module has no runtime dependency on MobileCloud's database or process. It
is plain TypeScript using `node:crypto` and `fetch`, so FurlPay can vendor it,
publish it internally, or run it beside its existing identity service. It
requires outbound HTTPS to the issuer only. No wallet keys, signing keys or
financial credentials are shared with MobileCloud.
