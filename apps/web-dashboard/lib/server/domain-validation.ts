import { isIP } from "node:net";
import { isApex } from "./dns.ts";

/**
 * Server-side hostname validation.
 *
 * The client validates to give fast, inline feedback, but the server never
 * trusts it: every rule here is re-checked before a domain is stored, because
 * a hostname is used to build DNS lookups and (later) Cloudflare API calls.
 */

/** Total hostname length limit (RFC 1035 §2.3.4). */
export const MAX_HOST_LENGTH = 253;
/** Per-label length limit. */
export const MAX_LABEL_LENGTH = 63;

/** The single-label format the spec defines for each label. */
const LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/** Names that must never be accepted: internal, reserved or non-routable. */
const RESERVED_SUFFIXES = [".local", ".localhost", ".internal", ".test", ".invalid", ".example", ".home", ".lan", ".onion"];
const RESERVED_EXACT = new Set(["localhost", "local"]);

/** A pasted value often carries a scheme, a path or a port. Strip them. */
export function normalizeHost(raw: string): string {
  let value = raw.trim().toLowerCase();
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, ""); // scheme
  value = value.replace(/[/?#].*$/, ""); // path, query, fragment
  value = value.replace(/:\d+$/, ""); // port
  value = value.replace(/^\*\./, ""); // wildcard prefix
  value = value.replace(/\.+$/, "").replace(/^\.+/, ""); // stray dots
  return value;
}

export type HostnameCheck = { ok: true; host: string; apex: boolean } | { ok: false; error: string };

/**
 * Validates and normalizes a hostname. [existing] holds the hosts already
 * stored for the account, so a duplicate is rejected with a clear message.
 */
export function validateHostname(raw: string, existing: string[] = []): HostnameCheck {
  const host = normalizeHost(raw);
  if (!host) return { ok: false, error: "Enter a hostname like app.example.com." };
  if (host.length > MAX_HOST_LENGTH) return { ok: false, error: `A hostname cannot be longer than ${MAX_HOST_LENGTH} characters.` };
  if (isIP(host)) return { ok: false, error: "Enter a hostname, not an IP address." };
  if (host.includes(" ")) return { ok: false, error: "A hostname cannot contain spaces." };

  const labels = host.split(".");
  if (labels.length < 2) return { ok: false, error: "Enter a full hostname like app.example.com." };
  for (const label of labels) {
    if (!label) return { ok: false, error: "A hostname cannot contain an empty label." };
    if (label.length > MAX_LABEL_LENGTH) return { ok: false, error: `Each part must be ${MAX_LABEL_LENGTH} characters or fewer.` };
    if (!LABEL.test(label)) return { ok: false, error: "Use letters, digits and hyphens only, and do not start or end a part with a hyphen." };
  }

  // The public suffix (last label) must be alphabetic, so "app.123" is refused.
  if (!/^[a-z]{2,}$/.test(labels[labels.length - 1])) return { ok: false, error: "Enter a hostname with a valid public suffix, like .com." };

  if (RESERVED_EXACT.has(host) || RESERVED_SUFFIXES.some((suffix) => host === suffix.slice(1) || host.endsWith(suffix))) {
    return { ok: false, error: "That hostname is reserved and cannot be configured." };
  }

  const duplicate = existing.some((candidate) => normalizeHost(candidate) === host);
  if (duplicate) return { ok: false, error: `${host} is already configured on this account.` };

  return { ok: true, host, apex: isApex(host) };
}
