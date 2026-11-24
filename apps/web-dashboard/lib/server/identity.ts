import { randomBytes, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { hashPassword, newId, tokenHash, verifyPassword } from "./db.ts";
import { publish, tx } from "./events.ts";

const GATE = "mc_gate";

export function notify(db: DatabaseSync, owner: string, type: string, title: string, message: string) {
  const insert = () => {
    const id = newId();
    const excerpt = message.slice(0, 500);
    db.prepare(
      "INSERT INTO notifications (id, owner_id, type, title, message, read, at) VALUES (?, ?, ?, ?, ?, 0, ?)",
    ).run(id, owner, type, title, excerpt, Date.now());
    publish(db, owner, "notification.created", id, { id, type, title, message: excerpt });
  };
  if (db.isTransaction) insert();
  else tx(db, insert);
  // Deliberately no outbound delivery, even for previously stored endpoints.
  // Re-enable only with a connection-time egress policy and bounded worker.
}

export function listNotifications(db: DatabaseSync, owner: string) {
  return db.prepare(
    "SELECT id, type, title, message, read, at FROM notifications WHERE owner_id = ? ORDER BY at DESC LIMIT 50",
  ).all(owner).map((row) => {
    const item = row as { id: string; type: string; title: string; message: string; read: number; at: number };
    return { ...item, read: item.read === 1 };
  });
}

export function listSessions(db: DatabaseSync, owner: string, currentHash: string | null) {
  return db.prepare(
    "SELECT id, token_hash AS tokenHash, user_agent AS userAgent, created_at AS createdAt, expires_at AS expiresAt FROM sessions WHERE user_id = ? ORDER BY created_at DESC",
  ).all(owner).map((row) => {
    const item = row as { id: string | null; tokenHash: string; userAgent: string | null; createdAt: number | null; expiresAt: number };
    return {
      id: item.id || item.tokenHash,
      userAgent: item.userAgent || "unknown client",
      createdAt: item.createdAt,
      expiresAt: item.expiresAt,
      current: item.tokenHash === currentHash,
    };
  });
}

export function listTokens(db: DatabaseSync, owner: string) {
  return db.prepare(
    "SELECT id, name, prefix, created_at AS createdAt, expires_at AS expiresAt, last_used AS lastUsed FROM access_tokens WHERE owner_id = ? ORDER BY created_at DESC",
  ).all(owner);
}

export function createToken(db: DatabaseSync, owner: string, name: string, days: number) {
  const raw = `mc_${randomBytes(24).toString("hex")}`;
  const expires = Date.now() + days * 86400_000;
  const id = newId();
  db.prepare(
    "INSERT INTO access_tokens (id, owner_id, name, token_hash, prefix, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(id, owner, name.slice(0, 60), tokenHash(raw), raw.slice(0, 10), Date.now(), expires);
  return { id, token: raw, expiresAt: expires };
}

export function userFromBearer(db: DatabaseSync, header: string | null) {
  if (!header || !/^Bearer mc_[a-f0-9]{48}$/i.test(header)) return null;
  const raw = header.slice("Bearer ".length);
  const now = Date.now();
  const row = db.prepare(
    `SELECT u.id, u.email, u.name, u.role, u.plan, t.id AS tokenId, d.id AS deviceId
     FROM access_tokens t JOIN users u ON u.id = t.owner_id
     LEFT JOIN connected_devices d ON d.token_id = t.id AND d.owner_id = u.id
     WHERE t.token_hash = ? AND t.expires_at > ? AND (d.id IS NULL OR d.revoked = 0)`,
  ).get(tokenHash(raw), now) as { id: string; email: string; name: string; role: string; plan: string; tokenId: string; deviceId: string | null } | undefined;
  if (!row) return null;
  const { tokenId, deviceId, ...user } = row;
  try {
    db.prepare("UPDATE access_tokens SET last_used = ? WHERE id = ? AND (last_used IS NULL OR last_used < ?)").run(now, tokenId, now - 60_000);
    if (deviceId) db.prepare("UPDATE connected_devices SET last_active = ? WHERE id = ? AND last_active < ?").run(now, deviceId, now - 60_000);
  } catch { /* Activity is advisory. */ }
  return { user, tokenId, deviceId };
}

export function startDevice(db: DatabaseSync) {
  const device = randomBytes(24).toString("hex");
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return tx(db, () => {
    const now = Date.now();
    db.prepare("DELETE FROM device_codes WHERE expires_at <= ?").run(now);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const code = Array.from(randomBytes(8), (byte) => alphabet[byte % alphabet.length]).join("");
      const userCode = `${code.slice(0, 4)}-${code.slice(4)}`;
      const result = db.prepare(
        "INSERT INTO device_codes (id, device_hash, user_code, status, expires_at) VALUES (?, ?, ?, 'pending', ?) ON CONFLICT(user_code) DO NOTHING",
      ).run(newId(), tokenHash(device), userCode, now + 10 * 60_000);
      if (result.changes) return { deviceCode: device, userCode, expiresIn: 600 };
    }
    throw new Error("No device display code available");
  });
}

export function approveDevice(db: DatabaseSync, owner: string, userCode: string) {
  const result = db.prepare(
    "UPDATE device_codes SET owner_id = ?, status = 'approved' WHERE user_code = ? AND status = 'pending' AND expires_at > ?",
  ).run(owner, userCode.toUpperCase(), Date.now());
  return Number(result.changes) > 0;
}

export function pollDevice(db: DatabaseSync, deviceCode: string) {
  return tx(db, () => {
    const row = db.prepare(
      "SELECT id, owner_id AS ownerId, status, expires_at AS expiresAt FROM device_codes WHERE device_hash = ?",
    ).get(tokenHash(deviceCode)) as { id: string; ownerId: string | null; status: string; expiresAt: number } | undefined;
    if (!row || row.expiresAt <= Date.now() || row.status === "consumed") return { status: "expired" as const };
    if (row.status !== "approved" || !row.ownerId) return { status: "pending" as const };
    const issued = createToken(db, row.ownerId, "device", 30);
    db.prepare("UPDATE device_codes SET status = 'consumed' WHERE id = ?").run(row.id);
    publish(db, row.ownerId, "configuration.updated", issued.id, { resource: "token", id: issued.id });
    return { status: "approved" as const, token: issued.token, expiresAt: issued.expiresAt };
  });
}

export function protectionStatus(db: DatabaseSync, owner: string, cookie: string | null) {
  const hash = db.prepare("SELECT value FROM settings WHERE owner_id = ? AND key = 'protection_hash'").get(owner) as { value: string } | undefined;
  const gate = db.prepare("SELECT value FROM settings WHERE owner_id = ? AND key = 'gate_token'").get(owner) as { value: string } | undefined;
  const required = Boolean(hash?.value);
  const unlocked = required && !!cookie && !!gate?.value && safeEqual(cookie, gate.value);
  return { required, unlocked: required ? unlocked : true };
}

export function setProtection(db: DatabaseSync, owner: string, password: string) {
  const gate = randomBytes(24).toString("hex");
  writeSetting(db, owner, "protection_hash", hashPassword(password));
  writeSetting(db, owner, "gate_token", gate);
  return gate;
}

export function clearProtection(db: DatabaseSync, owner: string) {
  db.prepare("DELETE FROM settings WHERE owner_id = ? AND key IN ('protection_hash', 'gate_token')").run(owner);
}

export function unlockProtection(db: DatabaseSync, owner: string, password: string) {
  const hash = db.prepare("SELECT value FROM settings WHERE owner_id = ? AND key = 'protection_hash'").get(owner) as { value: string } | undefined;
  if (!hash || !verifyPassword(password, hash.value)) return null;
  const gate = randomBytes(24).toString("hex");
  writeSetting(db, owner, "gate_token", gate);
  return gate;
}

export function gateCookie(token: string, maxAge: number, secure = process.env.NODE_ENV === "production") {
  return `${GATE}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

export function readGate(req: Request) {
  const raw = req.headers.get("cookie") ?? "";
  const hits = raw.split(";").map((part) => part.trim()).filter((part) => part.startsWith(`${GATE}=`));
  const token = hits.length === 1 ? hits[0].slice(GATE.length + 1) : null;
  return token && /^[a-f0-9]{48}$/.test(token) ? token : null;
}

export function listWebhooks(db: DatabaseSync, owner: string) {
  return db.prepare(
    "SELECT id, url, events, created_at AS createdAt FROM webhooks WHERE owner_id = ? ORDER BY created_at DESC",
  ).all(owner);
}

export function identityProviders() {
  return [
    { name: "Password session", state: "active", detail: "Scrypt password and an httpOnly session cookie on this server." },
    { name: "Personal access tokens", state: "active", detail: "Bearer tokens are stored as SHA-256 hashes and shown once." },
    { name: "Device code", state: "active", detail: "A signed-in browser can approve a code. No password is typed into a shell." },
    { name: "Passkeys", state: "unavailable", detail: "WebAuthn is not configured on this server." },
    { name: "GitHub, GitLab, Google", state: "unavailable", detail: "No OAuth client id or secret is configured." },
    { name: "SAML and SCIM", state: "unavailable", detail: "No enterprise identity provider is configured." },
    { name: "Magic link email", state: "unavailable", detail: "No SMTP server is configured, so a link would not be delivered." },
    { name: "Mobile push", state: "unavailable", detail: "No APNs or FCM credentials are configured." },
  ];
}

function writeSetting(db: DatabaseSync, owner: string, key: string, value: string) {
  db.prepare(
    "INSERT INTO settings (owner_id, key, value) VALUES (?, ?, ?) ON CONFLICT(owner_id, key) DO UPDATE SET value = excluded.value",
  ).run(owner, key, value);
}

function safeEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
