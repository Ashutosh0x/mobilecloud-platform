import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { assessLoginRisk, listAuthEvents, logAuthEvent } from "./audit.ts";
import { openDb } from "./db.ts";

function freshDb(): DatabaseSync {
  const file = join(mkdtempSync(join(tmpdir(), "mc-audit-")), "t.db");
  const db = openDb(file);
  db.prepare(
    "INSERT INTO users (id, email, name, password_hash, role, plan, created_at) VALUES ('u1', 'a@b.co', 'A', '!', 'owner', 'community', ?)",
  ).run(Date.now());
  return db;
}

const berlin = { country: "DE", lat: 52.52, lon: 13.4 };
const sanFrancisco = { country: "US", lat: 37.77, lon: -122.42 };

test("a first sign-in from a known place is allowed", () => {
  const db = freshDb();
  logAuthEvent(db, {
    userId: "u1",
    eventType: "auth.login.passkey",
    clientType: "android",
    credentialType: "passkey",
    ipAddress: "203.0.113.9",
    geo: berlin,
    outcome: "success",
  });
  const risk = assessLoginRisk(db, {
    userId: "u1",
    ipAddress: "203.0.113.9",
    userAgent: "MobileCloud",
    geo: berlin,
    credentialType: "passkey",
  });
  assert.equal(risk.action, "allow");
  assert.equal(risk.score, 0);
  assert.deepEqual(risk.factors, []);
  db.close();
});

test("a run of failed attempts is treated as a brute force", () => {
  const db = freshDb();
  for (let index = 0; index < 5; index += 1) {
    logAuthEvent(db, {
      userId: "u1",
      eventType: "auth.login.failed",
      credentialType: "password",
      outcome: "failure",
      failureReason: "invalid_credentials",
    });
  }
  const risk = assessLoginRisk(db, {
    userId: "u1",
    ipAddress: "203.0.113.9",
    userAgent: "MobileCloud",
    geo: null,
    credentialType: "passkey",
  });
  assert.ok(risk.factors.some((factor) => factor.kind === "brute_force"));
  assert.ok(risk.score >= 0.4);
  db.close();
});

test("a sign-in from a new country and a new address is worth more than a passkey alone", () => {
  const db = freshDb();
  logAuthEvent(db, {
    userId: "u1",
    eventType: "auth.login.passkey",
    credentialType: "passkey",
    ipAddress: "203.0.113.9",
    geo: berlin,
    outcome: "success",
    // Two days ago: a new place, but a believable one to travel from. The
    // intercontinental-in-an-hour case is the next test.
    createdAt: Date.now() - 48 * 3_600_000,
  });
  const risk = assessLoginRisk(db, {
    userId: "u1",
    ipAddress: "198.51.100.4",
    userAgent: "MobileCloud",
    geo: sanFrancisco,
    credentialType: "passkey",
  });
  const kinds = risk.factors.map((factor) => factor.kind);
  assert.ok(kinds.includes("new_ip_address"));
  assert.ok(kinds.includes("new_geo_location"));
  assert.equal(risk.action, "allow_with_notification");
  assert.equal(risk.riskScore, "medium");
  db.close();
});

test("an impossible journey between two logins is refused", () => {
  const db = freshDb();
  logAuthEvent(db, {
    userId: "u1",
    eventType: "auth.login.passkey",
    credentialType: "passkey",
    ipAddress: "203.0.113.9",
    geo: berlin,
    outcome: "success",
    // An hour ago, on the other side of the world.
    createdAt: Date.now() - 3_600_000,
  } as never);
  const risk = assessLoginRisk(db, {
    userId: "u1",
    ipAddress: "198.51.100.4",
    userAgent: "MobileCloud",
    geo: sanFrancisco,
    credentialType: "passkey",
  });
  assert.ok(risk.factors.some((factor) => factor.kind === "impossible_travel"));
  assert.equal(risk.action, "block");
  assert.equal(risk.riskScore, "critical");
  db.close();
});

test("a password is worth a risk factor of its own", () => {
  const db = freshDb();
  logAuthEvent(db, {
    userId: "u1",
    eventType: "auth.login.password",
    credentialType: "password",
    ipAddress: "203.0.113.9",
    geo: berlin,
    outcome: "success",
  });
  const risk = assessLoginRisk(db, {
    userId: "u1",
    ipAddress: "203.0.113.9",
    userAgent: "Chrome",
    geo: berlin,
    credentialType: "password",
  });
  assert.ok(risk.factors.some((factor) => factor.kind === "password_auth"));
  assert.equal(risk.action, "allow");
  db.close();
});

test("the audit trail keeps what happened", () => {
  const db = freshDb();
  logAuthEvent(db, {
    userId: "u1",
    eventType: "auth.login.passkey",
    clientType: "android",
    credentialType: "passkey",
    ipAddress: "203.0.113.9",
    geo: berlin,
    outcome: "success",
  });
  logAuthEvent(db, {
    userId: "u1",
    eventType: "auth.login.failed",
    credentialType: "password",
    outcome: "failure",
    failureReason: "invalid_credentials",
  });
  const events = listAuthEvents(db, "u1");
  assert.equal(events.length, 2);
  assert.equal(events[0].eventType, "auth.login.failed");
  assert.equal(events[0].outcome, "failure");
  assert.equal(events[1].eventType, "auth.login.passkey");
  assert.equal(events[1].ipAddress, "203.0.113.9");
  db.close();
});
