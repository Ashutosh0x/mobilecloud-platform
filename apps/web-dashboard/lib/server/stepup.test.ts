import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { openDb } from "./db.ts";
import { createAuthenticator } from "./fixtures/webauthn.ts";
import { beginRegistration, finishRegistration } from "./passkey.ts";
import { createClient } from "./oauth.ts";
import { createStepUp, payloadHash, StepUpError, verifyStepUp } from "./stepup.ts";

const RP = "console.example.test";
const ORIGIN = `https://${RP}`;
const CONFIG = { rpId: RP, rpName: "MobileCloud", origin: ORIGIN };

function fresh(): DatabaseSync {
  const db = openDb(join(mkdtempSync(join(tmpdir(), "mc-stepup-")), "t.db"));
  db.prepare("INSERT INTO users (id, email, name, password_hash, role, plan, created_at) VALUES ('u1','a@b.co','A','!','owner','community',?)").run(Date.now());
  createClient(db, {
    clientId: "furlpay",
    name: "FurlPay",
    redirectUris: ["https://furlpay.com/callback"],
    scopes: ["openid"],
    public: false,
  });
  return db;
}

function register(db: DatabaseSync) {
  const authenticator = createAuthenticator(RP, ORIGIN);
  const options = beginRegistration(db, CONFIG, { userId: "u1", email: "a@b.co", displayName: "A" });
  const challenge = (options.publicKey as Record<string, unknown>).challenge as string;
  finishRegistration(db, CONFIG, { challengeId: options.challenge_id, credential: authenticator.registration(challenge) });
  return authenticator;
}

test("a passkey assertion bound to the payment payload issues a step-up token", () => {
  const db = fresh();
  const authenticator = register(db);
  const payload = { amount: 10, currency: "USD", to: "merchant-1" };
  const challenge = createStepUp(db, CONFIG, { userId: "u1", clientId: "furlpay", action: "payment.initiate", payload });
  assert.equal(challenge.publicKey.userVerification, "required");
  const assertion = authenticator.assertion(challenge.publicKey.challenge as string);
  const result = verifyStepUp(db, CONFIG, { challengeId: challenge.challengeId, credential: assertion, payload });
  assert.equal(result.action, "payment.initiate");
  assert.equal(result.userId, "u1");
  const claims = JSON.parse(Buffer.from(result.token.split(".")[1], "base64url").toString("utf8"));
  assert.equal(claims.typ, "stepup");
  assert.equal(claims.aud, "furlpay");
  assert.equal(claims.action, "payment.initiate");
  assert.equal(claims.payload_hash, payloadHash(payload));
  assert.ok(claims.exp > Math.floor(Date.now() / 1000));
  db.close();
});

test("a changed amount or recipient cannot reuse the authorization", () => {
  const db = fresh();
  const authenticator = register(db);
  const payload = { amount: 10, currency: "USD", to: "merchant-1" };
  const challenge = createStepUp(db, CONFIG, { userId: "u1", clientId: "furlpay", action: "payment.initiate", payload });
  const assertion = authenticator.assertion(challenge.publicKey.challenge as string);
  assert.throws(
    () => verifyStepUp(db, CONFIG, { challengeId: challenge.challengeId, credential: assertion, payload: { ...payload, amount: 1000 } }),
    (error: unknown) => error instanceof StepUpError && error.status === 400,
  );
  db.close();
});

test("a step-up challenge is single use and action restricted", () => {
  const db = fresh();
  const authenticator = register(db);
  const payload = { amount: 10, currency: "USD", to: "merchant-1" };
  const challenge = createStepUp(db, CONFIG, { userId: "u1", clientId: "furlpay", action: "payment.initiate", payload });
  const assertion = authenticator.assertion(challenge.publicKey.challenge as string);
  verifyStepUp(db, CONFIG, { challengeId: challenge.challengeId, credential: assertion, payload });
  assert.throws(
    () => verifyStepUp(db, CONFIG, { challengeId: challenge.challengeId, credential: assertion, payload }),
    (error: unknown) => error instanceof StepUpError && error.status === 409,
  );
  assert.throws(
    () => createStepUp(db, CONFIG, { userId: "u1", clientId: "furlpay", action: "admin.everything", payload }),
    (error: unknown) => error instanceof StepUpError && error.status === 400,
  );
  db.close();
});

test("an account without a passkey cannot start a step-up", () => {
  const db = fresh();
  assert.throws(
    () => createStepUp(db, CONFIG, { userId: "u1", clientId: "furlpay", action: "payment.initiate", payload: { amount: 1 } }),
    (error: unknown) => error instanceof StepUpError && error.status === 409,
  );
  db.close();
});
