import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { handle } from "./api.ts";
import { openDb } from "./db.ts";
import { decodeLoginTicket } from "./qrlogin.ts";

/**
 * End-to-end coverage for the unified authentication surface.
 *
 * The tests drive the same HTTP handlers the console and the CLI use, so a
 * regression in scope, CSRF, replay handling or session scoping fails here
 * rather than on a phone.
 */

const root = mkdtempSync(join(tmpdir(), "mc-auth-"));
process.env.MOBILECLOUD_DB = join(root, "auth.db");
process.env.MOBILECLOUD_DATA_ROOT = root;
process.env.MOBILECLOUD_BOOTSTRAP_EMAIL = "operator@example.test";
process.env.MOBILECLOUD_BOOTSTRAP_PASSWORD = "test-operator-password";
process.env.MOBILECLOUD_PUBLIC_ORIGIN = "https://console.example.test";

const origin = process.env.MOBILECLOUD_PUBLIC_ORIGIN;
const credentials = { email: process.env.MOBILECLOUD_BOOTSTRAP_EMAIL, password: process.env.MOBILECLOUD_BOOTSTRAP_PASSWORD };
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

function request(path: string, method = "GET", body?: object, headers?: HeadersInit) {
  const all = new Headers(headers);
  if (body) all.set("content-type", "application/json");
  // The route receives path segments only; the query string stays on the URL.
  const [pathname] = path.split("?");
  return handle(new Request(`${origin}/api/${path}`, { method, headers: all, body: body && JSON.stringify(body) }), pathname.split("/"));
}

type Browser = { cookie: string; "x-mc-csrf": string; userId: string };

async function login(): Promise<Browser> {
  const response = await request("auth/login", "POST", credentials, { origin });
  assert.equal(response.status, 200);
  const cookie = response.headers.getSetCookie().find((value) => value.startsWith("mc_session="))!.split(";")[0];
  const me = await (await request("auth/me", "GET", undefined, { cookie })).json();
  return { cookie, "x-mc-csrf": me.csrfToken as string, userId: me.user.id as string };
}

/** Completes a Device Authorization Grant and returns the issued token pair. */
async function authorizeCli(browser: Browser) {
  const started = await request("oauth/device/code", "POST", { client_id: "mobilecloud-cli", scope: "cli:full" });
  assert.equal(started.status, 200);
  const grant = await started.json();
  const verified = await request("oauth/device/verify", "POST", { user_code: grant.user_code }, browser);
  assert.equal(verified.status, 200);
  const { id } = await verified.json();
  const approved = await request(`oauth/device/${id}/approve`, "POST", { device_name: "CLI on test" }, browser);
  assert.equal(approved.status, 200);
  const tokens = await request("oauth/token", "POST", {
    grant_type: DEVICE_GRANT,
    device_code: grant.device_code,
    client_id: "mobilecloud-cli",
  });
  assert.equal(tokens.status, 200);
  return tokens.json();
}

