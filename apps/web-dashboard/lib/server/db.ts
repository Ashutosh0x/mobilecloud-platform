import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'community',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  framework TEXT NOT NULL,
  target TEXT NOT NULL,
  repo_url TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(owner_id, name)
);
CREATE TABLE IF NOT EXISTS deployments (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  status TEXT NOT NULL,
  note TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS domains (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  host TEXT NOT NULL,
  status TEXT NOT NULL,
  detail TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS db_files (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(owner_id, name)
);
CREATE TABLE IF NOT EXISTS functions (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  route TEXT NOT NULL,
  invocations INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS objects (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  bucket TEXT NOT NULL,
  key TEXT NOT NULL,
  path TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS logs (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  level TEXT NOT NULL,
  source TEXT NOT NULL,
  message TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  email_sent INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  owner_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (owner_id, key)
);
CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY,
  owner_id TEXT,
  path TEXT NOT NULL,
  status INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  at INTEGER NOT NULL,
  user_agent TEXT,
  host TEXT,
  ja4 TEXT
);
CREATE TABLE IF NOT EXISTS firewall_rules (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  action TEXT NOT NULL,
  match_key TEXT NOT NULL,
  match_op TEXT NOT NULL,
  match_value TEXT NOT NULL,
  header_name TEXT,
  limit_count INTEGER,
  window_sec INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS firewall_events (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  rule_id TEXT,
  action TEXT NOT NULL,
  path TEXT NOT NULL,
  ip TEXT NOT NULL,
  at INTEGER NOT NULL,
  user_agent TEXT,
  host TEXT,
  ja4 TEXT
);
CREATE TABLE IF NOT EXISTS vitals (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  metric TEXT NOT NULL,
  value REAL NOT NULL,
  path TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS builds (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  target TEXT NOT NULL,
  status TEXT NOT NULL,
  note TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS workflow_runs (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  status TEXT NOT NULL,
  note TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS drives (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS access_tokens (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  token_hash TEXT UNIQUE NOT NULL,
  prefix TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  last_used INTEGER
);
CREATE TABLE IF NOT EXISTS device_codes (
  id TEXT PRIMARY KEY,
  device_hash TEXT UNIQUE NOT NULL,
  user_code TEXT NOT NULL,
  owner_id TEXT,
  status TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
-- Short-lived, single-use QR pairing sessions. A signed-in browser creates one
-- and renders its secrets as a QR code; an Android device scans it and
-- explicitly approves. Only the SHA-256 hash of the pairing secret is stored,
-- and the row is consumed exactly once (see lib/server/pairing.ts).
CREATE TABLE IF NOT EXISTS pairing_sessions (
  id TEXT PRIMARY KEY,
  secret_hash TEXT UNIQUE NOT NULL,
  user_code TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  status TEXT NOT NULL,
  method TEXT NOT NULL DEFAULT 'qr',
  browser_name TEXT,
  browser_platform TEXT,
  browser_user_agent TEXT,
  browser_ip TEXT,
  scan_device_name TEXT,
  scan_device_platform TEXT,
  scan_app_version TEXT,
  fail_reason TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  scanned_at INTEGER,
  approved_at INTEGER,
  connected_at INTEGER,
  device_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_pairing_owner ON pairing_sessions (owner_id, created_at);
-- Devices that have been linked through QR pairing. Each row references the
-- durable access token that was issued at approval time, so bearer
-- authentication continues to flow through the existing access_tokens table.
CREATE TABLE IF NOT EXISTS connected_devices (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  token_id TEXT,
  pairing_id TEXT,
  name TEXT NOT NULL,
  platform TEXT NOT NULL,
  app_version TEXT,
  method TEXT NOT NULL DEFAULT 'qr',
  created_at INTEGER NOT NULL,
  paired_at INTEGER NOT NULL,
  last_active INTEGER,
  last_ip TEXT,
  revoked INTEGER NOT NULL DEFAULT 0,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_devices_owner ON connected_devices (owner_id, revoked);
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  read INTEGER NOT NULL DEFAULT 0,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS webhooks (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  url TEXT NOT NULL,
  secret TEXT NOT NULL,
  events TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
-- Durable event outbox. Every mutation appends one row inside the same
-- transaction as the write it describes, so a dropped WebSocket frame can
-- never lose a change: clients recover by reading this table through
-- GET /api/sync/changes?cursor=N. The seq column is the global, monotonically
-- increasing ordering token used for cursor sync and duplicate detection.
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT UNIQUE NOT NULL,
  owner_id TEXT NOT NULL,
  type TEXT NOT NULL,
  resource_id TEXT,
  schema_version INTEGER NOT NULL DEFAULT 1,
  actor TEXT,
  payload TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_owner_seq ON events (owner_id, seq);
CREATE TABLE IF NOT EXISTS event_cursors (
  consumer TEXT PRIMARY KEY,
  seq INTEGER NOT NULL,
  at INTEGER NOT NULL
);
`;

let singleton: DatabaseSync | null = null;

export function resetDb() {
  singleton?.close();
  singleton = null;
}

export function openDb(file?: string): DatabaseSync {
  if (!file && singleton) return singleton;
  const target = file ?? process.env.MOBILECLOUD_DB ?? join(dataRoot(), "mobilecloud.db");
  mkdirSync(dirname(target), { recursive: true });
  const db = new DatabaseSync(target);
  try {
    db.exec("PRAGMA busy_timeout = 4000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL;");
    db.exec("BEGIN IMMEDIATE");
    db.exec(SCHEMA);
    migrate(db);
    if (!file) ensureOperator(db);
    db.exec("COMMIT");
    if (!file) singleton = db;
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function migrate(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS control_plane_migrations (version INTEGER PRIMARY KEY);`);
  if (!db.prepare("SELECT 1 FROM control_plane_migrations WHERE version = 1").get()) migrateCredentialBindings(db);
  if (!db.prepare("SELECT 1 FROM control_plane_migrations WHERE version = 2").get()) {
    db.exec(`
      ALTER TABLE pairing_sessions ADD COLUMN scan_hash TEXT;
      UPDATE pairing_sessions SET status = 'REVOKED', fail_reason = 'credential_upgrade'
        WHERE status IN ('SCANNED','AWAITING_APPROVAL','APPROVED');
      INSERT INTO control_plane_migrations (version) VALUES (2);
    `);
  }
  if (!db.prepare("SELECT 1 FROM control_plane_migrations WHERE version = 3").get()) {
    db.prepare(`UPDATE access_tokens SET expires_at = MIN(expires_at, ?)
      WHERE id IN (SELECT token_id FROM connected_devices WHERE token_id IS NOT NULL)`).run(Date.now() + 30 * 86_400_000);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_objects_key ON objects (owner_id, bucket, key);
      CREATE INDEX IF NOT EXISTS idx_requests_time ON requests (at);
      INSERT INTO control_plane_migrations (version) VALUES (3);
    `);
  }
}

function migrateCredentialBindings(db: DatabaseSync) {
  for (const [table, columns] of Object.entries({
    sessions: { id: "TEXT", user_agent: "TEXT", created_at: "INTEGER", csrf: "TEXT", device_id: "TEXT" },
    requests: { user_agent: "TEXT", host: "TEXT", ja4: "TEXT" },
    firewall_events: { user_agent: "TEXT", host: "TEXT", ja4: "TEXT" },
    projects: { repo_url: "TEXT" },
  })) {
    const present = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
    for (const [name, type] of Object.entries(columns)) {
      if (!present.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
    }
  }
  // Older sessions cannot be reliably attributed to a linked device. Require
  // every such session to sign in again, and retire in-flight legacy codes.
  db.exec(`
    DELETE FROM sessions;
    DELETE FROM device_codes;
    UPDATE pairing_sessions SET status = 'REVOKED', fail_reason = 'credential_upgrade'
      WHERE status IN ('WAITING_FOR_SCAN','SCANNED','AWAITING_APPROVAL','APPROVED');
    DELETE FROM access_tokens WHERE expires_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_sessions_device ON sessions (device_id);
    CREATE INDEX IF NOT EXISTS idx_requests_owner_at ON requests (owner_id, at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_device_codes_display ON device_codes (user_code);
  `);
  // Conservatively retire the old publicly seeded account, without embedding
  // its former password. An operator may recover it with explicit bootstrap env.
  const legacy = db.prepare("SELECT id FROM users WHERE email = ?").get("ashutosh@gmail.com") as { id: string } | undefined;
  if (legacy) {
    db.prepare("UPDATE users SET password_hash = 'reset-required' WHERE id = ?").run(legacy.id);
    db.prepare("DELETE FROM access_tokens WHERE owner_id = ?").run(legacy.id);
    db.prepare("UPDATE connected_devices SET revoked = 1, revoked_at = ? WHERE owner_id = ?").run(Date.now(), legacy.id);
    db.prepare("DELETE FROM webhooks WHERE owner_id = ?").run(legacy.id);
  }
  db.exec("INSERT INTO control_plane_migrations (version) VALUES (1)");
}

/** Local operator provisioning only. No remotely callable setup and no password logs. */
function ensureOperator(db: DatabaseSync) {
  const password = process.env.MOBILECLOUD_BOOTSTRAP_PASSWORD?.trim();
  if (!password) return;
  const email = (process.env.MOBILECLOUD_BOOTSTRAP_EMAIL?.trim() || "owner@mobilecloud.local").toLowerCase();
  if (!/^[^\s@]+@[^\s@]+$/.test(email) || email.length > 254 || password.length < 12 || password.length > 256 || isRetiredPassword(password)) {
    throw new Error("Invalid operator bootstrap configuration");
  }
  const reset = db.prepare("SELECT id FROM users WHERE email = ? AND password_hash = 'reset-required'").get(email) as { id: string } | undefined;
  if (reset) {
    db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hashPassword(password), reset.id);
  } else if (!db.prepare("SELECT 1 FROM users LIMIT 1").get()) {
    db.prepare("INSERT INTO users (id, email, name, password_hash, role, plan, created_at) VALUES (?, ?, 'Owner', ?, 'owner', 'community', ?)")
      .run(newId(), email, hashPassword(password), Date.now());
  }
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 32).toString("hex");
  return `${salt}:${hash}`;
}

export function isRetiredPassword(password: string): boolean {
  return tokenHash(password) === "477b79e5e6c6faff2f40c818304100c8e4d235cb0f2ba9551ce8cc79359227dc";
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const next = scryptSync(password, salt, 32);
  const prev = Buffer.from(hash, "hex");
  if (next.length !== prev.length) return false;
  return timingSafeEqual(next, prev);
}

export function newId(): string {
  return randomBytes(16).toString("hex");
}

export function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function dataRoot(): string {
  const root = process.env.MOBILECLOUD_DATA_ROOT
    ? resolve(process.env.MOBILECLOUD_DATA_ROOT)
    : process.env.MOBILECLOUD_DB ? dirname(resolve(process.env.MOBILECLOUD_DB)) : join(process.cwd(), "data");
  if (!existsSync(root)) mkdirSync(root, { recursive: true });
  return root;
}
