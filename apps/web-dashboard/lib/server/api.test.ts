import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

process.env.MOBILECLOUD_DB = join(mkdtempSync(join(tmpdir(), "mc-api-")), "t.db");

test("signup, project, and deploy stay blocked without a builder", async () => {
  const { resetDb } = await import("./db.ts");
  resetDb();
  const { handle } = await import("./api.ts");
  const signup = await handle(new Request("http://local/api/auth/signup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Ada", email: "ada@example.com", password: "correct-horse" }),
  }), ["auth", "signup"]);
  assert.equal(signup.status, 200);
  const cookie = signup.headers.get("set-cookie") ?? "";
  assert.match(cookie, /mc_session=/);
  const session = cookie.split(";")[0];

  const created = await handle(new Request("http://local/api/projects", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: session },
    body: JSON.stringify({ name: "ledger", framework: "Next.js" }),
  }), ["projects"]);
  assert.equal(created.status, 201);

  const overview = await handle(new Request("http://local/api/overview", { headers: { cookie: session } }), ["overview"]);
  const body = await overview.json() as { projects: { id: string }[]; deployments: unknown[] };
  assert.equal(body.projects.length, 1);
  assert.equal(body.deployments.length, 0);

  const deploy = await handle(new Request("http://local/api/deployments", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: session },
    body: JSON.stringify({ projectId: body.projects[0].id }),
  }), ["deployments"]);
  assert.equal(deploy.status, 201);
  const recorded = await deploy.json() as { status: string };
  assert.equal(recorded.status, "blocked");
});

test("access tokens are stored as hashes and device codes stay pending until approved", async () => {
  const { resetDb, openDb } = await import("./db.ts");
  resetDb();
  const { handle } = await import("./api.ts");
  const signup = await handle(new Request("http://local/api/auth/signup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Ada", email: "ada2@example.com", password: "correct-horse" }),
  }), ["auth", "signup"]);
  const session = (signup.headers.get("set-cookie") ?? "").split(";")[0];

  const created = await handle(new Request("http://local/api/tokens", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: session },
    body: JSON.stringify({ name: "ci", days: 7 }),
  }), ["tokens"]);
  assert.equal(created.status, 201);
  const issued = await created.json() as { token: string };
  assert.match(issued.token, /^mc_/);
  const stored = openDb().prepare("SELECT token_hash FROM access_tokens").all() as { token_hash: string }[];
  assert.equal(stored.some((row) => row.token_hash === issued.token), false);

  const me = await handle(new Request("http://local/api/auth/me", {
    headers: { authorization: `Bearer ${issued.token}` },
  }), ["auth", "me"]);
  assert.equal(me.status, 200);

  const started = await handle(new Request("http://local/api/auth/device/code", { method: "POST" }), ["auth", "device", "code"]);
  const codes = await started.json() as { userCode: string; deviceCode: string };
  const pending = await handle(new Request("http://local/api/auth/device/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceCode: codes.deviceCode }),
  }), ["auth", "device", "token"]);
  assert.equal(pending.status, 202);

  const approved = await handle(new Request("http://local/api/device/approve", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: session },
    body: JSON.stringify({ userCode: codes.userCode }),
  }), ["device", "approve"]);
  assert.equal(approved.status, 200);

  const done = await handle(new Request("http://local/api/auth/device/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceCode: codes.deviceCode }),
  }), ["auth", "device", "token"]);
  assert.equal(done.status, 200);
  const deviceToken = await done.json() as { token: string };
  assert.match(deviceToken.token, /^mc_/);
});

test("a JA4 rule matches only a well-formed header and does not invent a digest", async () => {
  const { resetDb } = await import("./db.ts");
  resetDb();
  const { handle } = await import("./api.ts");
  const signup = await handle(new Request("http://local/api/auth/signup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Ada", email: "ada3@example.com", password: "correct-horse" }),
  }), ["auth", "signup"]);
  const session = (signup.headers.get("set-cookie") ?? "").split(";")[0];
  const digest = "t13d1516h2_8daaf6152771_02713d6af862";
  const rule = await handle(new Request("http://local/api/firewall", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: session },
    body: JSON.stringify({ name: "ja4", action: "deny", matchKey: "ja4", matchOp: "equals", matchValue: digest }),
  }), ["firewall"]);
  assert.equal(rule.status, 201);

  const probe = (ja4?: string) => handle(new Request("http://local/api/team", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: session, ...(ja4 ? { "x-ja4-fingerprint": ja4 } : {}) },
    body: JSON.stringify({ name: "", email: "" }),
  }), ["team"]);
  assert.equal((await probe()).status, 400);
  assert.equal((await probe(digest)).status, 403);
  assert.equal((await probe("not-a-digest")).status, 400);

  const overview = await handle(new Request("http://local/api/overview", { headers: { cookie: session } }), ["overview"]);
  const body = await overview.json() as { firewall: { traffic: { topJa4: { value: string }[]; notes: string[] } } };
  assert.deepEqual(body.firewall.traffic.topJa4.map((row) => row.value), [digest]);
  assert.equal(body.firewall.traffic.notes.some((note) => note.includes("ASN")), true);
});
