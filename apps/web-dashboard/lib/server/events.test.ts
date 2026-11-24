import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

process.env.MOBILECLOUD_DB = join(mkdtempSync(join(tmpdir(), "mc-events-")), "t.db");

type SyncPage = {
  cursor: number;
  events: { event_type: string; sequence: number; previous_sequence: number; account_id: string; resource_id: string | null }[];
  more: boolean;
  latest: number;
  account_id: string;
};

async function signup(email: string, name: string): Promise<string> {
  const { handle } = await import("./api.ts");
  const { hashPassword, newId, openDb } = await import("./db.ts");
  openDb().prepare("INSERT INTO users (id,email,name,password_hash,role,created_at) VALUES (?,?,?,?,'member',?)")
    .run(newId(), email, name, hashPassword("correct-horse"), Date.now());
  const res = await handle(
    new Request("http://local/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "correct-horse" }),
    }),
    ["auth", "login"],
  );
  assert.equal(res.status, 200);
  return res.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ");
}

async function sync(cookie: string, cursor = 0, limit = 500): Promise<SyncPage> {
  const { handle } = await import("./api.ts");
  const res = await handle(
    new Request(`http://local/api/sync/changes?cursor=${cursor}&limit=${limit}`, { headers: { cookie } }),
    ["sync", "changes"],
  );
  assert.equal(res.status, 200);
  return (await res.json()) as SyncPage;
}

async function createProject(cookie: string, name: string): Promise<string> {
  const { handle } = await import("./api.ts");
  const res = await handle(
    new Request("http://local/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json", cookie, "x-mc-csrf": /mc_csrf=([a-f0-9]{64})/.exec(cookie)?.[1] ?? "" },
      body: JSON.stringify({ name, framework: "Next.js" }),
    }),
    ["projects"],
  );
  assert.equal(res.status, 201);
  const body = (await res.json()) as { id: string };
  return body.id;
}

test("GET /api/health advertises the realtime gateway without requiring auth", async () => {
  const { resetDb } = await import("./db.ts");
  resetDb();
  const { handle } = await import("./api.ts");
  const res = await handle(new Request("http://local/api/health"), ["health"]);
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    service: string;
    realtime: { transport: string; path: string; port: number; fallback: string };
  };
  assert.equal(body.service, "MobileCloud");
  assert.equal(body.realtime.transport, "websocket");
  assert.equal(body.realtime.path, "/api/realtime");
  assert.equal(body.realtime.fallback, "/api/sync/changes");
  assert.ok(body.realtime.port > 0);
});

test("a mutation appends an outbox row that a cursor sync replays exactly once", async () => {
  const { resetDb } = await import("./db.ts");
  resetDb();
  const cookie = await signup("sync-a@example.com", "Ada");

  const before = await sync(cookie, 0);
  const baseline = before.latest;

  const projectId = await createProject(cookie, "ledger");
  const page = await sync(cookie, baseline);

  const created = page.events.filter((event) => event.event_type === "project.created");
  assert.equal(created.length, 1);
  assert.equal(created[0].resource_id, projectId);
  assert.ok(created[0].sequence > baseline);
  assert.equal(page.cursor, created[0].sequence);

  // Idempotency: replaying from the same cursor yields an identical page, so a
  // client that reconnects and re-reads cannot double-apply anything.
  const replay = await sync(cookie, baseline);
  assert.deepEqual(replay.events, page.events);
  assert.equal(replay.cursor, page.cursor);

  // Nothing new happened, so syncing from the cursor is a no-op.
  const quiet = await sync(cookie, page.cursor);
  assert.equal(quiet.events.length, 0);
  assert.equal(quiet.cursor, page.cursor);
});

test("an offline client recovers every missed change in sequence order", async () => {
  const { resetDb, openDb } = await import("./db.ts");
  resetDb();
  const cookie = await signup("sync-b@example.com", "Grace");

  const start = (await sync(cookie, 0)).latest;

  // Simulate a 30-minute disconnect: the client is gone while the account
  // keeps changing. Nothing is lost because every change is durable.
  const names = ["one", "two", "three", "four", "five"];
  for (const name of names) await createProject(cookie, name);

  // Page through the backlog with a deliberately tiny limit to exercise the
  // `more` flag, exactly like a recovering device would.
  let cursor = start;
  const seen: string[] = [];
  for (let guard = 0; guard < 50; guard += 1) {
    const page = await sync(cookie, cursor, 2);
    for (const event of page.events) seen.push(event.event_type);
    cursor = page.cursor;
    if (!page.more) break;
  }

  assert.deepEqual(seen, names.map(() => "project.created"));

  // The persisted cursor reflects a fully caught-up state.
  const final = await sync(cookie, 0);
  assert.equal(final.cursor, final.latest);
  // Scope the durable-row check to this account: resetDb() detaches the
  // singleton but the temp file keeps earlier accounts' rows, so a global
  // count would be wrong.
  const row = openDb()
    .prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'project.created' AND owner_id = ?")
    .get(final.account_id) as { n: number };
  assert.equal(row.n, names.length);
});

test("cross-account isolation: a client only ever reads its own outbox", async () => {
  const { resetDb } = await import("./db.ts");
  resetDb();
  const alice = await signup("alice@example.com", "Alice");
  const bob = await signup("bob@example.com", "Bob");

  await createProject(alice, "alice-app");
  await createProject(bob, "bob-app");
  await createProject(bob, "bob-app-two");
  await createProject(alice, "alice-after-bob");

  const aliceView = await sync(alice, 0);
  const bobView = await sync(bob, 0);

  const aliceProjects = aliceView.events.filter((event) => event.event_type === "project.created");
  const bobProjects = bobView.events.filter((event) => event.event_type === "project.created");

  assert.equal(aliceProjects.length, 2);
  assert.equal(bobProjects.length, 2);
  assert.ok(aliceProjects[1].sequence > aliceProjects[0].sequence + 1);
  assert.equal(aliceProjects[1].previous_sequence, aliceProjects[0].sequence);
  const { handle } = await import("./api.ts");
  const overview = await handle(new Request("http://local/api/overview", { headers: { cookie: alice } }), ["overview"]);
  const snapshot = await overview.json() as { cursor: number; projects: unknown[] };
  assert.equal(snapshot.cursor, aliceProjects[1].sequence);
  assert.equal(snapshot.projects.length, 2);

  // Every delivered row belongs to the caller — never to the other account.
  const { openDb } = await import("./db.ts");
  const aliceId = openDb().prepare("SELECT id FROM users WHERE email = ?").get("alice@example.com") as { id: string };
  assert.ok(aliceView.events.every((event) => event.account_id === aliceId.id));
  assert.equal(aliceView.account_id, aliceId.id);
  assert.notEqual(aliceView.account_id, bobView.account_id);
});

test("an unauthenticated sync request is rejected with 401", async () => {
  const { resetDb } = await import("./db.ts");
  resetDb();
  const { handle } = await import("./api.ts");
  const res = await handle(new Request("http://local/api/sync/changes?cursor=0"), ["sync", "changes"]);
  assert.equal(res.status, 401);
});
