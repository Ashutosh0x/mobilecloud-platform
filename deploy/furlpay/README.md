# FurlPay identity deployment

```bash
cp .env.example .env
# edit .env: origin, bootstrap password, FurlPay OIDC client, tunnel token
docker compose up -d --build
docker compose ps
node ../../scripts/furlpay-preflight.mjs https://auth.furlpay.com
```

- The identity container publishes no host ports; `cloudflared` is the only
  ingress and dials out.
- Configure the tunnel's public hostnames as described in
  [docs/FURLAY-DEPLOYMENT.md](../../docs/FURLPAY-DEPLOYMENT.md).
- Data lives in the `identity-data` volume. Back it up.
- For a certificate-based tunnel, use `cloudflared/config.yml` instead of the
  token command.

The full domain, DNS, TLS, security and cost notes are in the deployment guide.
