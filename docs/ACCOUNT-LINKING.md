# Account Linking

## Identity key

A federated identity is the pair **(issuer, subject)**. Email is display data,
never a key. `external_identity_links` enforces
`UNIQUE(provider, issuer, subject)`, and the FurlPay adapter's store enforces
the same rule in memory for its own account links.

## Rules

1. A new identity with no local account → `create_account`. FurlPay creates its
   own account.
2. An identity already linked → `linked`; FurlPay creates its session.
3. An identity that resolves to an existing FurlPay account by email → **never
   linked automatically**. The result is `link_required`; the user must already
   be signed in to that FurlPay account and explicitly approve.
4. Confirmation is a single-use, five-minute token bound to both the identity
   and the authenticated FurlPay account. A different account cannot confirm
   it, and a denied request creates no link.
5. One FurlPay account can hold one link; one identity can belong to one
   account. Conflicts fail closed.

## Unlinking and recovery

Unlinking removes only the link. The FurlPay account and its financial
authorization are untouched; MobileCloud credentials are untouched. A user who
loses a passkey uses the identity provider's recovery path (operator-assisted
or password fallback), then returns to FurlPay, which again requires an
authenticated local account to re-link. Email matching never bypasses this.

## Enumeration

Link, login and recovery endpoints return the same shape whether an account
exists or not. The FurlPay adapter's `resolve()` returns `link_required` only to
a browser that already holds an authenticated local session; an anonymous
visitor always receives `create_account`.

## Tests

`apps/web-dashboard/lib/server/furlpay.test.ts` covers first-time creation,
explicit approval, rejection of an unauthenticated second account, and the
rule that a matching email produces `link_required` with no stored link.
