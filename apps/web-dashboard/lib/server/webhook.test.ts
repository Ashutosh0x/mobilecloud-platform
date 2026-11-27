import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { newId, openDb } from "./db.ts";
import { MAX_ATTEMPTS, backoffMs, deliverableHost, deliverPending, enqueueForEvent, listDeliveries, signature, subscribed } from "./webhook.ts";

const db = openDb(join(mkdtempSync(join(tmpdir(), "mc-wh-")), "t.db"));

function addWebhook(owner: string, url: string, events: string, secret = "s3cr3t"): string {
  const id = newId();
  db.prepare("INSERT INTO webhooks (id, owner_id, url, secret, events, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(id, owner, url, secret, events, Date.now());
  return id;
}

test("subscriptions match exact, wildcard, and prefix forms", () => {
  assert.equal(subscribed("*", "anything"), true);
  assert.equal(subscribed("project.created", "project.created"), true);
  assert.equal(subscribed("project.created", "project.deleted"), false);
  assert.equal(subscribed("project.*", "project.created"), true);
  assert.equal(subscribed("project.*", "deployment.created"), false);
  assert.equal(subscribed("a.created, b.deleted", "b.deleted"), true);
});

test("the signature is HMAC-SHA256 over `${timestamp}.${body}`", () => {
  const body = JSON.stringify({ ok: true });
  const expected = createHmac("sha256", "s3cr3t").update(`1700000000.${body}`).digest("hex");
  assert.equal(signature("s3cr3t", 1700000000, body), expected);
});

test("backoff grows exponentially and is capped", () => {
  assert.equal(backoffMs(1), 1000);
  assert.equal(backoffMs(2), 2000);
  assert.equal(backoffMs(3), 4000);
  assert.equal(backoffMs(10), 60000);
});

test("delivery fails closed on loopback and private targets", () => {
  assert.equal(deliverableHost("https://example.com/hook"), true);
  for (const url of ["https://localhost/h", "https://127.0.0.1/h", "https://10.0.0.5/h", "https://192.168.1.1/h", "https://172.16.0.1/h", "https://[::1]/h", "nonsense"]) {
    assert.equal(deliverableHost(url), false, `${url} must not be deliverable`);
  }
});

test("an event enqueues one delivery per subscribed webhook and never twice", () => {
  const owner = "wh-owner-enqueue";
  addWebhook(owner, "https://example.com/a", "project.created");
  addWebhook(owner, "https://example.com/b", "project.deleted");
  const first = enqueueForEvent(db, owner, "project.created", "evt-1", { id: "evt-1" });
  const second = enqueueForEvent(db, owner, "project.created", "evt-1", { id: "evt-1" });
  assert.equal(first, 1);
  assert.equal(second, 0);
  const rows = db.prepare("SELECT COUNT(*) AS n FROM webhook_deliveries WHERE owner_id = ?").get(owner);
  assert.equal(rows?.n, 1);
});

test("a reachable receiver is recorded as delivered and metered", async () => {
  db.prepare("DELETE FROM webhook_deliveries").run();
  const owner = "wh-owner-delivered";
  addWebhook(owner, "https://example.com/ok", "project.created");
  enqueueForEvent(db, owner, "project.created", "evt-2", { id: "evt-2" });
  const calls: string[] = [];
  const fakeFetch = (async (url: string | URL) => {
    calls.push(String(url));
    return new Response("ok", { status: 200 });
  }) as unknown as typeof fetch;

  const attempts = await deliverPending(db, { fetchImpl: fakeFetch, now: Date.now() + 1 });
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].status, "delivered");
  assert.deepEqual(calls, ["https://example.com/ok"]);
  const row = db.prepare("SELECT status, attempts FROM webhook_deliveries WHERE owner_id = ?").get(owner);
  assert.equal(row?.status, "delivered");
  const usage = db.prepare("SELECT COALESCE(SUM(qty), 0) AS qty FROM usage_events WHERE owner_id = ? AND meter = 'webhook_deliveries'").get(owner);
  assert.equal(usage?.qty, 1);
});

test("a failing receiver is retried, then marked failed once attempts are exhausted", async () => {
  db.prepare("DELETE FROM webhook_deliveries").run();
  const owner = "wh-owner-failed";
  addWebhook(owner, "https://example.com/down", "project.created");
  enqueueForEvent(db, owner, "project.created", "evt-3", { id: "evt-3" });
  const fakeFetch = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;

  const base = Date.now() + 1000;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    await deliverPending(db, { fetchImpl: fakeFetch, now: base + attempt * 120_000 });
  }
  const row = db.prepare("SELECT status, attempts, response_status FROM webhook_deliveries WHERE owner_id = ?").get(owner);
  assert.equal(row?.attempts, MAX_ATTEMPTS);
  assert.equal(row?.status, "failed");
  assert.equal(row?.response_status, 500);
  const log = listDeliveries(db, owner) as { status: string; attempts: number }[];
  assert.equal(log[0].status, "failed");
});

test("a delivery to a private target is refused without any network call", async () => {
  db.prepare("DELETE FROM webhook_deliveries").run();
  const owner = "wh-owner-private";
  addWebhook(owner, "https://127.0.0.1/hook", "project.created");
  enqueueForEvent(db, owner, "project.created", "evt-4", { id: "evt-4" });
  let called = false;
  const fakeFetch = (async () => { called = true; return new Response(null, { status: 200 }); }) as unknown as typeof fetch;
  const attempts = await deliverPending(db, { fetchImpl: fakeFetch, now: Date.now() + 1 });
  assert.equal(attempts[0].status, "failed");
  assert.equal(called, false);
});
