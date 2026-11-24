import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

process.env.MOBILECLOUD_DB = join(mkdtempSync(join(tmpdir(), "mc-pair-")), "t.db");

/**
 * Reads one cookie out of a response. Undici joins multiple `Set-Cookie`
 * headers with ", ", and none of the attributes this app sets contains a comma,
 * so splitting on it is exact here.
 */
function cookieFor(headers: Headers, name: string): string | null {
  const raw = headers.get("set-cookie") ?? "";
  const hit = raw.split(",").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  return hit ? hit.split(";")[0] : null;
}

async function signUp(handle: typeof import("./api.ts").handle, email: string): Promise<string> {
  const { hashPassword, newId, openDb } = await import("./db.ts");
  openDb().prepare("INSERT INTO users (id,email,name,password_hash,role,created_at) VALUES (?,?,'Ada',?,'member',?)")
    .run(newId(), email, hashPassword("correct-horse"), Date.now());
  const response = await handle(
    new Request("http://local/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "correct-horse" }),
    }),
    ["auth", "login"],
  );
  assert.equal(response.status, 200);
  return response.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ");
}

function csrf(cookie: string): string {
  return /mc_csrf=([a-f0-9]{64})/.exec(cookie)?.[1] ?? "";
}

/** Starts a pairing from the browser half and returns the decoded QR ticket. */
async function startPairing(
  handle: typeof import("./api.ts").handle,
  session: string,
): Promise<{ id: string; secret: string; code: string; api: string; qr: string; status: string }> {
  const response = await handle(
    new Request("http://local/api/device/pairing", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: session, "x-mc-csrf": csrf(session), host: "local" },
      body: JSON.stringify({ name: "Web Dashboard", platform: "web" }),
    }),
    ["device", "pairing"],
  );
  assert.equal(response.status, 201);
  const body = (await response.json()) as { payload: string; qr_data_url: string; pairing: { status: string } };
  assert.match(body.qr_data_url, /^data:image\/png;base64,/);
  const url = new URL(body.payload);
  assert.equal(url.protocol, "mobilecloud:");
  assert.equal(url.hostname, "pair");
  return {
    api: url.searchParams.get("api") ?? "",
    id: url.searchParams.get("id") ?? "",
    secret: url.searchParams.get("secret") ?? "",
    code: url.searchParams.get("code") ?? "",
    qr: body.qr_data_url,
    status: body.pairing.status,
  };
}

/** The phone's unauthenticated calls: no cookie, only the scanned secret. */
function phone(
  handle: typeof import("./api.ts").handle,
  id: string,
  step: "scan" | "status" | "claim",
  body: Record<string, unknown>,
  scanCookie?: string,
) {
  return handle(
    new Request(`http://local/api/device/pairing/${id}/${step}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(scanCookie ? { cookie: scanCookie } : {}) },
      body: JSON.stringify(body),
    }),
    ["device", "pairing", id, step],
  );
}

const phoneBody = (secret: string) => ({ secret, name: "Pixel 7", platform: "android", appVersion: "2.4.0" });

test("scanning, approving, and claiming links the device and signs the phone in", async () => {
  const { resetDb, openDb } = await import("./db.ts");
  resetDb();
  const { handle } = await import("./api.ts");
  const session = await signUp(handle, "qr1@example.com");

  const ticket = await startPairing(handle, session);
  assert.equal(ticket.status, "WAITING_FOR_SCAN");
  assert.ok(ticket.secret.length >= 32, "the QR must carry a high-entropy secret");

  const scanned = await phone(handle, ticket.id, "scan", phoneBody(ticket.secret));
  assert.equal(scanned.status, 200);
  const scannedBody = (await scanned.json()) as { pairing: { status: string } };
  assert.equal(scannedBody.pairing.status, "AWAITING_APPROVAL");
  const scanCookie = cookieFor(scanned.headers, "mc_session");
  assert.ok(scanCookie);

  // The phone cannot finish on its own: an unapproved session has no credential.
  const early = await phone(handle, ticket.id, "claim", phoneBody(ticket.secret), scanCookie);
  assert.equal(early.status, 409);
  assert.equal(((await early.json()) as { reason: string }).reason, "not_approved");

  const approved = await handle(
    new Request(`http://local/api/device/pairing/${ticket.id}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: session, "x-mc-csrf": csrf(session) },
    }),
    ["device", "pairing", ticket.id, "approve"],
  );
  assert.equal(approved.status, 200);

  assert.equal((await phone(handle, ticket.id, "claim", phoneBody(ticket.secret))).status, 404);
  const claimed = await phone(handle, ticket.id, "claim", phoneBody(ticket.secret), scanCookie);
  assert.equal(claimed.status, 200);
  const claim = (await claimed.json()) as {
    credential: string;
    device: { name: string };
    pairing: { status: string };
  };
  assert.match(claim.credential, /^mc_/);
  assert.equal(claim.device.name, "Pixel 7");
  assert.equal(claim.pairing.status, "CONNECTED");

  // Claiming is what signs the phone in: the response sets its own session.
  const phoneSession = cookieFor(claimed.headers, "mc_session");
  assert.ok(phoneSession, "claim must sign the phone in with a session cookie");
  assert.ok(cookieFor(claimed.headers, "mc_csrf"), "claim must also set the CSRF cookie");

  const me = await handle(
    new Request("http://local/api/auth/me", { headers: { cookie: phoneSession } }),
    ["auth", "me"],
  );
  assert.equal(me.status, 200);
  const account = (await me.json()) as { user: { email: string } | null };
  assert.equal(account.user?.email, "qr1@example.com");

  const devices = await handle(
    new Request("http://local/api/devices", { headers: { cookie: session } }),
    ["devices"],
  );
  const listing = (await devices.json()) as { devices: { name: string; method: string; revoked: boolean }[] };
  assert.equal(listing.devices.length, 1);
  assert.equal(listing.devices[0].name, "Pixel 7");
  assert.equal(listing.devices[0].method, "qr");
  assert.equal(listing.devices[0].revoked, false);

  // The credential is stored only as a hash, exactly like an access token.
  const stored = openDb().prepare("SELECT token_hash FROM access_tokens").all() as { token_hash: string }[];
  assert.equal(stored.some((row) => row.token_hash === claim.credential), false);

  // Single use: a replay of the same claim cannot mint a second device.
  const replay = await phone(handle, ticket.id, "claim", phoneBody(ticket.secret), scanCookie);
  assert.equal(replay.status, 410);
  assert.equal(((await replay.json()) as { reason: string }).reason, "already_connected");
  const after = await handle(
    new Request("http://local/api/devices", { headers: { cookie: session } }),
    ["devices"],
  );
  assert.equal(((await after.json()) as { devices: unknown[] }).devices.length, 1);
});

