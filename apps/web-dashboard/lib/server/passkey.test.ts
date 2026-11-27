import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { openDb } from "./db.ts";
import { createAuthenticator } from "./fixtures/webauthn.ts";
import { beginAuthentication, beginRegistration, finishAuthentication, finishRegistration, PasskeyError, verifyAssertion } from "./passkey.ts";

const RP_ID = "console.example.com";
const ORIGIN = `https://${RP_ID}`;
const CONFIG = { rpId: RP_ID, rpName: "MobileCloud", origin: ORIGIN };

function freshDb(): DatabaseSync {
  const file = join(mkdtempSync(join(tmpdir(), "mc-passkey-")), "t.db");
  const db = openDb(file);
  db.prepare(
    "INSERT INTO users (id, email, name, password_hash, role, plan, created_at) VALUES ('u1', 'a@b.co', 'A', '!', 'owner', 'community', ?)",
  ).run(Date.now());
  return db;
}

function register(db: DatabaseSync, challengeB64: string, authenticator = createAuthenticator(RP_ID, ORIGIN)) {
  const credential = authenticator.registration(challengeB64);
  const result = finishRegistration(db, CONFIG, { challengeId: challenge, credential });
  return { result, authenticator };
}

let challenge = "";

test("a registration ceremony stores the credential and returns its id", () => {
  const db = freshDb();
  const options = beginRegistration(db, CONFIG, { userId: "u1", email: "a@b.co", displayName: "A" });
  assert.equal(typeof options.challenge_id, "string");
  const publicKey = options.publicKey as Record<string, unknown>;
  const challengeB64 = publicKey.challenge as string;
  const authenticator = createAuthenticator(RP_ID, ORIGIN);
  const result = finishRegistration(db, CONFIG, {
    challengeId: options.challenge_id,
    credential: authenticator.registration(challengeB64),
  });
  assert.equal(result.userId, "u1");
  assert.equal(result.credentialId, authenticator.credentialId);
  assert.equal(result.backedUp, false);
  const stored = db.prepare("SELECT user_id, sign_count FROM credentials WHERE id = ?").get(result.credentialId) as {
    user_id: string;
    sign_count: number;
  };
  assert.equal(stored.user_id, "u1");
  assert.equal(stored.sign_count, 0);
  db.close();
});

test("a challenge is single use", () => {
  const db = freshDb();
  const options = beginRegistration(db, CONFIG, { userId: "u1", email: "a@b.co", displayName: "A" });
  const authenticator = createAuthenticator(RP_ID, ORIGIN);
  const challengeB64 = (options.publicKey as Record<string, unknown>).challenge as string;
  finishRegistration(db, CONFIG, { challengeId: options.challenge_id, credential: authenticator.registration(challengeB64) });
  assert.throws(
    () => finishRegistration(db, CONFIG, { challengeId: options.challenge_id, credential: authenticator.registration(challengeB64) }),
    (error: unknown) => error instanceof PasskeyError && error.status === 400,
  );
  db.close();
});

test("an assertion proves the account and moves the counter", () => {
  const db = freshDb();
  const authenticator = createAuthenticator(RP_ID, ORIGIN);
  const options = beginRegistration(db, CONFIG, { userId: "u1", email: "a@b.co", displayName: "A" });
  const challengeB64 = (options.publicKey as Record<string, unknown>).challenge as string;
  finishRegistration(db, CONFIG, { challengeId: options.challenge_id, credential: authenticator.registration(challengeB64) });

  const login = beginAuthentication(db, CONFIG, { email: "a@b.co" });
  const loginChallenge = (login.publicKey as Record<string, unknown>).challenge as string;
  const result = finishAuthentication(db, CONFIG, { challengeId: login.challenge_id, credential: authenticator.assertion(loginChallenge) });
  assert.equal(result.userId, "u1");
  assert.equal(result.credentialId, authenticator.credentialId);
  assert.equal(result.signCount, 1);
  assert.equal(result.userVerified, true);
  const stored = db.prepare("SELECT sign_count FROM credentials WHERE id = ?").get(authenticator.credentialId) as { sign_count: number };
  assert.equal(stored.sign_count, 1);
  db.close();
});

test("a tampered signature is refused", () => {
  const db = freshDb();
  const authenticator = createAuthenticator(RP_ID, ORIGIN);
  const options = beginRegistration(db, CONFIG, { userId: "u1", email: "a@b.co", displayName: "A" });
  const challengeB64 = (options.publicKey as Record<string, unknown>).challenge as string;
  finishRegistration(db, CONFIG, { challengeId: options.challenge_id, credential: authenticator.registration(challengeB64) });
  const login = beginAuthentication(db, CONFIG, { email: "a@b.co" });
  const loginChallenge = (login.publicKey as Record<string, unknown>).challenge as string;
  const assertion = authenticator.assertion(loginChallenge);
  const raw = Buffer.from(assertion.response.signature as string, "base64url");
  raw[raw.length - 1] ^= 0xff;
  assertion.response.signature = raw.toString("base64url");
  assert.throws(
    () => finishAuthentication(db, CONFIG, { challengeId: login.challenge_id, credential: assertion }),
    (error: unknown) => error instanceof PasskeyError && error.status === 401,
  );
  db.close();
});

