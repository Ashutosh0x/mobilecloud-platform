#!/usr/bin/env node
/**
 * Idempotently points the FurlPay identity hostnames at a Cloudflare Tunnel.
 *
 * Prerequisites:
 *   CLOUDFLARE_API_TOKEN  (Zone:DNS:Edit for furlpay.com)
 *   CLOUDFLARE_ZONE_ID
 *   CLOUDFLARE_TUNNEL_ID
 *
 * Usage:
 *   node scripts/cloudflare-dns.mjs                 # dry run, prints planned changes
 *   node scripts/cloudflare-dns.mjs --apply         # create/update CNAMEs
 *   FURLPAY_HOSTS=auth,dashboard node scripts/cloudflare-dns.mjs --apply
 *
 * Only CNAME records are touched. Existing proxied CNAMEs with the right target
 * are left alone; an A/AAAA/CNAME with a different target is refused rather
 * than overwritten silently.
 */

const api = "https://api.cloudflare.com/client/v4";
const token = process.env.CLOUDFLARE_API_TOKEN?.trim();
const zoneId = process.env.CLOUDFLARE_ZONE_ID?.trim();
const tunnelId = process.env.CLOUDFLARE_TUNNEL_ID?.trim();
const domain = (process.env.FURLPAY_DOMAIN ?? "furlpay.com").trim();
const apply = process.argv.includes("--apply");
const hosts = (process.env.FURLPAY_HOSTS ?? "auth")
  .split(",")
  .map((host) => host.trim())
  .filter(Boolean);

if (!token || !zoneId || !tunnelId) {
  console.error("Set CLOUDFLARE_API_TOKEN, CLOUDFLARE_ZONE_ID and CLOUDFLARE_TUNNEL_ID.");
  process.exit(2);
}
if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) {
  console.error("FURLPAY_DOMAIN is not a valid domain.");
  process.exit(2);
}

const target = `${tunnelId}.cfargotunnel.com`;

async function call(path, init = {}) {
  const response = await fetch(`${api}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.success === false) {
    const detail = (body.errors ?? []).map((error) => error.message).join("; ") || `HTTP ${response.status}`;
    throw new Error(detail);
  }
  return body.result;
}

const zone = await call(`/zones/${zoneId}`);
if (zone.name !== domain) {
  console.error(`Zone ${zoneId} is ${zone.name}, not ${domain}.`);
  process.exit(2);
}
console.log(`zone ${zone.name} (${zone.status}); tunnel target ${target}`);
console.log(apply ? "mode: apply" : "mode: dry-run (pass --apply to write)");

let failures = 0;
for (const host of hosts) {
  const name = host === "@" ? domain : `${host}.${domain}`;
  try {
    const records = await call(`/zones/${zoneId}/dns_records?name=${encodeURIComponent(name)}`);
    const existing = records[0];
    if (existing) {
      if (existing.type !== "CNAME") {
        console.error(`BLOCK ${name}: existing ${existing.type} record; refusing to overwrite`);
        failures += 1;
        continue;
      }
      if (existing.content === target && existing.proxied === true) {
        console.log(`ok    ${name} → ${target} (proxied)`);
        continue;
      }
      console.log(`${apply ? "update" : "plan"} ${name}: ${existing.content} → ${target}, proxied`);
      if (apply) {
        await call(`/zones/${zoneId}/dns_records/${existing.id}`, {
          method: "PUT",
          body: JSON.stringify({ type: "CNAME", name, content: target, proxied: true, ttl: 1 }),
        });
      }
    } else {
      console.log(`${apply ? "create" : "plan"} ${name} → ${target}, proxied`);
      if (apply) {
        await call(`/zones/${zoneId}/dns_records`, {
          method: "POST",
          body: JSON.stringify({ type: "CNAME", name, content: target, proxied: true, ttl: 1 }),
        });
      }
    }
  } catch (error) {
    console.error(`FAIL  ${name}: ${error instanceof Error ? error.message : "unknown error"}`);
    failures += 1;
  }
}
process.exit(failures ? 1 : 0);
