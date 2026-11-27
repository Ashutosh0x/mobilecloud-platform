# Security Policy

## Reporting a vulnerability

Email **security@furlpay.com** with a description, reproduction steps, affected
component and commit. Do not open a public issue for an unfixed vulnerability.
We aim to acknowledge within 72 hours and to agree a disclosure timeline with
you. This is a small project; there is no paid bounty programme and none is
implied.

## Supported versions

Only the current `main` branch is supported. There are no published releases or
long-term-support branches.

## Scope

In scope: the identity provider (`apps/web-dashboard/lib/server`), session and
token handling, passkey/QR/device flows, CLI credential handling, SAML/SCIM
endpoints, the edge tunnel and shield crates, and the Android authentication
code.

Out of scope: FurlPay's financial backend (not in this repository), third-party
services, and findings that require a compromised device or root.

## What we already know

Known, documented limitations are in `docs/IDENTITY-SECURITY.md`,
`docs/PRODUCTION_READINESS.md` and the `Remaining blockers` list in
`docs/IDENTITY-OPERATIONS.md`. Notably: in-process `node:vm` execution is
disabled in production unless explicitly enabled; signing keys are not yet
KMS-backed; the Android QR approval screen is not routed end to end.

## Secrets

Never include real credentials, keystores, tokens or personal data in a report,
commit or issue. If you believe a secret was committed, report it immediately;
rotation is required because history can be copied. The repository ignores
`deploy/furlpay/.env` and keystore files, but ignore rules are not a guarantee.
