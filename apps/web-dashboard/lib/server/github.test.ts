import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openDb } from "./db.ts";
import {
  beginAuthorization,
  consumeAuthorization,
  deliveryDigest,
  findRepository,
  listRepositories,
  openSecret,
  parseWebhookEvent,
  ownersForRepository,
  saveConnection,
  sealSecret,
  syncRepositories,
  verifyWebhookSignature,
} from "./github.ts";

function freshDb() {
  const file = join(mkdtempSync(join(tmpdir(), "mc-github-")), "t.db");
  const db = openDb(file);
  db.prepare("INSERT INTO users (id, email, name, password_hash, role, plan, created_at) VALUES ('u1', 'a@b.co', 'A', '!', 'owner', 'community', ?)").run(Date.now());
  return db;
}

test("a webhook signature verifies only with the right secret", () => {
  const body = JSON.stringify({ repository: { id: 1, full_name: "acme/site" } });
  const secret = "shared-secret";
  const signature = `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
  assert.equal(verifyWebhookSignature(secret, body, signature), true);
  assert.equal(verifyWebhookSignature(secret, `${body} `, signature), false);
  assert.equal(verifyWebhookSignature("other-secret", body, signature), false);
  assert.equal(verifyWebhookSignature(secret, body, null), false);
  assert.equal(verifyWebhookSignature(secret, body, "sha1=abc"), false);
});

test("a webhook without a configured secret never verifies", () => {
  const body = "{}";
  const signature = `sha256=${createHmac("sha256", "").update(body, "utf8").digest("hex")}`;
  assert.equal(verifyWebhookSignature("", body, signature), false);
});

test("a sealed token opens again and a tampered one does not", () => {
  const db = freshDb();
  const sealed = sealSecret(db, "gho_secret_token");
  assert.notEqual(sealed, "gho_secret_token");
  assert.equal(openSecret(db, sealed), "gho_secret_token");
  const parts = sealed.split(".");
  parts[2] = `${parts[2].slice(0, -2)}AA`;
  assert.equal(openSecret(db, parts.join(".")), null);
  db.close();
});

test("an authorization state is single use", () => {
  const db = freshDb();
  const state = beginAuthorization(db, "u1");
  assert.equal(consumeAuthorization(db, state), "u1");
  assert.equal(consumeAuthorization(db, state), null);
  assert.equal(consumeAuthorization(db, "never-issued"), null);
  db.close();
});

test("a push, a pull request and a release are read apart", () => {
  const push = parseWebhookEvent({
    repository: { id: 7, full_name: "acme/site" },
    ref: "refs/heads/main",
    after: "abc123",
  });
  assert.equal(push?.kind, "push");
  assert.equal(push?.branch, "main");
  assert.equal(push?.commit, "abc123");

  const pull = parseWebhookEvent({
    repository: { id: 7, full_name: "acme/site" },
    ref: "refs/heads/feature",
    pull_request: { number: 42 },
    action: "opened",
  });
  assert.equal(pull?.kind, "pull_request");
  assert.equal(pull?.pullNumber, 42);
  assert.equal(pull?.action, "opened");

  const release = parseWebhookEvent({
    repository: { id: 7, full_name: "acme/site" },
    release: { tag_name: "v1.2.3" },
    after: "def456",
  });
  assert.equal(release?.kind, "release");
  assert.equal(release?.branch, "v1.2.3");

  assert.equal(parseWebhookEvent({}), null);
});

test("repositories are stored, listed and found by their GitHub identifier", () => {
  const db = freshDb();
  saveConnection(db, "u1", { id: 9, login: "ashutosh" }, { accessToken: "t", refreshToken: null, expiresAt: null, scopes: "repo" });
  syncRepositories(db, "u1", [
    {
      id: 11,
      full_name: "acme/site",
      name: "site",
      owner: { login: "acme" },
      private: false,
      default_branch: "main",
      language: "TypeScript",
      stargazers_count: 12,
      description: "The site",
      pushed_at: "2026-11-27T10:00:00Z",
      html_url: "https://github.com/acme/site",
    },
  ]);
  const listed = listRepositories(db, "u1");
  assert.equal(listed.length, 1);
  assert.equal(listed[0].fullName, "acme/site");
  assert.equal(listed[0].defaultBranch, "main");
  assert.equal(listed[0].stars, 12);
  assert.ok(findRepository(db, "u1", "11"));
  assert.ok(findRepository(db, "u1", "11:acme/site"));
  assert.equal(findRepository(db, "u1", "999"), null);
  assert.deepEqual(ownersForRepository(db, "11"), ["u1"]);
  db.close();
});

test("the same delivery always has the same digest", () => {
  const body = JSON.stringify({ repository: { id: 7, full_name: "acme/site" } });
  assert.equal(deliveryDigest(body), deliveryDigest(body));
  assert.notEqual(deliveryDigest(body), deliveryDigest(`${body} `));
});