test("the device grant issues a scoped CLI token once, after approval", async () => {
  const browser = await login();
  const started = await request("oauth/device/code", "POST", { client_id: "mobilecloud-cli", scope: "cli:full" });
  const grant = await started.json();
  assert.match(grant.user_code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.match(grant.device_code, /^[a-f0-9]{64}$/);
  assert.equal(grant.verification_uri, "https://console.example.test/activate");
  assert.equal(grant.verification_uri_complete, `${grant.verification_uri}?code=${encodeURIComponent(grant.user_code)}`);

  const pending = await request("oauth/token", "POST", {
    grant_type: DEVICE_GRANT,
    device_code: grant.device_code,
    client_id: "mobilecloud-cli",
  });
  assert.equal(pending.status, 428);
  assert.equal((await pending.json()).error, "authorization_pending");

  // A code is only a code: approving it needs the account.
  assert.equal((await request("oauth/device/verify", "POST", { user_code: grant.user_code })).status, 401);
  const verified = await (await request("oauth/device/verify", "POST", { user_code: grant.user_code }, browser)).json();
  // A cookie session without the CSRF echo cannot approve.
  assert.equal((await request(`oauth/device/${verified.id}/approve`, "POST", {}, { cookie: browser.cookie })).status, 403);
  assert.equal((await request(`oauth/device/${verified.id}/approve`, "POST", {}, browser)).status, 200);

  const issued = await request("oauth/token", "POST", {
    grant_type: DEVICE_GRANT,
    device_code: grant.device_code,
    client_id: "mobilecloud-cli",
  });
  assert.equal(issued.status, 200);
  const tokens = await issued.json();
  assert.match(tokens.access_token, /^mc_[a-f0-9]{48}$/);
  assert.match(tokens.refresh_token, /^mcr_[a-f0-9]{64}$/);
  assert.equal(tokens.token_type, "Bearer");
  assert.equal(tokens.scope, "cli:full");

  // The same device code cannot mint a second session.
  assert.equal(
    (await request("oauth/token", "POST", {
      grant_type: DEVICE_GRANT,
      device_code: grant.device_code,
      client_id: "mobilecloud-cli",
    })).status,
    400,
  );

  const me = await (await request("auth/me", "GET", undefined, { authorization: `Bearer ${tokens.access_token}` })).json();
  assert.equal(me.user.id, browser.userId);
  assert.equal(me.token.scope, "cli:full");
  assert.equal(me.token.client_type, "cli");
  assert.ok(me.token.expires_at > Date.now());
});

test("refresh tokens rotate, and a replay revokes the whole family", async () => {
  const browser = await login();
  const tokens = await authorizeCli(browser);
  const rotated = await request("oauth/token", "POST", {
    grant_type: "refresh_token",
    refresh_token: tokens.refresh_token,
    client_id: "mobilecloud-cli",
  });
  assert.equal(rotated.status, 200);
  const next = await rotated.json();
  assert.notEqual(next.access_token, tokens.access_token);
  assert.notEqual(next.refresh_token, tokens.refresh_token);

  const replay = await request("oauth/token", "POST", {
    grant_type: "refresh_token",
    refresh_token: tokens.refresh_token,
    client_id: "mobilecloud-cli",
  });
  assert.equal(replay.status, 400);
  assert.equal((await replay.json()).error, "invalid_grant");

  // A replayed token is evidence of theft: its descendants stop working too.
  const descendant = await request("oauth/token", "POST", {
    grant_type: "refresh_token",
    refresh_token: next.refresh_token,
    client_id: "mobilecloud-cli",
  });
  assert.equal(descendant.status, 400);
});

test("a CLI token can manage devices and sessions but nothing else", async () => {
  const browser = await login();
  const tokens = await authorizeCli(browser);
  const bearer = { authorization: `Bearer ${tokens.access_token}` };

  const sessions = await (await request("auth/sessions", "GET", undefined, bearer)).json();
  assert.ok(Array.isArray(sessions.sessions));
  assert.ok(sessions.sessions.length >= 1);
  assert.ok(sessions.sessions.every((session: { clientType?: string }) => typeof session.clientType === "string"));
  // The CLI credential itself is listed as a token, so `mobilecloud sessions`
  // shows the very credential it is running under.
  assert.ok(
    sessions.sessions.some((session: { clientType?: string; kind?: string }) => session.clientType === "cli" && session.kind === "token"),
  );

  const db = openDb();
  const now = Date.now();
  const tokenId = "1".repeat(32);
  const deviceId = "2".repeat(32);
  db.prepare(
    "INSERT INTO access_tokens (id, owner_id, name, token_hash, prefix, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(tokenId, browser.userId, "linked device", "d".repeat(64), "mc_linked", now, now + 86_400_000);
  db.prepare(
    `INSERT INTO connected_devices (id, owner_id, token_id, name, platform, method, created_at, paired_at, revoked)
     VALUES (?, ?, ?, ?, ?, 'test', ?, ?, 0)`,
  ).run(deviceId, browser.userId, tokenId, "Test phone", "android", now, now);

  const listed = await (await request("devices", "GET", undefined, bearer)).json();
  assert.ok(listed.devices.some((device: { id: string }) => device.id === deviceId));
  assert.equal((await request(`devices/${deviceId}`, "DELETE", undefined, bearer)).status, 200);
  assert.equal(
    (openDb().prepare("SELECT revoked FROM connected_devices WHERE id = ?").get(deviceId) as { revoked: number }).revoked,
    1,
  );

  // The CLI scope is not a blank cheque: an ordinary account mutation stays closed.
  assert.equal((await request("profile", "POST", { name: "Not from a token" }, bearer)).status, 403);

  const signedOut = await request("auth/logout", "POST", {}, bearer);
  assert.equal(signedOut.status, 200);
  // auth/me is deliberately 200 with a null user, so a client can ask "who am I"
  // before it signs in without treating the answer as an error.
  assert.equal((await (await request("auth/me", "GET", undefined, bearer)).json()).user, null);
  assert.equal((await request("auth/sessions", "GET", undefined, bearer)).status, 401);
});

test("login with MobileCloud signs the browser in only after the phone approves", async () => {
  const browser = await login();
  const started = await (await request("auth/qr-login/init", "POST", { browser: "Chrome on Windows" })).json();
  assert.match(started.challenge_id, /^[a-f0-9]{32}$/);
  assert.match(started.verification_code, /^[A-Z2-9]{6}$/);
  assert.match(started.qr_data_url, /^data:image\/png;base64,/);
  const ticket = decodeLoginTicket(started.qr_payload);
  assert.ok(ticket);
  assert.equal(ticket.id, started.challenge_id);
  assert.equal(ticket.code, started.verification_code);
  assert.equal(ticket.browser, "Chrome on Windows");

  // The poll secret is the only way to read, or collect, this challenge.
  assert.equal((await request(`auth/qr-login/${started.challenge_id}?poll=${"0".repeat(64)}`)).status, 403);
  const waiting = await (await request(`auth/qr-login/${started.challenge_id}?poll=${started.poll_secret}`)).json();
  assert.equal(waiting.status, "WAITING");

  assert.equal(
    (await request(`auth/qr-login/${started.challenge_id}/scan`, "POST", { deviceName: "Pixel 9", devicePlatform: "android" })).status,
    200,
  );
  const scanned = await (await request(`auth/qr-login/${started.challenge_id}?poll=${started.poll_secret}`)).json();
  assert.equal(scanned.status, "SCANNED");

  const wrongCode = await request(
    `auth/qr-login/${started.challenge_id}/approve`,
    "POST",
    { challenge: ticket.challenge, verification_code: "AAAAAA" },
    browser,
  );
  assert.equal(wrongCode.status, 400);

  const approved = await request(
    `auth/qr-login/${started.challenge_id}/approve`,
    "POST",
    { challenge: ticket.challenge, verification_code: started.verification_code },
    browser,
  );
  assert.equal(approved.status, 200);

  const claimed = await request(`auth/qr-login/${started.challenge_id}?poll=${started.poll_secret}`);
  assert.equal(claimed.status, 200);
  assert.equal((await claimed.json()).status, "APPROVED");
  const cookie = claimed.headers.getSetCookie().find((value) => value.startsWith("mc_session="))!.split(";")[0];
  const me = await (await request("auth/me", "GET", undefined, { cookie })).json();
  assert.equal(me.user.id, browser.userId);

  // The challenge is spent, so the same link cannot sign in a second time.
  const again = await (await request(`auth/qr-login/${started.challenge_id}?poll=${started.poll_secret}`)).json();
  assert.equal(again.status, "CONSUMED");
});

test("passkey ceremonies are bound to the console relying party", async () => {
  const browser = await login();
  assert.equal((await request("auth/passkey/register/begin", "POST", {})).status, 401);

  const registration = await (await request("auth/passkey/register/begin", "POST", { deviceName: "Pixel 9" }, browser)).json();
  assert.equal(registration.publicKey.rp.id, "console.example.test");
  assert.equal(registration.publicKey.rp.name, "MobileCloud");
  assert.equal(registration.publicKey.authenticatorSelection.userVerification, "required");
  assert.equal(registration.publicKey.authenticatorSelection.residentKey, "required");
  assert.match(registration.publicKey.challenge, /^[A-Za-z0-9_-]{43}$/);
  assert.match(registration.challenge_id, /^[a-f0-9]{32}$/);

  const assertion = await (await request("auth/passkey/login/begin", "POST", {})).json();
  assert.equal(assertion.publicKey.rpId, "console.example.test");
  assert.equal(assertion.publicKey.userVerification, "required");
});
