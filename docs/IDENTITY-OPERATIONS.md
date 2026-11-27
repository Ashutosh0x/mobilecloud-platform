# Identity Operations

## Environment

| Variable | Required | Purpose |
| :--- | :--- | :--- |
| `MOBILECLOUD_PUBLIC_ORIGIN` | production | HTTPS origin serving the console and identity endpoints |
| `MOBILECLOUD_ISSUER` | production (or defaults to origin) | Dedicated issuer, e.g. `https://auth.furlpay.com` |
| `MOBILECLOUD_DB` | yes | SQLite path; WAL mode |
| `MOBILECLOUD_BOOTSTRAP_EMAIL` / `_PASSWORD` | first boot | Local operator provisioning; password ≥12 chars, known defaults rejected |
| `MOBILECLOUD_KEY_PROVIDER` | no | `database` (default) or `kms`; `kms` is blocked in this build |
| `MOBILECLOUD_OIDC_PRIVATE_KEY` | no | External PKCS#8 RS256 key; disables DB rotation |
| `MOBILECLOUD_OIDC_ACCESS_TTL` | no | OIDC access token lifetime, default 900000 ms |
| `MOBILECLOUD_GEOIP` | no | Local GeoIP CSV for the risk engine |
| `FURLPAY_OIDC_*` | FurlPay | Client registration and RP configuration (see FURLPAY-INTEGRATION.md) |
| `NODE_ENV=production` | production | Enables configuration blocking and secure cookies |

`node --experimental-strip-types scripts/identity-check.mjs` prints every
check and exits non-zero on production blockers.

## Deployment and DNS

The proposed issuer is `https://auth.furlpay.com` (proposed, not assumed):

1. Point `auth.furlpay.com` at the identity deployment with an A/AAAA or CNAME
   record; certificate must cover the hostname (TLS 1.2+, HSTS).
2. Serve the Next.js app with the same routes; `next.config.mjs` rewrites
   `/.well-known`, `/oauth`, `/saml`, `/scim` to the API handler. No separate
   path prefix is required.
3. Keep the identity deployment logically separate from FurlPay's financial
   backend: separate process/service, separate database, no shared wallet keys.
4. Set `MOBILECLOUD_ISSUER` and `MOBILECLOUD_PUBLIC_ORIGIN` to the issuer origin
   (or keep the console on another origin only if the issuer serves the
   endpoints).
5. Local development: `http://127.0.0.1:3210`, loopback callbacks, and
   `FURLPAY_OIDC_ALLOW_INSECURE_LOOPBACK=1` for the adapter.

## Health

* `GET /api/health` — detailed platform health.
* `GET /api/health/live` — process liveness.
* `GET /api/health/ready` — database, issuer and signing key; returns 503 when
  any check fails. Use it for container/load-balancer readiness.

## Database and migrations

Schema changes are additive and run transactionally on open; `control_plane_migrations`
records versions. Existing users, credentials and sessions are preserved (the
`active` column defaults to 1). Back up before upgrading:

```bash
sqlite3 data/mobilecloud.db ".backup 'backup-$(date +%F).db'"
```

Restore by stopping the service, replacing the database file, and starting it;
migrations are idempotent. Test the restore on a copy first. WAL files must be
included in filesystem backups or the `.backup` command used.

## Monitoring and alerting

Auth events are in `auth_events`; the console exposes the audit trail and risk
signals. Alert on: repeated `auth.login.failed`, `auth.token.reuse_detected`,
`auth.user.deactivated`, signing-key rotation, readiness failures, 5xx on
`/oauth/token`, and back-channel delivery failures. Ship logs to the SIEM; do
not log token values.

## Supply chain

```bash
node scripts/security-check.mjs      # npm audit (+ cargo audit when installed)
node scripts/generate-sbom.mjs       # artifacts/sbom.cdx.json + sha256
```

Add both to CI. Pin dependencies, review lockfile changes, and rebuild the
image from a clean checkout.

## Incident response

1. Suspected signing-key compromise: rotate immediately (KEY-MANAGEMENT.md),
   remove the old key, revoke affected client tokens, notify FurlPay.
2. Refresh-token reuse alert: revoke the family, force re-authentication,
   inspect audit events for the account and IP.
3. Account takeover: disable the account (`users.active=0`), revoke sessions and
   tokens, require passkey re-enrollment through the operator recovery path.
4. Provider outage: FurlPay must fail closed for new logins; existing FurlPay
   sessions continue under its own policy.

## Readiness statement

**Development-ready:** yes — full provider, adapter and tests run locally.
**Staging-ready:** yes, with HTTPS issuer, FurlPay staging client and a real
FurlPay callback; KMS not required for staging.
**Production-ready:** **no** — KMS/HSM signing, a live FurlPay backend round
trip, Android OIDC migration, distributed rate limiting and operational
drills remain. See the final report for the complete blocker list.