test("the dashboard can only approve a session a device has actually scanned", async () => {
  const { resetDb } = await import("./db.ts");
  resetDb();
  const { handle } = await import("./api.ts");
  const session = await signUp(handle, "qr2@example.com");

  const ticket = await startPairing(handle, session);
  const approved = await handle(
    new Request(`http://local/api/device/pairing/${ticket.id}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: session, "x-mc-csrf": csrf(session) },
    }),
    ["device", "pairing", ticket.id, "approve"],
  );
  assert.equal(approved.status, 409);
  assert.equal(((await approved.json()) as { reason: string }).reason, "not_approved");
});

test("a pairing belongs to the account that created it", async () => {
  const { resetDb } = await import("./db.ts");
  resetDb();
  const { handle } = await import("./api.ts");
  const owner = await signUp(handle, "qr3a@example.com");
  const stranger = await signUp(handle, "qr3b@example.com");

  const ticket = await startPairing(handle, owner);
  await phone(handle, ticket.id, "scan", phoneBody(ticket.secret));

  const peek = await handle(
    new Request(`http://local/api/device/pairing/${ticket.id}`, { headers: { cookie: stranger } }),
    ["device", "pairing", ticket.id],
  );
  assert.equal(peek.status, 404);

  const steal = await handle(
    new Request(`http://local/api/device/pairing/${ticket.id}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: stranger, "x-mc-csrf": csrf(stranger) },
    }),
    ["device", "pairing", ticket.id, "approve"],
  );
  assert.equal(steal.status, 404);
});

test("a wrong secret never links a device", async () => {
  const { resetDb } = await import("./db.ts");
  resetDb();
  const { handle } = await import("./api.ts");
  const session = await signUp(handle, "qr4@example.com");

  const ticket = await startPairing(handle, session);
  const wrong = await phone(handle, ticket.id, "scan", phoneBody(`${ticket.secret}-tampered`));
  assert.equal(wrong.status, 404);
  assert.equal(((await wrong.json()) as { reason: string }).reason, "invalid_secret");

  // Nothing the phone can fetch exposes the secret or the account it belongs to.
  const status = await phone(handle, ticket.id, "status", { secret: ticket.secret });
  assert.equal(status.status, 200);
  const text = JSON.stringify(await status.json());
  assert.equal(text.includes(ticket.secret), false);
  assert.equal(text.includes("secret_hash"), false);
  assert.equal(text.includes("owner_id"), false);
});

test("an expired pairing is refused for both the phone and the dashboard", async () => {
  const { resetDb, openDb } = await import("./db.ts");
  resetDb();
  const { handle } = await import("./api.ts");
  const session = await signUp(handle, "qr5@example.com");

  const ticket = await startPairing(handle, session);
  openDb().prepare("UPDATE pairing_sessions SET expires_at = ? WHERE id = ?").run(Date.now() - 1000, ticket.id);

  const scanned = await phone(handle, ticket.id, "scan", phoneBody(ticket.secret));
  assert.equal(scanned.status, 409);
  assert.equal(((await scanned.json()) as { reason: string }).reason, "expired");

  const approved = await handle(
    new Request(`http://local/api/device/pairing/${ticket.id}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: session, "x-mc-csrf": csrf(session) },
    }),
    ["device", "pairing", ticket.id, "approve"],
  );
  assert.equal(approved.status, 409);

  const claimed = await phone(handle, ticket.id, "claim", phoneBody(ticket.secret));
  assert.equal(claimed.status, 410);
});

test("showing a new QR code revokes the previous one", async () => {
  const { resetDb } = await import("./db.ts");
  resetDb();
  const { handle } = await import("./api.ts");
  const session = await signUp(handle, "qr6@example.com");

  const first = await startPairing(handle, session);
  const second = await startPairing(handle, session);
  assert.notEqual(first.id, second.id);

  const stale = await phone(handle, first.id, "scan", phoneBody(first.secret));
  assert.equal(stale.status, 409);
  assert.equal(((await stale.json()) as { reason: string }).reason, "closed");

  // The replacement is still usable.
  const live = await phone(handle, second.id, "scan", phoneBody(second.secret));
  assert.equal(live.status, 200);
  const revoking = await handle(
    new Request(`http://local/api/device/pairing/${second.id}`, {
      method: "DELETE",
      headers: { cookie: session, "x-mc-csrf": csrf(session) },
    }),
    ["device", "pairing", second.id],
  );
  assert.equal(revoking.status, 200);
  const scanCookie = cookieFor(live.headers, "mc_session");
  assert.ok(scanCookie);
  const cancelled = await phone(handle, second.id, "status", { secret: second.secret }, scanCookie);
  assert.equal(((await cancelled.json()) as { pairing: { status: string } }).pairing.status, "REVOKED");
});
