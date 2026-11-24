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
