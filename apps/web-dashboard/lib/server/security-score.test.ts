import assert from "node:assert/strict";
import test from "node:test";
import { computeSecurityScore, type SecurityScoreInput } from "../security-score.ts";

function base(overrides: Partial<SecurityScoreInput> = {}): SecurityScoreInput {
  return {
    firewallRules: [{ action: "deny", enabled: 1 }],
    firewallEvents: [{ action: "deny", at: Date.now() }],
    requestCount: 100,
    serverErrorCount: 0,
    activeSessions: 2,
    tokens: [{ expiresAt: Date.now() + 3600_000 }],
    protection: { required: true, unlocked: true },
    ...overrides,
  };
}

test("a fully healthy account scores 100", () => {
  const result = computeSecurityScore(base());
  assert.equal(result.score, 100);
  assert.equal(result.measuredWeight, 100);
  assert.ok(result.checks.every((check) => check.ok));
});

test("an account that fails every check scores 0", () => {
  const result = computeSecurityScore(base({
    firewallRules: [{ action: "log", enabled: 1 }],
    firewallEvents: [],
    serverErrorCount: 50,
    activeSessions: 12,
    tokens: [{ expiresAt: null }],
    protection: { required: false, unlocked: true },
  }));
  assert.equal(result.score, 0);
});

test("a check that cannot be measured is skipped and its weight is removed", () => {
  const result = computeSecurityScore(base({ requestCount: 0, serverErrorCount: 0, firewallEvents: [] }));
  const skipped = result.checks.filter((check) => check.skipped).map((check) => check.id);
  assert.deepEqual(skipped.sort(), ["error-rate", "rule-activity"]);
  // 25 + 20 + 10 + 15 = 70 points were measured, and all of them passed.
  assert.equal(result.measuredWeight, 70);
  assert.equal(result.score, 100);
});

test("a failing check costs only its own weight", () => {
  const result = computeSecurityScore(base({ protection: { required: false, unlocked: true } }));
  assert.equal(result.measuredWeight, 100);
  assert.equal(result.score, 85);
});

test("a perpetual API token is reported", () => {
  const result = computeSecurityScore(base({ tokens: [{ expiresAt: null }, { expiresAt: Date.now() + 1000 }] }));
  const check = result.checks.find((entry) => entry.id === "token-expiry");
  assert.equal(check?.ok, false);
  assert.match(check?.detail ?? "", /never expire/);
});

test("a disabled rule cannot enforce anything", () => {
  const result = computeSecurityScore(base({ firewallRules: [{ action: "deny", enabled: 0 }] }));
  const check = result.checks.find((entry) => entry.id === "firewall-coverage");
  assert.equal(check?.ok, false);
});

test("a high server error share fails the error rate check", () => {
  const result = computeSecurityScore(base({ requestCount: 200, serverErrorCount: 20 }));
  const check = result.checks.find((entry) => entry.id === "error-rate");
  assert.equal(check?.ok, false);
  assert.match(check?.detail ?? "", /10\.00% of 200 requests/);
});

test("the score never leaves the 0-100 band", () => {
  const many = computeSecurityScore(base({ activeSessions: 400, serverErrorCount: 1000, requestCount: 1 }));
  assert.ok(many.score >= 0 && many.score <= 100);
});
