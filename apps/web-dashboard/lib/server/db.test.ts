import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
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
});
