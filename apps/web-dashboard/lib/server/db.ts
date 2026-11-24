import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
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
  singleton = null;
}

export function openDb(file?: string): DatabaseSync {
  if (!file && singleton) return singleton;
  const target = file ?? process.env.MOBILECLOUD_DB ?? join(process.cwd(), "data", "mobilecloud.db");
  mkdirSync(dirname(target), { recursive: true });
  const db = new DatabaseSync(target);
  db.exec("PRAGMA journal_mode = WAL;");
  // The realtime gateway is a second process writing to the same file (its
  // event cursor), so writers must wait rather than fail with SQLITE_BUSY.
  db.exec("PRAGMA busy_timeout = 4000;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  for (const sql of [
    "ALTER TABLE sessions ADD COLUMN id TEXT",
    "ALTER TABLE sessions ADD COLUMN user_agent TEXT",
    "ALTER TABLE sessions ADD COLUMN created_at INTEGER",
    "ALTER TABLE requests ADD COLUMN user_agent TEXT",
    "ALTER TABLE requests ADD COLUMN host TEXT",
    "ALTER TABLE requests ADD COLUMN ja4 TEXT",
    "ALTER TABLE firewall_events ADD COLUMN user_agent TEXT",
    "ALTER TABLE firewall_events ADD COLUMN host TEXT",
    "ALTER TABLE firewall_events ADD COLUMN ja4 TEXT",
  ]) {
    try { db.exec(sql); } catch { /* column already exists */ }
  }
  if (!file) {
    ensureDefaultUser(db);
    singleton = db;
  }
  return db;
}

function ensureDefaultUser(db: DatabaseSync) {
  const email = "ashutosh@gmail.com";
  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
  if (existing) return;
  const count = db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number };
  db.prepare(
    "INSERT INTO users (id, email, name, password_hash, role, plan, created_at) VALUES (?, ?, 'Ashutosh', ?, ?, 'community', ?)",
  ).run(newId(), email, hashPassword("ashutosh@123456@1"), count.n === 0 ? "owner" : "member", Date.now());
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 32).toString("hex");
  return `${salt}:${hash}`;
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
  const root = join(process.cwd(), "data");
  if (!existsSync(root)) mkdirSync(root, { recursive: true });
  return root;
}
