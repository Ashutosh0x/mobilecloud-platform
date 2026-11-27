import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { openDb } from "./db.ts";
import {
  approveDeviceCode,
  createAuthorizationCode,
  denyDeviceCode,
  findDeviceCode,
  OAuthError,
  redeemAuthorizationCode,
  redeemDeviceCode,
  refreshTokens,
  startDeviceGrant,
} from "./oauth.ts";

function freshDb(): DatabaseSync {
  const file = join(mkdtempSync(join(tmpdir(), "mc-oauth-")), "t.db");
  const db = openDb(file);
  db.prepare(
    "INSERT INTO users (id, email, name, password_hash, role, plan, created_at) VALUES ('u1', 'a@b.co', 'A', '!', 'owner', 'community', ?)",
  ).run(Date.now());
  return db;
}

test("a device grant issues tokens only after the request is approved", () => {
  const db = freshDb();
  const grant = startDeviceGrant(db, { clientId: "mobilecloud-cli", verificationUri: "https://console.example.com/authorize" });
  assert.match(grant.userCode, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal(grant.interval, 5);
  assert.equal(grant.expiresIn, 900);

  assert.throws(
    () => redeemDeviceCode(db, { deviceCode: grant.deviceCode, clientId: "mobilecloud-cli" }),
    (error: unknown) => error instanceof OAuthError && error.code === "authorization_pending" && error.status === 428,
  );

  const row = findDeviceCode(db, grant.userCode);
  assert.ok(row);
  approveDeviceCode(db, row.id, "u1");

  const pair = redeemDeviceCode(db, { deviceCode: grant.deviceCode, clientId: "mobilecloud-cli" });
  assert.match(pair.accessToken, /^mc_[a-f0-9]{48}$/);
  assert.match(pair.refreshToken, /^mcr_[a-f0-9]{64}$/);
  assert.equal(pair.scope, "cli:full");
  assert.equal(pair.tokenType, "Bearer");

  // The device code is spent: a second poll cannot mint a second session.
  assert.throws(
    () => redeemDeviceCode(db, { deviceCode: grant.deviceCode, clientId: "mobilecloud-cli" }),
    (error: unknown) => error instanceof OAuthError && error.code === "invalid_grant",
  );
  db.close();
});

test("a denied device grant never issues tokens", () => {
  const db = freshDb();
  const grant = startDeviceGrant(db, { clientId: "mobilecloud-cli", verificationUri: "https://console.example.com/authorize" });
  const row = findDeviceCode(db, grant.userCode);
  assert.ok(row);
  denyDeviceCode(db, row.id);
  assert.throws(
    () => redeemDeviceCode(db, { deviceCode: grant.deviceCode, clientId: "mobilecloud-cli" }),
    (error: unknown) => error instanceof OAuthError && error.code === "access_denied" && error.status === 403,
  );
  db.close();
});

test("an unknown client is refused", () => {
  const db = freshDb();
  assert.throws(
    () => startDeviceGrant(db, { clientId: "somebody-else", verificationUri: "https://console.example.com/authorize" }),
    (error: unknown) => error instanceof OAuthError && error.code === "invalid_client",
  );
  db.close();
});

test("a refresh token rotates once and a replay revokes the family", () => {
  const db = freshDb();
  const grant = startDeviceGrant(db, { clientId: "mobilecloud-cli", verificationUri: "https://console.example.com/authorize" });
  const row = findDeviceCode(db, grant.userCode);
  assert.ok(row);
  approveDeviceCode(db, row.id, "u1");
  const first = redeemDeviceCode(db, { deviceCode: grant.deviceCode, clientId: "mobilecloud-cli" });

  const second = refreshTokens(db, first.refreshToken);
  assert.notEqual(second.accessToken, first.accessToken);
  assert.notEqual(second.refreshToken, first.refreshToken);

  // The old refresh token is spent. Presenting it again is a replay.
  assert.throws(
    () => refreshTokens(db, first.refreshToken),
    (error: unknown) => error instanceof OAuthError && error.status === 400,
  );
  // The whole family is revoked, so the new token cannot be used either.
  assert.throws(
    () => refreshTokens(db, second.refreshToken),
    (error: unknown) => error instanceof OAuthError && error.status === 400,
  );
  const live = db.prepare("SELECT COUNT(*) AS n FROM refresh_tokens WHERE revoked = 0").get() as { n: number };
  assert.equal(Number(live.n), 0);
  db.close();
});

test("an authorization code needs the matching PKCE verifier", () => {
  const db = freshDb();
  const verifier = "verifier-that-is-long-enough-for-pkce-0123456789";
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const code = createAuthorizationCode(db, {
    clientId: "mobilecloud-cli",
    userId: "u1",
    redirectUri: "http://127.0.0.1:48721/callback",
    scope: "cli:full",
    codeChallenge: challenge,
    codeChallengeMethod: "S256",
  });

  assert.throws(
    () =>
      redeemAuthorizationCode(db, {
        code,
        codeVerifier: "a-different-verifier-that-is-also-long-enough-0123456",
        clientId: "mobilecloud-cli",
        redirectUri: "http://127.0.0.1:48721/callback",
      }),
    (error: unknown) => error instanceof OAuthError && error.code === "invalid_grant",
  );

  const pair = redeemAuthorizationCode(db, {
    code,
    codeVerifier: verifier,
    clientId: "mobilecloud-cli",
    redirectUri: "http://127.0.0.1:48721/callback",
  });
  assert.match(pair.accessToken, /^mc_[a-f0-9]{48}$/);

  // The code is single use.
  assert.throws(
    () =>
      redeemAuthorizationCode(db, {
        code,
        codeVerifier: verifier,
        clientId: "mobilecloud-cli",
        redirectUri: "http://127.0.0.1:48721/callback",
      }),
    (error: unknown) => error instanceof OAuthError && error.code === "invalid_grant",
  );
  db.close();
});

test("an authorization code is bound to its redirect address", () => {
  const db = freshDb();
  const verifier = "verifier-that-is-long-enough-for-pkce-0123456789";
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const code = createAuthorizationCode(db, {
    clientId: "mobilecloud-cli",
    userId: "u1",
    redirectUri: "http://127.0.0.1:48721/callback",
    scope: "cli:full",
    codeChallenge: challenge,
    codeChallengeMethod: "S256",
  });
  assert.throws(
    () =>
      redeemAuthorizationCode(db, {
        code,
        codeVerifier: verifier,
        clientId: "mobilecloud-cli",
        redirectUri: "http://127.0.0.1:48722/callback",
      }),
    (error: unknown) => error instanceof OAuthError && error.code === "invalid_grant",
  );
  db.close();
});
