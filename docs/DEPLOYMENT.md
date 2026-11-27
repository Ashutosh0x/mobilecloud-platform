# Deploying the MobileCloud identity console

The console is the control plane that owns the platform: the web dashboard,
the Android and CLI sign-ins, passkeys, the audit trail, and the OIDC, SAML and
SCIM endpoints that FurlPay federates against. It runs as a private service —
it publishes no host ports and is reached only through a Cloudflare Tunnel.

## 1. What runs where

| Process | Port | Purpose |
|:---|:---|:---|
| `identity` | 3210 (internal) | Next.js console and the `/api` control plane |
| `identity` | 3211 (internal) | Realtime WebSocket gateway |
| `identity` | — | Webhook delivery worker |
| `cloudflared` | — | The only ingress; dials out to Cloudflare |

Nothing listens on a public interface. The tunnel terminates TLS at Cloudflare
and forwards to the container.

## 2. One-time setup

### 2.1 The tunnel

In the Cloudflare dashboard: **Zero Trust → Networks → Tunnels → Create tunnel**.

1. Name it `furlpay-identity` and choose the cloudflared connector.
2. Copy the connector token — it is the only credential the deployment needs.
3. Add the public hostname:

   | Hostname | Service |
   |:---|:---|
   | `auth.furlpay.com` (path `^/api/realtime$`) | `http://identity:3211` |
   | `auth.furlpay.com` (everything else) | `http://identity:3210` |

   The realtime gateway needs its own rule because a Next.js route handler
   cannot answer an HTTP `upgrade`, and the gateway is a separate process.

### 2.2 The repository

```bash
gh secret set CLOUDFLARE_TUNNEL_TOKEN --repo Ashutosh0x/mobilecloud-platform
gh secret set MOBILECLOUD_BOOTSTRAP_PASSWORD --repo Ashutosh0x/mobilecloud-platform
gh variable set PUBLIC_ORIGIN --body "https://auth.furlpay.com" --repo Ashutosh0x/mobilecloud-platform
```

`MOBILECLOUD_BOOTSTRAP_PASSWORD` provisions the operator account on first boot
only. There is no public signup, so the password is used once and can then be
removed from the secret store — the account keeps working.

## 3. Deploying

### 3.1 From CI

The **Deploy identity console** workflow builds the console image, publishes it
to GHCR and deploys it on a self-hosted runner labelled `mobilecloud`:

```bash
gh workflow run deploy.yml
```

The runner needs Docker with the compose plugin and this repository checked
out. The workflow refuses to run without `CLOUDFLARE_TUNNEL_TOKEN`.

### 3.2 From a machine

```bash
cd deploy/furlpay
cp .env.example .env
# edit .env: MOBILECLOUD_PUBLIC_ORIGIN, MOBILECLOUD_ISSUER,
#            MOBILECLOUD_BOOTSTRAP_PASSWORD, CLOUDFLARE_TUNNEL_TOKEN
docker compose up -d --build
docker compose ps
node ../../scripts/furlpay-preflight.mjs https://auth.furlpay.com
```

`.env` holds the tunnel token and the bootstrap password, so it is created with
`umask 077` and is listed in `.gitignore`.

## 4. Verifying

```bash
curl -fsS https://auth.furlpay.com/api/health        # {"status":"ok"}
curl -fsS https://auth.furlpay.com/api/health/ready  # 200 only when the
                                                     # configuration is safe
curl -fsS https://auth.furlpay.com/.well-known/openid-configuration
```

`/api/health/ready` is the one that matters: it fails closed with a list of
every production blocker (a non-HTTPS origin, a weak bootstrap password, an
unimplemented key provider) instead of serving traffic with an unsafe
configuration.

## 5. What the console refuses to do without configuration

| Check | Requirement |
|:---|:---|
| `public_origin` | `MOBILECLOUD_PUBLIC_ORIGIN` must be a bare HTTPS origin |
| `issuer` | `MOBILECLOUD_ISSUER` must be a bare HTTPS origin |
| `bootstrap_password` | at least 12 characters, not a known default |
| `key_provider` | `database` or `kms`; `kms` is blocked until a provider exists |
| `furlpay_*` | the FurlPay OIDC client id, HTTPS callback and HTTPS issuer |

## 6. Operating notes

- **Data** lives in the `identity-data` volume (`/app/data/mobilecloud.db`).
  Back it up; it holds the accounts, passkeys, sessions and the audit trail.
- **Logs** come from `docker compose logs identity`. The console logs no
  passwords and no tokens.
- **Rotating the tunnel token**: update the secret, then
  `docker compose up -d cloudflared` to restart the connector.
- **Adding a passkey** happens on `/security` in the console, or from the
  Android app. After that the login page offers *Login with MobileCloud* —
  the browser shows a QR code and the phone approves it.

## 7. Local run without a domain

The same console runs locally, which is what the repository's own tests use:

```bash
cd apps/web-dashboard
MOBILECLOUD_BOOTSTRAP_PASSWORD='a-password-of-at-least-12-characters' npm run dev
```

A local run needs no tunnel and no public origin, but a phone cannot reach it:
the Android app only speaks HTTPS to a console it trusts. For a phone on the
same network, use a tunnel to a hostname the device can resolve.
