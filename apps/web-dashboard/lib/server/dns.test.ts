import assert from "node:assert/strict";
import test from "node:test";
import { checkCname, checkTxtToken, detectDnsProvider, extractApex, isApex, matchesProvider, resolveDns, type CaaRecord, type DnsResolver } from "./dns.ts";

/* ------------------------------ apex extraction ------------------------- */

test("extractApex handles simple and multi-part public suffixes", () => {
  const cases: [string, string][] = [
    ["app.example.com", "example.com"],
    ["www.example.com", "example.com"],
    ["example.com", "example.com"],
    ["auth.furlpay.com", "furlpay.com"],
    ["example.co.uk", "example.co.uk"],
    ["shop.example.co.uk", "example.co.uk"],
    ["www.example.com.au", "example.com.au"],
    ["a.b.example.com.au", "example.com.au"],
    ["api.example.co.jp", "example.co.jp"],
    ["deep.sub.example.org.za", "example.org.za"],
    ["EXAMPLE.COM.", "example.com"],
  ];
  for (const [input, expected] of cases) {
    assert.equal(extractApex(input), expected, input);
  }
});

test("isApex distinguishes the apex from a subdomain", () => {
  assert.equal(isApex("example.com"), true);
  assert.equal(isApex("example.co.uk"), true);
  assert.equal(isApex("app.example.com"), false);
  assert.equal(isApex("www.example.co.uk"), false);
});

/* --------------------------- provider matching -------------------------- */

test("provider keys match on a label boundary, not as a substring", () => {
  assert.equal(matchesProvider("ns1.cloudflare.com", "cloudflare.com"), true);
  assert.equal(matchesProvider("cloudflare.com", "cloudflare.com"), true);
  // The security-relevant case: an attacker-controlled name must not match.
  assert.equal(matchesProvider("notcloudflare.com.evil.io", "cloudflare.com"), false);
  assert.equal(matchesProvider("evil-cloudflare.com", "cloudflare.com"), false);
  assert.equal(matchesProvider("cloudflare.com.evil.io", "cloudflare.com"), false);
  // Bare label keys match a single label (or a hyphenated variant).
  assert.equal(matchesProvider("ns-1234.awsdns-56.org", "awsdns"), true);
  assert.equal(matchesProvider("ns1.digitalocean.com", "digitalocean"), true);
  // ...but a key embedded inside a longer label is not a match.
  assert.equal(matchesProvider("awsdnsx.evil.io", "awsdns"), false);
  assert.equal(matchesProvider("my-awsdns.evil.io", "awsdns"), false);
});

/* ------------------------------- resolver ------------------------------ */

type FakeMap = Partial<Record<"A" | "AAAA" | "CNAME" | "TXT" | "NS" | "CAA", string[] | string[][]>>;

function fake(map: FakeMap, fail: Partial<Record<string, string>> = {}): DnsResolver {
  const get = (type: string, name: string): string[] | string[][] => {
    const code = fail[type];
    if (code) throw Object.assign(new Error(`${type} ${name} failed`), { code });
    return (map[type as keyof FakeMap] ?? []) as string[] | string[][];
  };
  return {
    resolve4: async () => get("A", "x") as string[],
    resolve6: async () => get("AAAA", "x") as string[],
    resolveCname: async () => get("CNAME", "x") as string[],
    resolveNs: async () => get("NS", "x") as string[],
    resolveTxt: async () => get("TXT", "x") as string[][],
    resolveCaa: async () => get("CAA", "x") as unknown as CaaRecord[],
  };
}

test("resolveDns returns typed values and never throws on a lookup failure", async () => {
  const ok = await resolveDns<string>("example.com", "NS", fake({ NS: ["ns1.example.com"] }));
  assert.deepEqual(ok, { ok: true, values: ["ns1.example.com"] });

  const missing = await resolveDns<string>("nope.example.com", "CNAME", fake({}, { CNAME: "ENOTFOUND" }));
  assert.equal(missing.ok, false);
  assert.equal(missing.ok === false && missing.code, "ENOTFOUND");
});

