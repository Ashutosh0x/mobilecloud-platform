import { randomBytes, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { newId, tokenHash } from "./db.ts";
import { createToken } from "./identity.ts";

/**
 * QR device pairing — a secure, single-use device-authorization flow.
 *
 * A signed-in browser creates a short-lived pairing session and renders its
 * secrets as a QR code. The Android application scans the QR, validates the
 * payload, and then *explicitly approves* the pairing from an account that
 * matches the browser's account. Only then does the server issue a durable
 * device credential.
 *
 * Security properties enforced here:
 *   - The pairing secret is 256 bits of CSPRNG entropy and only its SHA-256
 *     hash is stored, so a database read cannot reconstruct a scannable QR.
 *   - Sessions expire after two minutes and can be consumed exactly once.
 *   - Every transition is a guarded, atomic UPDATE, so two clients racing to
 *     approve cannot both win.
 *   - Account isolation: an approving device must belong to the same account
 *     as the browser that created the session.
 *   - No permanent credential ever travels in the QR payload; the durable
 *     credential is issued over the (already authenticated) approval call.
 */

/** Pairing sessions are valid for two minutes, as required by the design. */
export const PAIRING_TTL_MS = 120_000;

/** Device credentials are durable but still expire, and are individually revocable. */
const DEVICE_CREDENTIAL_DAYS = 365;

/** Human-readable code alphabet: no 0/O/1/I/L, so it can be typed from a screen. */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export type PairingStatus =
  | "WAITING_FOR_SCAN"
  | "SCANNED"
  | "AWAITING_APPROVAL"
  | "APPROVED"
  | "CONNECTED"
  | "EXPIRED"
  | "REVOKED"
  | "FAILED";

/** Statuses from which no further transition is allowed. */
const TERMINAL = new Set<string>(["CONNECTED", "REVOKED", "FAILED", "EXPIRED"]);
/** Statuses in which a session is still live and can be approved. */
const OPEN = new Set<string>(["WAITING_FOR_SCAN", "SCANNED", "AWAITING_APPROVAL"]);

export type PairingRow = {
  id: string;
  secret_hash: string;
  user_code: string;
  owner_id: string;
  status: string;
  method: string;
  browser_name: string | null;
  browser_platform: string | null;
  browser_user_agent: string | null;
  browser_ip: string | null;
  scan_device_name: string | null;
  scan_device_platform: string | null;
  scan_app_version: string | null;
  fail_reason: string | null;
  created_at: number;
  expires_at: number;
  scanned_at: number | null;
  approved_at: number | null;
  connected_at: number | null;
  device_id: string | null;
};

export type DeviceRow = {
  id: string;
  owner_id: string;
  token_id: string | null;
  pairing_id: string | null;
  name: string;
  platform: string;
  app_version: string | null;
  method: string;
  created_at: number;
  paired_at: number;
  last_active: number | null;
  last_ip: string | null;
  revoked: number;
  revoked_at: number | null;
};

export type PairingDevice = { name?: string; platform?: string; appVersion?: string };

function randomCode(): string {
  const bytes = randomBytes(6);
  let out = "";
  for (let i = 0; i < 6; i += 1) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

/** Constant-time comparison of two hex-encoded SHA-256 digests. */
function safeEqualHex(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  if (!left.length || left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** The status a client should see, taking the wall clock into account. */
export function effectiveStatus(row: PairingRow): PairingStatus {
  if (row.status === "EXPIRED" || row.status === "REVOKED" || row.status === "FAILED") {
    return row.status;
  }
  if (row.status === "APPROVED" || row.status === "CONNECTED") return "CONNECTED";
  if (row.expires_at <= Date.now()) return "EXPIRED";
  return row.status as PairingStatus;
}

function getRow(db: DatabaseSync, id: string): PairingRow | undefined {
  return db.prepare("SELECT * FROM pairing_sessions WHERE id = ?").get(id) as PairingRow | undefined;
}

/**
 * Sanitized projection sent to clients. Never contains the secret hash, the
 * owner id, or either IP address.
 */
export function publicPairing(row: PairingRow) {
  const now = Date.now();
  return {
    pairing_id: row.id,
    status: effectiveStatus(row),
    verification_code: row.user_code,
    method: row.method,
    created_at: new Date(row.created_at).toISOString(),
    expires_at: new Date(row.expires_at).toISOString(),
    expires_in_ms: Math.max(0, row.expires_at - now),
    scanned_at: row.scanned_at ? new Date(row.scanned_at).toISOString() : null,
    browser: {
      name: row.browser_name,
      platform: row.browser_platform,
    },
    device: row.scan_device_name
      ? { name: row.scan_device_name, platform: row.scan_device_platform, app_version: row.scan_app_version }
      : null,
    connected_device_id: row.device_id,
    reason: row.fail_reason,
  };
}

export function pairingExists(db: DatabaseSync, id: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM pairing_sessions WHERE id = ?").get(id));
}

/**
 * Creates a pairing session for an authenticated browser. Any session this
 * browser already had open is closed first, so at most one QR code is live per
 * account and a stale screenshot can never be reused.
 */
export function createPairing(
  db: DatabaseSync,
  owner: string,
  browser: { name?: string; platform?: string; userAgent?: string; ip?: string },
): { id: string; secret: string; verificationCode: string; expiresAt: number } {
  const now = Date.now();
  db.prepare(
    `UPDATE pairing_sessions SET status = 'REVOKED', fail_reason = 'superseded'
     WHERE owner_id = ? AND status IN ('WAITING_FOR_SCAN', 'SCANNED', 'AWAITING_APPROVAL')`,
  ).run(owner);

  const id = newId();
  const secret = randomBytes(32).toString("base64url"); // 256 bits
  const verificationCode = randomCode();
  const expiresAt = now + PAIRING_TTL_MS;
  db.prepare(
    `INSERT INTO pairing_sessions
       (id, secret_hash, user_code, owner_id, status, method, browser_name, browser_platform, browser_user_agent, browser_ip, created_at, expires_at)
     VALUES (?, ?, ?, ?, 'WAITING_FOR_SCAN', 'qr', ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    tokenHash(secret),
    verificationCode,
    owner,
    (browser.name ?? "Web Dashboard").slice(0, 60),
    (browser.platform ?? "web").slice(0, 40),
    (browser.userAgent ?? "").slice(0, 180) || null,
    browser.ip ?? null,
    now,
    expiresAt,
  );
  return { id, secret, verificationCode, expiresAt };
}

/** Reads a session, applying the expiry clock. Returns undefined if unknown. */
export function readPairing(db: DatabaseSync, id: string): PairingRow | undefined {
  const row = getRow(db, id);
  if (!row) return undefined;
  if (OPEN.has(row.status) && row.expires_at <= Date.now()) {
    db.prepare("UPDATE pairing_sessions SET status = 'EXPIRED' WHERE id = ? AND status = ?").run(id, row.status);
    return getRow(db, id);
  }
  return row;
}

/** True when the presented secret matches the stored hash for this session. */
export function secretMatches(row: PairingRow, secret: string): boolean {
  if (!secret) return false;
  return safeEqualHex(row.secret_hash, tokenHash(secret));
}

/**
 * Finds a live session by its human-readable verification code. This backs the
 * manual code-entry fallback when the camera is unavailable.
 */
export function pairingByCode(db: DatabaseSync, owner: string, code: string): PairingRow | undefined {
  const normalized = code.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  if (normalized.length !== 6) return undefined;
  const row = db.prepare(
    "SELECT * FROM pairing_sessions WHERE owner_id = ? AND user_code = ? ORDER BY created_at DESC LIMIT 1",
  ).get(owner, normalized) as PairingRow | undefined;
  if (!row) return undefined;
  return OPEN.has(row.status) && row.expires_at > Date.now() ? row : undefined;
}

export type ScanResult =
  | { ok: true; row: PairingRow; duplicate: boolean }
  | { ok: false; reason: string };

/**
 * Registers an Android scan. Transitions WAITING_FOR_SCAN → SCANNED exactly
 * once; a second scan from the same device is treated as an idempotent retry
 * rather than an error, so a flaky network cannot strand the user.
 */
export function scanPairing(db: DatabaseSync, id: string, secret: string, device: PairingDevice, ip?: string): ScanResult {
  const row = readPairing(db, id);
  if (!row) return { ok: false, reason: "unknown_session" };
  if (!secretMatches(row, secret)) return { ok: false, reason: "invalid_secret" };

  const status = effectiveStatus(row);
  if (status === "EXPIRED") return { ok: false, reason: "expired" };
  if (status === "REVOKED" || status === "FAILED") return { ok: false, reason: "closed" };
  if (status === "CONNECTED") return { ok: false, reason: "already_connected" };

  const name = (device.name ?? "Android device").slice(0, 60);
  const platform = (device.platform ?? "android").slice(0, 40);
  const appVersion = (device.appVersion ?? "").slice(0, 40) || null;

  const result = db.prepare(
    `UPDATE pairing_sessions
       SET status = 'SCANNED', scanned_at = ?, scan_device_name = ?, scan_device_platform = ?, scan_app_version = ?
     WHERE id = ? AND status = 'WAITING_FOR_SCAN' AND expires_at > ?`,
  ).run(Date.now(), name, platform, appVersion, id, Date.now());

  if (Number(result.changes) === 0) {
    const again = readPairing(db, id);
    if (again && (again.status === "SCANNED" || again.status === "AWAITING_APPROVAL")) {
      return { ok: true, row: again, duplicate: true };
    }
    return { ok: false, reason: "race" };
  }
  db.prepare("UPDATE pairing_sessions SET scan_device_platform = ? WHERE id = ?").run(platform, id);
  return { ok: true, row: readPairing(db, id) as PairingRow, duplicate: false };
}

/** Moves a scanned session into the "user is looking at the approval screen" state. */
export function markAwaitingApproval(db: DatabaseSync, id: string): boolean {
  const result = db.prepare(
    "UPDATE pairing_sessions SET status = 'AWAITING_APPROVAL' WHERE id = ? AND status = 'SCANNED'",
  ).run(id);
  return Number(result.changes) > 0;
}

export type ApproveResult =
  | {
      ok: true;
      row: PairingRow;
      device: { id: string; name: string; platform: string; appVersion: string | null };
      credential: string;
      credentialExpiresAt: number | null;
    }
  | { ok: false; reason: string };

/**
 * Approves a pairing from the Android device and issues the durable device
 * credential. The caller must already have verified that [owner] is the
 * authenticated Android account. All writes must run inside one transaction
 * (see `tx()`), so the session is consumed iff the device row is created.
 */
export function approvePairing(
  db: DatabaseSync,
  session: PairingRow,
  owner: string,
  device: PairingDevice,
  ip?: string,
): ApproveResult {
  if (session.owner_id !== owner) return { ok: false, reason: "account_mismatch" };

  const status = effectiveStatus(session);
  if (status === "EXPIRED") return { ok: false, reason: "expired" };
  if (status === "REVOKED" || status === "FAILED") return { ok: false, reason: "closed" };
  if (status === "CONNECTED") return { ok: false, reason: "already_connected" };

  const now = Date.now();
  const consumed = db.prepare(
    `UPDATE pairing_sessions SET status = 'APPROVED', approved_at = ?, owner_id = ?
     WHERE id = ? AND status IN ('WAITING_FOR_SCAN', 'SCANNED', 'AWAITING_APPROVAL') AND expires_at > ?`,
  ).run(now, owner, session.id, now);
  if (Number(consumed.changes) === 0) return { ok: false, reason: "race" };

  const name = (device.name ?? session.scan_device_name ?? "Android device").slice(0, 60);
  const platform = (device.platform ?? session.scan_device_platform ?? "android").slice(0, 40);
  const appVersion = (device.appVersion ?? session.scan_app_version ?? "").slice(0, 40) || null;

  const issued = createToken(db, owner, `device: ${name}`.slice(0, 60), DEVICE_CREDENTIAL_DAYS);
  const tokenRow = db.prepare("SELECT id FROM access_tokens WHERE token_hash = ?").get(tokenHash(issued.token)) as
    | { id: string }
    | undefined;

  const deviceId = newId();
  db.prepare(
    `INSERT INTO connected_devices
       (id, owner_id, token_id, pairing_id, name, platform, app_version, method, created_at, paired_at, last_active, last_ip, revoked)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'qr', ?, ?, ?, ?, 0)`,
  ).run(deviceId, owner, tokenRow?.id ?? null, session.id, name, platform, appVersion, now, now, now, ip ?? null);

  db.prepare("UPDATE pairing_sessions SET status = 'CONNECTED', connected_at = ?, device_id = ? WHERE id = ?").run(
    now,
    deviceId,
    session.id,
  );

  return {
    ok: true,
    row: readPairing(db, session.id) as PairingRow,
    device: { id: deviceId, name, platform, appVersion },
    credential: issued.token,
    credentialExpiresAt: issued.expiresAt,
  };
}

/** Closes a session without linking a device (reject / cancel). */
export function closePairing(db: DatabaseSync, id: string, reason: string): boolean {
  const result = db.prepare(
    `UPDATE pairing_sessions SET status = 'REVOKED', fail_reason = ?
     WHERE id = ? AND status IN ('WAITING_FOR_SCAN', 'SCANNED', 'AWAITING_APPROVAL')`,
  ).run(reason.slice(0, 60), id);
  return Number(result.changes) > 0;
}

/** Marks every session past its TTL as expired and returns them for event fan-out. */
export function expireStale(db: DatabaseSync): PairingRow[] {
  const now = Date.now();
  const rows = db.prepare(
    "SELECT * FROM pairing_sessions WHERE status IN ('WAITING_FOR_SCAN', 'SCANNED', 'AWAITING_APPROVAL') AND expires_at <= ?",
  ).all(now) as PairingRow[];
  if (rows.length) {
    db.prepare(
      "UPDATE pairing_sessions SET status = 'EXPIRED' WHERE status IN ('WAITING_FOR_SCAN', 'SCANNED', 'AWAITING_APPROVAL') AND expires_at <= ?",
    ).run(now);
  }
  return rows;
}

export function listDevices(db: DatabaseSync, owner: string) {
  const rows = db.prepare(
    `SELECT id, name, platform, app_version AS appVersion, method,
            created_at AS createdAt, paired_at AS pairedAt, last_active AS lastActive,
            revoked, revoked_at AS revokedAt
     FROM connected_devices WHERE owner_id = ? ORDER BY paired_at DESC`,
  ).all(owner) as {
    id: string;
    name: string;
    platform: string;
    appVersion: string | null;
    method: string;
    createdAt: number;
    pairedAt: number;
    lastActive: number | null;
    revoked: number;
    revokedAt: number | null;
  }[];
  return rows.map((row) => ({ ...row, revoked: row.revoked === 1 }));
}

/** Revokes a device and its underlying credential in one step. */
export function revokeDevice(db: DatabaseSync, owner: string, deviceId: string): { ok: boolean; device?: DeviceRow } {
  const device = db.prepare("SELECT * FROM connected_devices WHERE owner_id = ? AND id = ?").get(owner, deviceId) as
    | DeviceRow
    | undefined;
  if (!device) return { ok: false };
  const now = Date.now();
  db.prepare("UPDATE connected_devices SET revoked = 1, revoked_at = ? WHERE owner_id = ? AND id = ?").run(now, owner, deviceId);
  if (device.token_id) db.prepare("DELETE FROM access_tokens WHERE owner_id = ? AND id = ?").run(owner, device.token_id);
  return { ok: true, device: { ...device, revoked: 1, revoked_at: now } };
}

/** Renames a connected device (display only). */
export function renameDevice(db: DatabaseSync, owner: string, deviceId: string, name: string): boolean {
  const clean = name.trim().slice(0, 60);
  if (!clean) return false;
  const result = db.prepare("UPDATE connected_devices SET name = ? WHERE owner_id = ? AND id = ? AND revoked = 0").run(
    clean,
    owner,
    deviceId,
  );
  return Number(result.changes) > 0;
}
