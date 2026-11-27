# FurlPay Deployment (furlpay.com)

This is the deployable edge for the FurlPay identity platform: Namecheap keeps
the registration, Cloudflare owns DNS/TLS/DDoS, Cloudflare Tunnel exposes the
local or VPS-hosted control plane without opening a port.

> **Scope.** This document covers the identity/control plane, its container
> image, DNS, TLS, tunnel, health and PWA. It does **not** claim a payments
> engine, KYC service, card vault or billing system — those are not implemented
> in this repository and must not be presented as live.

## 1. Namecheap → Cloudflare

1. Cloudflare dashboard → **Add a site** → `furlpay.com` → Free plan.
2. Cloudflare shows two nameservers (`*.ns.cloudflare.com`).
3. Namecheap → Domain List → **Manage** `furlpay.com` → Nameservers →
   **Custom DNS** → paste both → save.
4. Wait for propagation; Cloudflare shows **Active**.

Do not create tunnel records at Namecheap. Once Cloudflare is authoritative,
the tunnel CNAMEs live in Cloudflare.

## 2. DNS records

| Type | Name | Target | Proxy |
| :--- | :--- | :--- | :--- |
| CNAME | `auth` | `<TUNNEL-ID>.cfargotunnel.com` | Proxied |
| CNAME | `@` / `app` / `www` | Your FurlPay application (not this repo) | Proxied |
| TXT | `_dmarc` | `v=DMARC1; p=reject; rua=mailto:admin@furlpay.com` | — |
| MX/TXT | mail provider | per provider | — |

`node scripts/cloudflare-dns.mjs` creates the `auth` CNAME idempotently and
refuses to overwrite a non-CNAME record:

```bash
export CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ZONE_ID=... CLOUDFLARE_TUNNEL_ID=...
node scripts/cloudflare-dns.mjs            # dry run
node scripts/cloudflare-dns.mjs --apply
```

The token needs **Zone:DNS:Edit** for `furlpay.com` only.

## 3. Tunnel

Zero Trust → Networks → Tunnels → **Create a tunnel** (Cloudflared) → copy the
token. Public hostnames:

| Hostname | Path | Service |
| :--- | :--- | :--- |
| `auth.furlpay.com` | `^/api/realtime$` | `http://identity:3211` |
| `auth.furlpay.com` | all | `http://identity:3210` |

No inbound firewall rule or static IP is required: `cloudflared` dials out.
For a certificate-based tunnel instead of a token, use
`deploy/furlpay/cloudflared/config.yml`.

## 4. Run

```bash
cd deploy/furlpay
cp .env.example .env       # fill origin, bootstrap password, FurlPay client, tunnel token
docker compose up -d --build
docker compose ps
```

No ports are published. `identity` runs as UID 10001 with `cap_drop: ALL`,
`no-new-privileges`, a read-only app tree except the `/app/data` volume, and a
readiness healthcheck. SQLite lives in the `identity-data` volume.

Set `MOBILECLOUD_BOOTSTRAP_PASSWORD` once, create the owner account, then remove
the variable from `.env` and recreate the container. The app refuses known
defaults in production.

## 5. Verify

```bash
node scripts/furlpay-preflight.mjs https://auth.furlpay.com
```

Checks readiness, discovery issuer/endpoints, PKCE/R256 capabilities, JWKS keys
and HSTS. Run after every deploy.

## 6. PWA

The console ships a manifest, generated icons, an offline page and a service
worker. API, OAuth, SAML, SCIM, login, approve and authorize routes are
network-only and never cached. Install from the browser menu or the in-app
prompt; the app runs standalone with theme colours and safe-area insets.

## 7. Security baseline

- HTTPS only; Cloudflare Universal SSL plus HSTS from the app when the origin is
  HTTPS.
- Admin APIs require an owner session, CSRF and a recent login.
- Tunnel hides origin IP; keep the host firewall closed.
- Secrets stay in `.env` (not committed); rotate the tunnel token and OIDC keys
  per `docs/KEY-MANAGEMENT.md`.
- Back up the `identity-data` volume (SQLite `.backup` or volume snapshot).

## 8. Cost (estimates, not invoices)

| Component | Tool | Monthly |
| :--- | :--- | ---: |
| Domain | Namecheap | ~$1 |
| DNS/CDN/TLS/DDoS | Cloudflare Free | $0 |
| Tunnel | Cloudflare Tunnel | $0 |
| Compute | Own machine or $5–20 VPS | $0–20 |
| Software | This repository (open source) | $0 |

Cloudflare free-tier limits and terms apply. The report's "$0–22/month" is a
planning estimate, not a guarantee.

## 9. Not deployed here

FurlPay's application (`furlpay.com`, `app.furlpay.com`), payments, wallets,
KYC, billing, email/SMS and push credentials are outside this repository. The
identity service is ready to federate them; they remain FurlPay's systems and
their financial authorization is not delegated to MobileCloud.
