import assert from "node:assert/strict";
import test from "node:test";
import { deriveStatus, SSL_EXPIRING_WINDOW_MS, type DeriveStatusInput } from "../domain-status.ts";

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;

function input(overrides: Partial<DeriveStatusInput> = {}): DeriveStatusInput {
  return {
    dnsStatus: "verified",
    sslStatus: "active",
    healthStatus: "ok",
    sslExpiresAt: NOW + 90 * DAY,
    now: NOW,
    suspended: false,
    deleting: false,
    ...overrides,
  };
}

/** Every branch of the state machine, one row each. */
const CASES: { name: string; in: Partial<DeriveStatusInput>; want: string }[] = [
  // Administrative overrides beat every signal.
  { name: "deleting wins over a healthy domain", in: { deleting: true }, want: "deleting" },
  { name: "deleting wins even when suspended", in: { deleting: true, suspended: true }, want: "deleting" },
  { name: "suspended wins over verified DNS + active SSL", in: { suspended: true }, want: "suspended" },
  { name: "suspended beats a misconfigured CNAME", in: { suspended: true, dnsStatus: "misconfigured" }, want: "suspended" },

  // DNS gates everything else.
  { name: "misconfigured CNAME", in: { dnsStatus: "misconfigured" }, want: "dns_misconfigured" },
  { name: "pending DNS", in: { dnsStatus: "pending" }, want: "pending_dns" },
  { name: "missing DNS", in: { dnsStatus: "missing" }, want: "pending_dns" },
  { name: "misconfigured beats an expired certificate", in: { dnsStatus: "misconfigured", sslStatus: "expired" }, want: "dns_misconfigured" },

  // Certificate lifecycle once DNS is verified.
  { name: "no certificate yet", in: { sslStatus: "none" }, want: "ssl_provisioning" },
  { name: "certificate issuing", in: { sslStatus: "provisioning" }, want: "ssl_provisioning" },
  { name: "renewing without a valid certificate", in: { sslStatus: "renewing", sslExpiresAt: NOW - DAY }, want: "ssl_provisioning" },
  { name: "renewing with a valid certificate stays active", in: { sslStatus: "renewing" }, want: "active" },
  { name: "renewing with a valid but soon-expiring certificate", in: { sslStatus: "renewing", sslExpiresAt: NOW + 10 * DAY }, want: "ssl_expiring" },
  { name: "expired certificate", in: { sslStatus: "expired" }, want: "ssl_expired" },
  { name: "failed issuance is not reported as success", in: { sslStatus: "failed" }, want: "ssl_expired" },
  { name: "active certificate with a long life", in: { sslStatus: "active", sslExpiresAt: NOW + 90 * DAY }, want: "active" },
  { name: "active certificate inside the expiry window", in: { sslStatus: "active", sslExpiresAt: NOW + 29 * DAY }, want: "ssl_expiring" },
  { name: "active certificate exactly at the window edge stays active", in: { sslStatus: "active", sslExpiresAt: NOW + SSL_EXPIRING_WINDOW_MS }, want: "active" },
  { name: "active certificate that just expired", in: { sslStatus: "active", sslExpiresAt: NOW - 1 }, want: "ssl_expired" },
  { name: "active status without an expiry cannot claim success", in: { sslStatus: "active", sslExpiresAt: null }, want: "ssl_expired" },

  // Health is an independent signal and must never change the lifecycle.
  { name: "origin down does not demote a live domain", in: { healthStatus: "down" }, want: "active" },
  { name: "degraded origin keeps the lifecycle phase", in: { healthStatus: "degraded" }, want: "active" },
  { name: "unknown health keeps the lifecycle phase", in: { healthStatus: "unknown" }, want: "active" },
];

test("deriveStatus covers every branch of the lifecycle", () => {
  for (const scenario of CASES) {
    assert.equal(deriveStatus(input(scenario.in)), scenario.want, scenario.name);
  }
});

test("deriveStatus is pure and does not mutate its input", () => {
  const frozen = Object.freeze(input());
  assert.equal(deriveStatus(frozen), "active");
  assert.equal(deriveStatus(frozen), "active");
  assert.deepEqual(frozen, input());
});