/* ------------------------- provider detection -------------------------- */

test("detectDnsProvider reports Cloudflare with autoConfig and preserves nameservers", async () => {
  const result = await detectDnsProvider("app.example.com", fake({ NS: ["ns1.cloudflare.com", "ns2.cloudflare.com"] }));
  assert.equal(result.detected, true);
  assert.equal(result.provider?.id, "cloudflare");
  assert.equal(result.provider?.autoConfig, true);
  assert.deepEqual(result.nameservers, ["ns1.cloudflare.com", "ns2.cloudflare.com"]);
});

test("detectDnsProvider reports an unknown provider without inventing one", async () => {
  const result = await detectDnsProvider("example.com", fake({ NS: ["ns1.some-unknown-dns.example"] }));
  assert.equal(result.detected, false);
  assert.equal(result.provider, null);
  assert.equal(result.error, null);
});

test("detectDnsProvider surfaces a lookup failure instead of claiming success", async () => {
  const result = await detectDnsProvider("example.com", fake({}, { NS: "ETIMEOUT" }));
  assert.equal(result.detected, false);
  assert.equal(result.provider, null);
  assert.match(result.error ?? "", /timed out|failed/i);
});

/* ------------------------------ CNAME check ---------------------------- */

test("checkCname verifies an exact proxied target", async () => {
  const check = await checkCname("app.example.com", "abc123.cfargotunnel.com", fake({ CNAME: ["abc123.cfargotunnel.com"] }));
  assert.equal(check.status, "verified");
  assert.equal(check.found, "abc123.cfargotunnel.com");
});

test("checkCname reports a wrong target as misconfigured, not verified", async () => {
  const check = await checkCname("app.example.com", "abc123.cfargotunnel.com", fake({ CNAME: ["old-server.example.net"] }));
  assert.equal(check.status, "misconfigured");
  assert.equal(check.found, "old-server.example.net");
});

test("checkCname flags an A-record conflict", async () => {
  const check = await checkCname("app.example.com", "abc123.cfargotunnel.com", fake({ CNAME: [], A: ["192.0.2.1"] }));
  assert.equal(check.status, "misconfigured");
  assert.equal(check.conflict, "A");
  assert.equal(check.found, "192.0.2.1");
});

test("checkCname flags an AAAA-record conflict", async () => {
  const check = await checkCname("app.example.com", "abc123.cfargotunnel.com", fake({ CNAME: [], A: [], AAAA: ["2001:db8::1"] }));
  assert.equal(check.status, "misconfigured");
  assert.equal(check.conflict, "AAAA");
});

test("checkCname reports a genuinely absent record as missing", async () => {
  const check = await checkCname("app.example.com", "abc123.cfargotunnel.com", fake({}, { CNAME: "ENODATA", A: "ENODATA", AAAA: "ENODATA" }));
  assert.equal(check.status, "missing");
  assert.equal(check.found, null);
});

test("checkCname stays pending when the resolver itself fails", async () => {
  const check = await checkCname("app.example.com", "abc123.cfargotunnel.com", fake({}, { CNAME: "ETIMEOUT" }));
  assert.equal(check.status, "pending");
});

test("checkCname cannot verify without an expected target", async () => {
  const check = await checkCname("app.example.com", null, fake({ CNAME: ["abc123.cfargotunnel.com"] }));
  assert.equal(check.status, "pending");
});

/* ------------------------------ TXT check ------------------------------ */

test("checkTxtToken verifies the ownership token under the reserved name", async () => {
  const good = await checkTxtToken("app.example.com", "mc-verify=abc", fake({ TXT: [["mc-verify=abc"]] }));
  assert.equal(good.status, "verified");
  const bad = await checkTxtToken("app.example.com", "mc-verify=abc", fake({ TXT: [["mc-verify=other"]] }));
  assert.equal(bad.status, "misconfigured");
  const absent = await checkTxtToken("app.example.com", "mc-verify=abc", fake({}, { TXT: "ENODATA" }));
  assert.equal(absent.status, "missing");
});
