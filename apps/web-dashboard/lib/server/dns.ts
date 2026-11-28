import { Resolver } from "node:dns/promises";
import type { DnsSignal } from "../types.ts";

/**
 * DNS discovery for the domain lifecycle.
 *
 * Every function here is total: a lookup that fails returns a typed failure
 * rather than throwing, because the caller renders a verdict and must never
 * crash a request or a background poll on a timeout. Lookups are also
 * injectable, so the provider/CNAME logic is unit-tested without the network.
 */

/** Hard ceiling on a single lookup so a wedged resolver cannot hang a request. */
export const DNS_TIMEOUT_MS = 3_000;

export type DnsRecordType = "A" | "AAAA" | "CNAME" | "TXT" | "NS" | "CAA";

/** A CAA record as returned by `node:dns`; `critical` is the RFC flags octet. */
export type CaaRecord = { critical: number; issue?: string; issuewild?: string; iodef?: string };

/** The slice of `node:dns` this module needs, so tests can supply a fake. */
export type DnsResolver = {
  resolve4(name: string): Promise<string[]>;
  resolve6(name: string): Promise<string[]>;
  resolveCname(name: string): Promise<string[]>;
  resolveTxt(name: string): Promise<string[][]>;
  resolveNs(name: string): Promise<string[]>;
  resolveCaa(name: string): Promise<CaaRecord[]>;
};

export type Resolved<T> = { ok: true; values: T[] } | { ok: false; code: string; error: string };

/**
 * A curated multi-label public suffix list.
 *
 * A naive `split(".").slice(-2)` would call `co.uk` the apex of
 * `example.co.uk`. This bundles the registries that actually appear on the
 * platform instead of pulling in a full public-suffix dependency; anything
 * outside the list falls back to the last two labels.
 */
const MULTI_LABEL_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "net.uk", "sch.uk",
  "co.jp", "ne.jp", "or.jp", "ac.jp", "go.jp",
  "com.au", "net.au", "org.au", "edu.au", "gov.au", "id.au",
  "co.nz", "net.nz", "org.nz", "govt.nz",
  "co.in", "net.in", "org.in", "gen.in", "firm.in", "ind.in",
  "co.za", "org.za", "net.za",
  "com.br", "net.br", "org.br",
  "com.mx", "com.ar", "com.tr", "com.cn", "com.hk", "com.sg", "com.tw", "com.my",
  "co.kr", "or.kr", "co.id", "co.il", "com.ph", "com.vn",
]);

/** The registrable domain (apex) of a hostname, for NS lookups. */
export function extractApex(host: string): string {
  const clean = host.trim().toLowerCase().replace(/\.$/, "");
  const labels = clean.split(".").filter(Boolean);
  if (labels.length <= 2) return clean;
  const lastTwo = labels.slice(-2).join(".");
  return labels.slice(MULTI_LABEL_SUFFIXES.has(lastTwo) ? -3 : -2).join(".");
}

/** True when [host] is the registrable apex itself (not a subdomain of it). */
export function isApex(host: string): boolean {
  const clean = host.trim().toLowerCase().replace(/\.$/, "");
  return clean === extractApex(clean);
}

/** Nodes dns errors carry a `code`; anything else is reported as `EUNKNOWN`. */
function errorCode(error: unknown): { code: string; error: string } {
  const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : "";
  const message = error instanceof Error ? error.message : "DNS lookup failed";
  return { code: code || "EUNKNOWN", error: message };
}

function isMissing(code: string): boolean {
  return code === "ENOTFOUND" || code === "ENODATA" || code === "ENODOMAIN";
}

