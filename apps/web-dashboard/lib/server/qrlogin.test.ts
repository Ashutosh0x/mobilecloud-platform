import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { openDb } from "./db.ts";
import { approveQrLogin, createQrLogin, decodeLoginTicket, denyQrLogin, QrLoginError, qrLoginStatus, scanQrLogin } from "./qrlogin.ts";

const CONFIG = { rpId: "console.example.com", rpName: "MobileCloud", origin: "https://console.example.com" };

function freshDb(): DatabaseSync {
  const file = join(mkdtempSync(join(tmpdir(), "mc-qrlogin-")), "t.db");
  const db = openDb(file);
  db.prepare(
    "INSERT INTO users (id, email, name, password_hash, role, plan, created_at) VALUES ('u1', 'a@b.co', 'A', '!', 'owner', 'community', ?)",
  ).run(Date.now());
  return db;
}

test("the QR payload carries the challenge, the code and the expiry", () => {
  const db = freshDb();
  const created = createQrLogin(db, CONFIG, { browserInfo: "Chrome on Windows" });
  const ticket = decodeLoginTicket(created.qrPayload);
  assert.ok(ticket);
  assert.equal(ticket.api, CONFIG.origin);
  assert.match(ticket.challenge, /^[0-9a-f]{64}$/);
  assert.equal(ticket.code, created.verificationCode);
  assert.equal(ticket.browser, "Chrome on Windows");
  assert.ok(ticket.expires > Date.now());
  db.close();
});

test("a foreign payload is refused", () => {
  assert.equal(decodeLoginTicket("https://example.com/"), null);
  assert.equal(decodeLoginTicket("mobilecloud://pair?v=1"), null);
  assert.equal(decodeLoginTicket("mobilecloud://login?v=1&api=https://x.test&challenge=zz&code=AAAAAA&expires=1"), null);
});

test("a browser that polls with another secret cannot read the request", () => {
  const db = freshDb();
  const created = createQrLogin(db, CONFIG, {});
  assert.throws(
    () => qrLoginStatus(db, created.challengeId, "not-the-poll-secret"),
    (error: unknown) => error instanceof QrLoginError && error.status === 403,
  );
  db.close();
});

test("the phone approves the request the browser started", () => {
  const db = freshDb();
  const created = createQrLogin(db, CONFIG, { browserInfo: "Chrome on Windows" });
  const ticket = decodeLoginTicket(created.qrPayload);
  assert.ok(ticket);

  assert.equal(qrLoginStatus(db, created.challengeId, created.pollSecret).status, "waiting");
  scanQrLogin(db, created.challengeId, { deviceName: "Pixel 9 Pro", devicePlatform: "android" });
  assert.equal(qrLoginStatus(db, created.challengeId, created.pollSecret).status, "scanned");

  approveQrLogin(db, {
    challengeId: created.challengeId,
    challenge: ticket.challenge,
    verificationCode: created.verificationCode,
    userId: "u1",
    credentialId: "cred-1",
  });
  assert.equal(qrLoginStatus(db, created.challengeId, created.pollSecret).status, "approved");
  db.close();
});

test("a wrong verification code is refused", () => {
  const db = freshDb();
  const created = createQrLogin(db, CONFIG, {});
  const ticket = decodeLoginTicket(created.qrPayload);
  assert.ok(ticket);
  assert.throws(
    () =>
      approveQrLogin(db, {
        challengeId: created.challengeId,
        challenge: ticket.challenge,
        verificationCode: "ZZZZZZ",
        userId: "u1",
      }),
    (error: unknown) => error instanceof QrLoginError && error.status === 400,
  );
  db.close();
});

test("a challenge for a different request is refused", () => {
  const db = freshDb();
  const created = createQrLogin(db, CONFIG, {});
  assert.throws(
    () =>
      approveQrLogin(db, {
        challengeId: created.challengeId,
        challenge: "f".repeat(64),
        verificationCode: created.verificationCode,
        userId: "u1",
      }),
    (error: unknown) => error instanceof QrLoginError && error.status === 400,
  );
  db.close();
});

test("a request can only be approved once", () => {
  const db = freshDb();
  const created = createQrLogin(db, CONFIG, {});
  const ticket = decodeLoginTicket(created.qrPayload);
  assert.ok(ticket);
  approveQrLogin(db, {
    challengeId: created.challengeId,
    challenge: ticket.challenge,
    verificationCode: created.verificationCode,
    userId: "u1",
  });
  assert.throws(
    () =>
      approveQrLogin(db, {
        challengeId: created.challengeId,
        challenge: ticket.challenge,
        verificationCode: created.verificationCode,
        userId: "u1",
      }),
    (error: unknown) => error instanceof QrLoginError && error.status === 409,
  );
  db.close();
});

test("a denied request never becomes approved", () => {
  const db = freshDb();
  const created = createQrLogin(db, CONFIG, {});
  denyQrLogin(db, created.challengeId);
  assert.equal(qrLoginStatus(db, created.challengeId, created.pollSecret).status, "denied");
  db.close();
});
