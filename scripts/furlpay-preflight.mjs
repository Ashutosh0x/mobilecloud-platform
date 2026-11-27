#!/usr/bin/env node
/**
 * Verifies a deployed FurlPay identity endpoint without credentials.
 *
 *   node scripts/furlpay-preflight.mjs https://auth.furlpay.com
 *
 * Checks TLS reachability, discovery issuer, JWKS keys, readiness, HSTS and
 * the expected OIDC capabilities. It is read-only and safe to run in CI after
 * a deploy.
 */

const base = (process.argv[2] ?? process.env.MOBILECLOUD_ISSUER ?? "").replace(/\/+$/, "");
if (!/^https:\/\//.test(base)) {
  console.error("Usage: node scripts/furlpay-preflight.mjs https://auth.furlpay.com");
  process.exit(2);
}

let failed = 0;
function report(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
  if (!ok) failed += 1;
}

async function get(path) {
  const response = await fetch(`${base}${path}`, { redirect: "error", signal: AbortSignal.timeout(10_000) });
  const text = await response.text();
  return { response, text };
}

try {
  const health = await get("/api/health/ready");
  const healthBody = JSON.parse(health.text);
  report("readiness", health.response.ok && healthBody.status === "ready", `${health.response.status}`);

  const discovery = await get("/.well-known/openid-configuration");
  const doc = JSON.parse(discovery.text);
  report("discovery", discovery.response.ok, `${discovery.response.status}`);
  report("issuer", doc.issuer === base, doc.issuer);
  report("authorization_endpoint", doc.authorization_endpoint === `${base}/oauth/authorize`, doc.authorization_endpoint);
  report("token_endpoint", doc.token_endpoint === `${base}/oauth/token`, doc.token_endpoint);
  report("jwks_uri", doc.jwks_uri === `${base}/.well-known/jwks.json`, doc.jwks_uri);
  report("pkce_s256", (doc.code_challenge_methods_supported ?? []).includes("S256"));
  report("rs256", (doc.id_token_signing_alg_values_supported ?? []).includes("RS256"));
  report("introspection", typeof doc.introspection_endpoint === "string");

  const jwks = JSON.parse((await get("/.well-known/jwks.json")).text);
  const keys = Array.isArray(jwks.keys) ? jwks.keys : [];
  report("jwks_keys", keys.length > 0 && keys.every((key) => key.kty === "RSA" && key.kid), `${keys.length} key(s)`);

  const hsts = discovery.response.headers.get("strict-transport-security");
  report("hsts", Boolean(hsts), hsts ?? "missing (Cloudflare can add it)");
} catch (error) {
  console.error(`FAIL  network: ${error instanceof Error ? error.message : "unknown error"}`);
  failed += 1;
}

console.log(failed ? `\n${failed} check(s) failed.` : "\nAll identity checks passed.");
process.exit(failed ? 1 : 0);
