import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { newId, tokenHash } from "./db.ts";
import { publish, tx } from "./events.ts";

/**
 * Client scoped sessions.
 *
 * Every client gets its own session with its own lifetime, its own device
 * binding and its own audit trail, so a phone that stays signed in for a
 * month never keeps a browser tab alive and a CLI token never outlives its
 * hour:
 *
 *   android  30 days   the phone is the trust anchor, it stays signed in
 *   web      24 hours  a browser session is short lived by design
 *   cli       1 hour   the access token; the refresh token lasts 30 days
 *   api      24 hours  an API token, scoped to what it was issued for
 *
 * The lifetime of each class can be overridden by the operator.
 */

export type ClientType = "android" | "web" | "cli" | "api";

const DEFAULT_LIFETIMES: Record<ClientType, number> = {
  android: 30 * 86_400_000,
  web: 24 * 3_600_000,
  cli: 3_600_000,
  api: 24 * 3_600_000,
};

const OVERRIDES: Record<ClientType, string> = {
  android: "MOBILECLOUD_SESSION_TTL_ANDROID",
  web: "MOBILECLOUD_SESSION_TTL_WEB",
  cli: "MOBILECLOUD_SESSION_TTL_CLI",
  api: "MOBILECLOUD_SESSION_TTL_API",
};

/** The lifetime of a session for one client class. */
export function sessionLifetime(clientType: ClientType): number {
  const raw = Number(process.env[OVERRIDES[clientType]]);
  if (Number.isFinite(raw) && raw > 60_000) return Math.floor(raw);
  return DEFAULT_LIFETIMES[clientType];
}

export type CreatedSession = {
  sessionId: string;
  token: string;
  csrf: string;
  expiresAt: number;
  clientType: ClientType;
};

/**
 * Creates a session and returns the raw token once.
 *
 * Only the hash of the token is stored, so the raw value exists exactly once,
 * in the response that hands it to the client.
 */
export function createSession(
  db: DatabaseSync,
  input: {
    userId: string;
    clientType: ClientType;
    userAgent?: string | null;
    deviceId?: string | null;
    credentialId?: string | null;
    ipAddress?: string | null;
    geoLocation?: string | null;
  },
): CreatedSession {
  const token = randomBytes(32).toString("hex");
  const csrf = randomBytes(32).toString("hex");
  const sessionId = newId();
  const now = Date.now();
  const expiresAt = now + sessionLifetime(input.clientType);
  db.prepare(
    `INSERT INTO sessions (id, token_hash, user_id, expires_at, user_agent, created_at, csrf, device_id,
       client_type, credential_id, ip_address, geo_location, last_active_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    sessionId,
    tokenHash(token),
    input.userId,
    expiresAt,
    (input.userAgent ?? "unknown").slice(0, 180),
    now,
    csrf,
    input.deviceId ?? null,
    input.clientType,
    input.credentialId ?? null,
    input.ipAddress ?? null,
    input.geoLocation ?? null,
    now,
  );
  publish(db, input.userId, "session.created", sessionId, { sessionId, clientType: input.clientType });
  return { sessionId, token, csrf, expiresAt, clientType: input.clientType };
}

/** Marks a session as recently used. */
export function touchSession(db: DatabaseSync, sessionId: string): void {
  db.prepare("UPDATE sessions SET last_active_at = ? WHERE id = ?").run(Date.now(), sessionId);
}

/**
 * The credentials of an account, newest first.
 *
 * Browser and phone sessions live in `sessions`; a CLI or API credential is a
 * bearer token in `access_tokens` with no session row. Both are reported as
 * one list so `mobilecloud sessions` shows everything that can reach the
 * account, and either kind can be revoked by the same command.
 */
export function listAccountSessions(db: DatabaseSync, owner: string, currentHash: string | null) {
  const sessions = db.prepare(
    `SELECT id, client_type AS clientType, user_agent AS userAgent, device_id AS deviceId,
       credential_id AS credentialId, ip_address AS ipAddress, created_at AS createdAt,
       expires_at AS expiresAt, last_active_at AS lastActiveAt, token_hash AS tokenHash
     FROM sessions WHERE user_id = ? ORDER BY created_at DESC`,
  ).all(owner).map((row) => {
    const item = row as {
      id: string | null;
      tokenHash: string;
      clientType: string | null;
      userAgent: string | null;
      deviceId: string | null;
      credentialId: string | null;
      ipAddress: string | null;
      createdAt: number | null;
      expiresAt: number;
      lastActiveAt: number | null;
    };
    return {
      id: item.id || item.tokenHash,
      kind: "session" as const,
      clientType: item.clientType ?? "web",
      userAgent: item.userAgent,
      deviceId: item.deviceId,
      credentialId: item.credentialId,
      ipAddress: item.ipAddress,
      createdAt: item.createdAt,
      expiresAt: item.expiresAt,
      lastActiveAt: item.lastActiveAt,
      current: item.tokenHash === currentHash,
    };
  });
  // A token that backs a linked device is already represented by that device
  // and its session; only unattached CLI/API credentials are added here.
  const tokens = db.prepare(
    `SELECT t.id, t.name, t.client_type AS clientType, t.created_at AS createdAt,
            t.expires_at AS expiresAt, t.last_used AS lastUsed
     FROM access_tokens t
     WHERE t.owner_id = ? AND t.expires_at > ?
       AND NOT EXISTS (SELECT 1 FROM connected_devices d WHERE d.token_id = t.id)`,
  ).all(owner, Date.now()).map((row) => {
    const token = row as {
      id: string;
      name: string;
      clientType: string | null;
      createdAt: number;
      expiresAt: number;
      lastUsed: number | null;
    };
    return {
      id: token.id,
      kind: "token" as const,
      clientType: token.clientType ?? "cli",
      userAgent: token.name,
      deviceId: null,
      credentialId: null,
      ipAddress: null,
      createdAt: token.createdAt,
      expiresAt: token.expiresAt,
      lastActiveAt: token.lastUsed,
      current: false,
    };
  });
  return [...sessions, ...tokens].sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0));
}

/** Revokes one session of an account. */
export function revokeSession(db: DatabaseSync, owner: string, sessionId: string): boolean {
  const result = db.prepare("DELETE FROM sessions WHERE id = ? AND user_id = ?").run(sessionId, owner);
  if (Number(result.changes)) {
    publish(db, owner, "session.revoked", sessionId, { sessionId, reason: "revoked_by_owner" });
    return true;
  }
  return false;
}

/** Revokes every session of an account. */
export function revokeAllSessions(db: DatabaseSync, owner: string): number {
  const count = tx(db, () => {
    const rows = db.prepare("SELECT id FROM sessions WHERE user_id = ?").all(owner) as { id: string }[];
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(owner);
    return rows.length;
  });
  return count;
}

/**
 * Records the device a session belongs to.
 *
 * A device linked session dies with its device: the existing session lookup
 * already refuses a session whose device was revoked.
 */
export function bindDevice(db: DatabaseSync, sessionId: string, deviceId: string | null): void {
  db.prepare("UPDATE sessions SET device_id = ? WHERE id = ?").run(deviceId, sessionId);
}
