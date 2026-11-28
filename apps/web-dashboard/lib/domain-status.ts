import type { DnsSignal, DomainStatus, HealthSignal, SslSignal } from "./types";

/**
 * Pure lifecycle derivation for a domain.
 *
 * The UI never invents a status: it is always computed from the three
 * independent signals (DNS, SSL, Health) plus the two administrative flags.
 * Keeping this a pure function means the web client, the server and the tests
 * all agree on exactly one answer — and a status change can be unit-tested
 * without a database, a socket or a DNS lookup.
 *
 * Precedence (highest first):
 *   1. an administrative override (`deleting`, `suspended`) wins outright;
 *   2. DNS is the gate — nothing else can be trusted until the CNAME verifies;
 *   3. once DNS is verified, the certificate lifecycle decides the phase.
 *
 * Health is deliberately *not* folded into the lifecycle: a live domain whose
 * origin is down is still "active" with a `down` health signal, so the two are
 * surfaced as separate tiles rather than one merged colour.
 */

/** A certificate inside this window is reported as expiring, not healthy. */
export const SSL_EXPIRING_WINDOW_MS = 30 * 86_400_000;

export type DeriveStatusInput = {
  dnsStatus: DnsSignal;
  sslStatus: SslSignal;
  healthStatus: HealthSignal;
  sslExpiresAt: number | null;
  now: number;
  suspended: boolean;
  deleting: boolean;
};

export function deriveStatus(input: DeriveStatusInput): DomainStatus {
  // Destructured narrowly: `healthStatus` is part of the contract but does not
  // collapse into the lifecycle (see the note above).
  const { dnsStatus, sslStatus, sslExpiresAt, now, suspended, deleting } = input;

  if (deleting) return "deleting";
  if (suspended) return "suspended";

  if (dnsStatus === "misconfigured") return "dns_misconfigured";
  if (dnsStatus !== "verified") return "pending_dns";

  // DNS is verified; the certificate lifecycle now decides the phase.
  const certValid = sslExpiresAt !== null && sslExpiresAt > now;
  const withinExpiryWindow = certValid && sslExpiresAt - now < SSL_EXPIRING_WINDOW_MS;

  switch (sslStatus) {
    case "expired":
    case "failed":
      // A failed issuance has no lifecycle status of its own; both terminal
      // certificate failures surface as `ssl_expired` while the SSL tile keeps
      // the precise reason ("expired" vs "failed").
      return "ssl_expired";
    case "renewing":
      // A renewal that already has a valid certificate is still serving.
      if (!certValid) return "ssl_provisioning";
      return withinExpiryWindow ? "ssl_expiring" : "active";
    case "none":
    case "provisioning":
      return "ssl_provisioning";
    case "active":
      // Never report success on a certificate we cannot see is still valid: an
      // `active` signal with a past (or absent) expiry is an expired cert.
      if (!certValid) return "ssl_expired";
      return withinExpiryWindow ? "ssl_expiring" : "active";
    default:
      return "active";
  }
}
