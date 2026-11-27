import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { newId, openDb } from "./db.ts";
import { METERS, collectUsage, periodStart, record } from "./metering.ts";

const db = openDb(join(mkdtempSync(join(tmpdir(), "mc-meter-")), "t.db"));

test("counters accumulate from this server's own operations", () => {
  const owner = "meter-owner-1";
  const now = Date.now();
  record(db, owner, "function_invocations", 1);
  record(db, owner, "function_invocations", 1);
  record(db, owner, "workflow_runs", 3);
  const usage = collectUsage(db, owner, "community", now);
  const byMeter = Object.fromEntries(usage.metrics.map((metric) => [metric.meter, metric.value]));
  assert.equal(byMeter.function_invocations, 2);
  assert.equal(byMeter.workflow_runs, 3);
  assert.equal(usage.billable, false);
  assert.equal(usage.metrics.length, METERS.length);
});

test("only events inside the current UTC month are counted", () => {
  const owner = "meter-owner-2";
  const now = Date.now();
  const start = periodStart(now);
  const insert = (at: number) => db.prepare("INSERT INTO usage_events (id, owner_id, meter, qty, resource_id, at) VALUES (?, ?, 'function_invocations', 1, NULL, ?)")
    .run(newId(), owner, at);
  insert(start - 1);
  insert(start);
  const usage = collectUsage(db, owner, "community", now);
  assert.equal(usage.metrics.find((metric) => metric.meter === "function_invocations")?.value, 1);
  assert.equal(usage.periodStart, start);
});

test("storage is a gauge read from the objects table, not a counter", () => {
  const owner = "meter-owner-3";
  const add = (bytes: number) => db.prepare("INSERT INTO objects (id, owner_id, bucket, key, path, bytes, created_at) VALUES (?, ?, 'b', ?, ?, ?, ?)")
    .run(newId(), owner, newId(), `/tmp/${newId()}`, bytes, Date.now());
  add(1000);
  add(2500);
  const usage = collectUsage(db, owner, "community", Date.now());
  assert.equal(usage.metrics.find((metric) => metric.meter === "object_bytes")?.value, 3500);
});

test("a configured quota flags a meter as over its limit", (t) => {
  const owner = "meter-owner-4";
  const previous = process.env.MOBILECLOUD_QUOTA_FUNCTION_INVOCATIONS;
  t.after(() => { if (previous === undefined) delete process.env.MOBILECLOUD_QUOTA_FUNCTION_INVOCATIONS; else process.env.MOBILECLOUD_QUOTA_FUNCTION_INVOCATIONS = previous; });
  process.env.MOBILECLOUD_QUOTA_FUNCTION_INVOCATIONS = "2";
  record(db, owner, "function_invocations", 3);
  const usage = collectUsage(db, owner, "community", Date.now());
  const metric = usage.metrics.find((item) => item.meter === "function_invocations");
  assert.equal(metric?.limit, 2);
  assert.equal(metric?.over, true);
  // No payment provider is wired, so a breach is still not billable.
  assert.equal(usage.billable, false);
});
