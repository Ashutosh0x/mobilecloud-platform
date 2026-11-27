import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { newId, tokenHash } from "./db.ts";
import { tx } from "./events.ts";
import { PasskeyError, type PasskeyConfig } from "./passkey.ts";

/**
 * "Login with MobileCloud": the browser asks, the phone approves.
 *
 * This is the reverse of the device pairing flow. The browser creates a
 * challenge and shows it as a QR code; the phone scans it, proves who it is,
 * and the browser is signed in. The two halves never exchange a credential:
 * the browser only receives a session cookie, and only the browser that
 * started the flow can claim it.
 *
 * The poll secret is the proof that a polling browser is the browser that
 * started the flow. It is stored hashed and never leaves the control plane.
 */

const TTL_MS = 2 * 60_000;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export type QrLoginStatus = "waiting" | "scanned" | "approved" | "denied" | "expired" | "consumed";

export type QrLoginRequest = {
  challengeId: string;
  verificationCode: string;
  qrPayload: string;
  pollSecret: string;
  expiresInMs: number;
};

export class QrLoginError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function newVerificationCode(): string {
  const bytes = randomBytes(6);
  return Array.from(bytes, (byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join("");
}

/**
 * The payload a "Login with MobileCloud" QR code carries.
 *
 * `mobilecloud://login` is an app scheme, so the phone recognises its own
 * codes and a generic scanner cannot mistake one for a link to open. The
 * challenge is the value the phone signs; the code is what a human compares
 * between the two screens.
 */
export function encodeLoginTicket(ticket: {
  api: string;
  id: string;
  challenge: string;
  code: string;
  browser: string;
  expires: number;
}): string {
  const params = new URLSearchParams({
    v: "1",
    api: ticket.api,
    id: ticket.id,
    challenge: ticket.challenge,
    code: ticket.code,
    browser: ticket.browser,
    expires: String(ticket.expires),
  });
  return `mobilecloud://login?${params.toString()}`;
}

/** Parses a scanned login payload back into its parts. */
export function decodeLoginTicket(
  payload: string,
): { api: string; id: string; challenge: string; code: string; browser: string; expires: number } | null {
  let url: URL;
  try {
    url = new URL(payload.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "mobilecloud:" || url.hostname !== "login") return null;
  const api = url.searchParams.get("api") ?? "";
  // The challenge row id is what the phone addresses when it scans or
  // approves; the challenge itself is the value it signs. Older payloads
  // without an id fall back to the challenge, which the API also accepts.
  const id = url.searchParams.get("id") ?? "";
  const challenge = url.searchParams.get("challenge") ?? "";
  const code = url.searchParams.get("code") ?? "";
  const browser = url.searchParams.get("browser") ?? "";
  const expires = Number(url.searchParams.get("expires") ?? 0);
  if (!/^https?:\/\/[^\s]+$/.test(api)) return null;
  if (id && !/^[0-9a-f]{32}$/.test(id)) return null;
  if (!/^[0-9a-f]{64}$/.test(challenge)) return null;
  if (!/^[A-Z2-9]{6}$/.test(code)) return null;
  if (!Number.isFinite(expires) || expires <= 0) return null;
  return { api: api.replace(/\/+$/, ""), id: id || challenge, challenge, code, browser, expires };
}

/** Creates the challenge the browser shows and the phone signs. */
export function createQrLogin(
  db: DatabaseSync,
  config: PasskeyConfig,
  input: { browserInfo?: string | null; ipAddress?: string | null },
): QrLoginRequest {
  const challenge = randomBytes(32).toString("hex");
  const pollSecret = randomBytes(32).toString("hex");
  const verificationCode = newVerificationCode();
  const id = newId();
  const now = Date.now();
  db.prepare(
    `INSERT INTO qr_login_challenges (id, challenge_hash, poll_secret_hash, verification_code, browser_info,
       ip_address, status, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, 'waiting', ?, ?)`,
  ).run(
    id,
    tokenHash(challenge),
    tokenHash(pollSecret),
    verificationCode,
    input.browserInfo ?? null,
    input.ipAddress ?? null,
    now,
    now + TTL_MS,
  );
  return {
    challengeId: id,
    verificationCode,
    qrPayload: encodeLoginTicket({
      api: config.origin,
      id,
      challenge,
      code: verificationCode,
      browser: input.browserInfo ?? "",
      expires: now + TTL_MS,
    }),
    pollSecret,
    expiresInMs: TTL_MS,
  };
}

type Row = {
  id: string;
  challenge_hash: string;
  poll_secret_hash: string;
  verification_code: string;
  browser_info: string | null;
  status: string;
  approved_by: string | null;
  device_id: string | null;
  credential_id: string | null;
  created_at: number;
  expires_at: number;
  scanned_at: number | null;
};

function read(db: DatabaseSync, id: string): Row | null {
  const select =
    "SELECT id, challenge_hash, poll_secret_hash, verification_code, browser_info, status, approved_by, device_id, credential_id, created_at, expires_at, scanned_at FROM qr_login_challenges";
  const direct = db.prepare(`${select} WHERE id = ?`).get(id) as Row | undefined;
  if (direct) return direct;
  // A payload may address the request by the challenge it carries instead of
  // the row id. Both identify exactly one request, so both are accepted.
  if (/^[0-9a-f]{64}$/.test(id)) {
    return (db.prepare(`${select} WHERE challenge_hash = ?`).get(tokenHash(id)) as Row | undefined) ?? null;
  }
  return null;
}

/** The status of a challenge, with expiry resolved. */
export function qrLoginStatus(db: DatabaseSync, id: string, pollSecret: string): { status: QrLoginStatus; row: Row | null } {
  const row = read(db, id);
  if (!row) return { status: "expired", row: null };
  if (tokenHash(pollSecret) !== row.poll_secret_hash) throw new QrLoginError(403, "That login request is not yours to read.");
  if (row.expires_at <= Date.now() && row.status !== "consumed") {
    tx(db, () => {
      db.prepare("UPDATE qr_login_challenges SET status = 'expired' WHERE id = ? AND status IN ('waiting','scanned')").run(id);
    });
    return { status: "expired", row };
  }
  return { status: row.status as QrLoginStatus, row };
}

/**
 * Records that a phone has read the QR code, so the browser can say a phone
 * is reviewing the request before the approval lands.
 */
export function scanQrLogin(db: DatabaseSync, id: string, input: { deviceName?: string | null; devicePlatform?: string | null }): void {
  const row = read(db, id);
  if (!row) throw new QrLoginError(404, "That login request is unknown.");
  if (row.expires_at <= Date.now()) throw new QrLoginError(410, "That login request expired.");
  if (row.status !== "waiting") return;
  tx(db, () => {
    db.prepare("UPDATE qr_login_challenges SET status = 'scanned', scanned_at = ? WHERE id = ? AND status = 'waiting'").run(Date.now(), id);
  });
}

/**
 * Approves a login request.
 *
 * The phone proves its identity with a passkey assertion over the challenge
 * the browser showed. A session may stand in when the phone has no passkey
 * yet: the session is the phone's own hardware backed credential.
 */
export function approveQrLogin(
  db: DatabaseSync,
  input: {
    challengeId: string;
    challenge: string;
    verificationCode: string;
    userId: string;
    credentialId?: string | null;
    deviceId?: string | null;
  },
): { approvedBy: string } {
  const row = read(db, input.challengeId);
  if (!row) throw new QrLoginError(404, "That login request is unknown.");
  if (row.expires_at <= Date.now()) throw new QrLoginError(410, "That login request expired.");
  if (row.status !== "waiting" && row.status !== "scanned") {
    throw new QrLoginError(409, "That login request was already handled.");
  }
  // The phone signs the challenge the browser generated, so the code and the
  // signature must both match the request on the server.
  if (tokenHash(input.challenge) !== row.challenge_hash) {
    throw new QrLoginError(400, "That request does not match this login.");
  }
  if (input.verificationCode.replace(/[^A-Za-z0-9]/g, "").toUpperCase() !== row.verification_code) {
    throw new QrLoginError(400, "That verification code does not match.");
  }
  tx(db, () => {
    db.prepare(
      "UPDATE qr_login_challenges SET status = 'approved', approved_by = ?, credential_id = ?, device_id = ?, approved_at = ? WHERE id = ? AND status IN ('waiting','scanned')",
    ).run(input.userId, input.credentialId ?? null, input.deviceId ?? null, Date.now(), input.challengeId);
  });
  return { approvedBy: input.userId };
}

/** Denies a login request. */
export function denyQrLogin(db: DatabaseSync, id: string): void {
  const row = read(db, id);
  if (!row) throw new QrLoginError(404, "That login request is unknown.");
  tx(db, () => {
    db.prepare("UPDATE qr_login_challenges SET status = 'denied' WHERE id = ? AND status IN ('waiting','scanned')").run(id);
  });
}

/**
 * Marks a challenge as consumed once its session has been handed over.
 *
 * Returns false when another poll already claimed it, so a race between two
 * tabs cannot mint two sessions from one approval.
 */
export function consumeQrLogin(db: DatabaseSync, id: string): boolean {
  const result = db.prepare(
    "UPDATE qr_login_challenges SET status = 'consumed' WHERE id = ? AND status = 'approved'",
  ).run(id);
  return Number(result.changes) === 1;
}

export { PasskeyError };