/** Resolves one record type inside a 3 s budget. Never throws. */
export async function resolveDns<T>(
  name: string,
  type: DnsRecordType,
  resolver: DnsResolver = defaultResolver,
  timeoutMs = DNS_TIMEOUT_MS,
): Promise<Resolved<T>> {
  const query = async (): Promise<T[]> => {
    switch (type) {
      case "A": return (await resolver.resolve4(name)) as unknown as T[];
      case "AAAA": return (await resolver.resolve6(name)) as unknown as T[];
      case "CNAME": return (await resolver.resolveCname(name)) as unknown as T[];
      case "NS": return (await resolver.resolveNs(name)) as unknown as T[];
      case "CAA": return (await resolver.resolveCaa(name)) as unknown as T[];
      case "TXT": return (await resolver.resolveTxt(name)).map((chunks) => chunks.join("")) as unknown as T[];
      default: return [];
    }
  };
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const values = await Promise.race([
      query(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error(`DNS ${type} lookup timed out`), { code: "ETIMEOUT" })), timeoutMs);
      }),
    ]);
    return { ok: true, values };
  } catch (error) {
    return { ok: false, ...errorCode(error) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** A resolver with the system defaults; exported so callers can share one. */
export const defaultResolver: DnsResolver = new Resolver({ timeout: DNS_TIMEOUT_MS, tries: 1 });

export type DnsProvider = { id: string; name: string; logo: string; autoConfig: boolean };

/**
 * Provider table (spec §9.2). Domain-shaped keys are matched against the whole
 * NS hostname on a label boundary; bare label keys ("awsdns") match a single
 * label prefix. A substring match is deliberately *not* used — `notcloudflare.com.evil.io`
 * is not Cloudflare.
 */
export const DNS_PROVIDERS: Record<string, DnsProvider> = {
  "cloudflare.com": { id: "cloudflare", name: "Cloudflare", logo: "☁️", autoConfig: true },
  awsdns: { id: "route53", name: "Amazon Route 53", logo: "🔶", autoConfig: false },
  google: { id: "gcp", name: "Google Cloud DNS", logo: "🔵", autoConfig: false },
  "nsone.net": { id: "ns1", name: "NS1", logo: "🟣", autoConfig: false },
  digitalocean: { id: "digitalocean", name: "DigitalOcean", logo: "💧", autoConfig: false },
  "dnsimple.com": { id: "dnsimple", name: "DNSimple", logo: "🔗", autoConfig: false },
  "registrar-servers.com": { id: "namecheap", name: "Namecheap", logo: "🏷️", autoConfig: false },
  "domaincontrol.com": { id: "godaddy", name: "GoDaddy", logo: "🟢", autoConfig: false },
};

/** Label-boundary match: a domain key must be the whole name or a dotted suffix. */
export function matchesProvider(nameserver: string, pattern: string): boolean {
  const ns = nameserver.trim().toLowerCase().replace(/\.$/, "");
  const key = pattern.toLowerCase();
  if (!ns) return false;
  if (key.includes(".")) return ns === key || ns.endsWith(`.${key}`);
  return ns.split(".").some((label) => label === key || label.startsWith(`${key}-`));
}

export type ProviderDetection = {
  detected: boolean;
  provider: DnsProvider | null;
  nameservers: string[];
  error: string | null;
};

/** Detects the authoritative DNS provider from the apex's NS records. */
export async function detectDnsProvider(domain: string, resolver: DnsResolver = defaultResolver): Promise<ProviderDetection> {
  const apex = extractApex(domain);
  const result = await resolveDns<string>(apex, "NS", resolver);
  if (!result.ok) {
    return { detected: false, provider: null, nameservers: [], error: isMissing(result.code) ? "No NS records were found for this domain." : result.error };
  }
  const nameservers = result.values.map((ns) => ns.trim().toLowerCase().replace(/\.$/, "")).filter(Boolean);
  for (const ns of nameservers) {
    for (const [pattern, provider] of Object.entries(DNS_PROVIDERS)) {
      if (matchesProvider(ns, pattern)) return { detected: true, provider, nameservers, error: null };
    }
  }
  return { detected: false, provider: null, nameservers, error: null };
}

export type CnameCheck = {
  status: DnsSignal;
  found: string | null;
  expected: string | null;
  conflict?: "A" | "AAAA";
};

function normalizeRecord(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

/**
 * Compares the CNAME at [host] with [expectedTarget].
 *
 * `verified` only when the record is present *and* points at the target.
 * A different CNAME is `misconfigured` (found is reported back for the
 * diagnostic card); an A/AAAA record where a CNAME belongs is a
 * `misconfigured` conflict, since the two cannot coexist.
 */
export async function checkCname(
  host: string,
  expectedTarget: string | null,
  resolver: DnsResolver = defaultResolver,
): Promise<CnameCheck> {
  const expected = expectedTarget ? normalizeRecord(expectedTarget) : null;
  if (!expected) return { status: "pending", found: null, expected: null };

  const cname = await resolveDns<string>(host, "CNAME", resolver);
  if (cname.ok && cname.values.length) {
    const found = normalizeRecord(cname.values[0]);
    return { status: found === expected ? "verified" : "misconfigured", found, expected };
  }
  if (!cname.ok && !isMissing(cname.code)) {
    // The resolver itself failed (timeout/SERVFAIL): we do not know, so we do
    // not claim the record is missing.
    return { status: "pending", found: null, expected };
  }

  const a = await resolveDns<string>(host, "A", resolver);
  if (a.ok && a.values.length) return { status: "misconfigured", found: a.values[0], expected, conflict: "A" };
  const aaaa = await resolveDns<string>(host, "AAAA", resolver);
  if (aaaa.ok && aaaa.values.length) return { status: "misconfigured", found: aaaa.values[0], expected, conflict: "AAAA" };

  return { status: "missing", found: null, expected };
}

/** The DNS record a verification token is published under. */
export function txtRecordName(host: string): string {
  return `_mobilecloud-verify.${host.trim().toLowerCase().replace(/\.$/, "")}`;
}

/** True when the published TXT record carries the expected verification token. */
export async function checkTxtToken(
  host: string,
  token: string,
  resolver: DnsResolver = defaultResolver,
): Promise<{ status: DnsSignal; found: string[] }> {
  const name = txtRecordName(host);
  const result = await resolveDns<string>(name, "TXT", resolver);
  if (!result.ok) return { status: isMissing(result.code) ? "missing" : "pending", found: [] };
  const values = result.values.map((value) => value.trim());
  return { status: values.includes(token) ? "verified" : "misconfigured", found: values };
}
