import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { hashPassword, openDb, verifyPassword } from "./db.ts";

test("password hash verifies and rejects a wrong password", () => {
  const stored = hashPassword("correct-horse");
  assert.equal(verifyPassword("correct-horse", stored), true);
  assert.equal(verifyPassword("wrong-horse", stored), false);
});

test("schema creates a user row", () => {
  const file = join(mkdtempSync(join(tmpdir(), "mc-")), "t.db");
  const db = openDb(file);
  db.prepare(
    "INSERT INTO users (id, email, name, password_hash, role, plan, created_at) VALUES ('u1', 'a@b.co', 'A', 'x', 'owner', 'community', 1)",
  ).run();
  const row = db.prepare("SELECT email FROM users WHERE id = 'u1'").get() as { email: string };
  assert.equal(row.email, "a@b.co");
  db.close();
});

test("credential migration invalidates unattributable sessions and the legacy account once", () => {
  const file = join(mkdtempSync(join(tmpdir(), "mc-legacy-")), "legacy.db");
  const legacy = new DatabaseSync(file);
  legacy.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE, name TEXT, password_hash TEXT, role TEXT, plan TEXT, created_at INTEGER);
    CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL);
    INSERT INTO sessions VALUES ('legacy-session', 'legacy', 2000000000000);
  `);
  legacy.prepare("INSERT INTO users VALUES ('legacy', ?, 'Owner', ?, 'owner', 'community', 1)")
    .run("ashutosh@gmail.com", hashPassword("legacy-fixture-only"));
  legacy.close();

  const db = openDb(file);
  assert.equal(db.prepare("SELECT password_hash FROM users WHERE id = 'legacy'").get()?.password_hash, "reset-required");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sessions").get()?.n, 0);
  db.exec("INSERT INTO sessions (token_hash, user_id, expires_at, csrf) VALUES ('new-session', 'legacy', 2000000000000, 'test')");
  db.close();

  const reopened = openDb(file);
  assert.equal(reopened.prepare("SELECT COUNT(*) AS n FROM sessions").get()?.n, 1);
  reopened.close();
});

test("the domain lifecycle migration upgrades a legacy record once and is idempotent", () => {
  const file = join(mkdtempSync(join(tmpdir(), "mc-domains-legacy-")), "legacy.db");
  // A database from before v10: the record-only `domains` table, with the
  // earlier migrations already recorded so only v10 runs.
  const legacy = new DatabaseSync(file);
  legacy.exec(`
    CREATE TABLE control_plane_migrations (version INTEGER PRIMARY KEY);
    INSERT INTO control_plane_migrations (version) VALUES (1),(2),(3),(4),(5),(6),(7),(8),(9);
    CREATE TABLE domains (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, project_id TEXT NOT NULL,
      host TEXT NOT NULL, status TEXT NOT NULL, detail TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    INSERT INTO domains VALUES ('d1', 'u1', 'p1', 'app.example.com', 'recorded', 'Saved locally.', 1700000000000);
  `);
  legacy.close();

  const db = openDb(file);
  const row = db.prepare(
    "SELECT status, dns_status, ssl_status, health_status, verification_method, created_at, updated_at FROM domains WHERE id = 'd1'",
  ).get() as {
    status: string; dns_status: string; ssl_status: string; health_status: string;
    verification_method: string; created_at: number; updated_at: number;
  };
  // `recorded` becomes the honest `pending_dns` with unknown signals — never a
  // false success — and the original creation time is preserved.
  assert.equal(row.status, "pending_dns");
  assert.equal(row.dns_status, "pending");
  assert.equal(row.ssl_status, "none");
  assert.equal(row.health_status, "unknown");
  assert.equal(row.verification_method, "cname");
  assert.equal(row.created_at, 1700000000000);
  assert.equal(row.updated_at, 1700000000000);
  db.close();

  // Re-opening must not re-run v10 or disturb the migrated row.
  const reopened = openDb(file);
  assert.equal(reopened.prepare("SELECT COUNT(*) AS n FROM control_plane_migrations WHERE version = 10").get()?.n, 1);
  const again = reopened.prepare("SELECT status, updated_at FROM domains WHERE id = 'd1'").get() as { status: string; updated_at: number };
  assert.equal(again.status, "pending_dns");
  assert.equal(again.updated_at, 1700000000000);
  reopened.close();
});
