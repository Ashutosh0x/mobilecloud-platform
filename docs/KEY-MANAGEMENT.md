# Key Management

## OIDC signing keys

RS256 keys are stored in `signing_keys` with a public JWK, `kid`, creation time
and `active` state:

* `1` — current signing key;
* `2` — retiring key, still published in JWKS so tokens issued before rotation
  verify;
* `0` — retired, not published.

Generate material on first use, or inject a PKCS#8 PEM with
`MOBILECLOUD_OIDC_PRIVATE_KEY` (literal `\n` accepted). Injected keys are
external: the database rotation endpoint refuses to rotate them.

## Rotation

```bash
curl -X POST https://auth.furlpay.com/api/admin/signing-keys/rotate \
  -b 'mc_session=…' -H 'x-mc-csrf: …' -H 'content-type: application/json' -d '{}'
```

The new key becomes `active=1`, the previous becomes `active=2`, and JWKS
immediately publishes both. Clients that cache JWKS must refetch on an unknown
`kid`; the FurlPay adapter does this automatically. Retire the old row after the
maximum ID-token lifetime plus the client cache window (at least 15 minutes,
24 hours is safer).

## SAML keys

The SAML IdP uses a self-signed X.509 certificate stored with `alg='SAML'` and
served in `/saml/metadata`. Rotating it requires redistributing metadata to
service providers; there is no SAML SLO.

## Production requirement

The database key is a **development/evaluation** provider. Production must use a
KMS/HSM-backed signer. The configuration check blocks
`MOBILECLOUD_KEY_PROVIDER=kms` with an explicit "not implemented" error rather
than silently continuing with the database. A KMS implementation must provide:

* `sign(header, payload)` returning RS256;
* public JWK publication for every key with an overlap window;
* `rotate()` and `retire(kid)`;
* an audit record per signature and rotation.

## Emergency rotation

1. Rotate immediately; do not wait for overlap if a key is suspected
   compromised.
2. Publish the new JWKS, then remove the compromised key from `signing_keys`
   (or set `active=0`).
3. Revoke all access/refresh tokens for affected clients; sessions remain valid
   for identity, so force re-authentication for high-value clients.
4. Notify relying parties and record the incident with the key ids and time
   window.