test("an assertion for a different challenge is refused", () => {
  const db = freshDb();
  const authenticator = createAuthenticator(RP_ID, ORIGIN);
  const options = beginRegistration(db, CONFIG, { userId: "u1", email: "a@b.co", displayName: "A" });
  const challengeB64 = (options.publicKey as Record<string, unknown>).challenge as string;
  finishRegistration(db, CONFIG, { challengeId: options.challenge_id, credential: authenticator.registration(challengeB64) });
  const login = beginAuthentication(db, CONFIG, { email: "a@b.co" });
  const assertion = authenticator.assertion("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
  assert.throws(
    () => finishAuthentication(db, CONFIG, { challengeId: login.challenge_id, credential: assertion }),
    (error: unknown) => error instanceof PasskeyError && error.status === 400,
  );
  db.close();
});

test("an assertion from another origin is refused", () => {
  const db = freshDb();
  const authenticator = createAuthenticator(RP_ID, ORIGIN);
  const options = beginRegistration(db, CONFIG, { userId: "u1", email: "a@b.co", displayName: "A" });
  const challengeB64 = (options.publicKey as Record<string, unknown>).challenge as string;
  finishRegistration(db, CONFIG, { challengeId: options.challenge_id, credential: authenticator.registration(challengeB64) });
  const login = beginAuthentication(db, CONFIG, { email: "a@b.co" });
  const loginChallenge = (login.publicKey as Record<string, unknown>).challenge as string;
  const assertion = authenticator.assertion(loginChallenge);
  // The client data claims a different origin than the relying party.
  const clientData = JSON.parse(assertion.response.clientDataJSON) as Record<string, unknown>;
  clientData.origin = "https://evil.example.net";
  assertion.response.clientDataJSON = JSON.stringify(clientData);
  assert.throws(
    () => finishAuthentication(db, CONFIG, { challengeId: login.challenge_id, credential: assertion }),
    (error: unknown) => error instanceof PasskeyError && error.status === 400,
  );
  db.close();
});

test("a counter that moves backwards is refused", () => {
  const db = freshDb();
  const authenticator = createAuthenticator(RP_ID, ORIGIN);
  const options = beginRegistration(db, CONFIG, { userId: "u1", email: "a@b.co", displayName: "A" });
  const challengeB64 = (options.publicKey as Record<string, unknown>).challenge as string;
  finishRegistration(db, CONFIG, { challengeId: options.challenge_id, credential: authenticator.registration(challengeB64) });
  const first = beginAuthentication(db, CONFIG, { email: "a@b.co" });
  const firstChallenge = (first.publicKey as Record<string, unknown>).challenge as string;
  finishAuthentication(db, CONFIG, { challengeId: first.challenge_id, credential: authenticator.assertion(firstChallenge) });
  // The stored counter is now ahead of the authenticator's, which is what a
  // cloned authenticator looks like.
  db.prepare("UPDATE credentials SET sign_count = 5 WHERE id = ?").run(authenticator.credentialId);
  const second = beginAuthentication(db, CONFIG, { email: "a@b.co" });
  const secondChallenge = (second.publicKey as Record<string, unknown>).challenge as string;
  assert.throws(
    () => finishAuthentication(db, CONFIG, { challengeId: second.challenge_id, credential: authenticator.assertion(secondChallenge) }),
    (error: unknown) => error instanceof PasskeyError && error.status === 401,
  );
  db.close();
});

test("a standalone assertion resolves the account it belongs to", () => {
  const db = freshDb();
  const authenticator = createAuthenticator(RP_ID, ORIGIN);
  const options = beginRegistration(db, CONFIG, { userId: "u1", email: "a@b.co", displayName: "A" });
  const challengeB64 = (options.publicKey as Record<string, unknown>).challenge as string;
  finishRegistration(db, CONFIG, { challengeId: options.challenge_id, credential: authenticator.registration(challengeB64) });
  // The QR login flow signs the challenge the browser generated, so the
  // challenge travels as hex and arrives as base64url in the client data.
  const hex = Buffer.from(challengeB64, "base64url").toString("hex");
  const assertion = authenticator.assertion(challengeB64);
  const result = verifyAssertion(db, CONFIG, { credential: assertion, expectedChallengeHex: hex });
  assert.equal(result.userId, "u1");
  assert.equal(result.credentialId, authenticator.credentialId);
  db.close();
});

test("client data may arrive base64url encoded, as browsers and Credential Manager send it", () => {
  const db = freshDb();
  const authenticator = createAuthenticator(RP_ID, ORIGIN);

  const registration = beginRegistration(db, CONFIG, { userId: "u1", email: "a@b.co", displayName: "A" });
  const registrationChallenge = (registration.publicKey as Record<string, unknown>).challenge as string;
  const created = authenticator.registration(registrationChallenge);
  const encodedRegistration = {
    ...created,
    response: {
      ...created.response,
      clientDataJSON: Buffer.from(created.response.clientDataJSON, "utf8").toString("base64url"),
    },
  };
  const stored = finishRegistration(db, CONFIG, { challengeId: registration.challenge_id, credential: encodedRegistration });
  assert.equal(stored.credentialId, authenticator.credentialId);

  const login = beginAuthentication(db, CONFIG, { email: "a@b.co" });
  const loginChallenge = (login.publicKey as Record<string, unknown>).challenge as string;
  const assertion = authenticator.assertion(loginChallenge);
  const encodedAssertion = {
    ...assertion,
    response: {
      ...assertion.response,
      clientDataJSON: Buffer.from(assertion.response.clientDataJSON, "utf8").toString("base64url"),
    },
  };
  const signed = finishAuthentication(db, CONFIG, { challengeId: login.challenge_id, credential: encodedAssertion });
  assert.equal(signed.userId, "u1");
  db.close();
});
