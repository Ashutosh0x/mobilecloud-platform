import type { DatabaseSync } from "node:sqlite";
import { newId } from "./db.ts";

/**
 * Usage metering.
 *
 * Meters are append-only counters (`usage_events`), written by the operation
 * they measure and read back per period. Storage is a gauge computed from the
 * rows that already exist (objects and databases). Limits come from the
 * environment (`MOBILECLOUD_QUOTA_<METER>`); with none configured a meter has
 * no ceiling, and `billing` stays off because no payment provider is wired.
 */

export const METERS = ["function_invocations", "workflow_runs", "webhook_deliveries", "object_bytes"] as const;
export type Meter = (typeof METERS)[number];

const UNITS: Record<Meter, string> = {
  function_invocations: "invocations",
  workflow_runs: "runs",
  webhook_deliveries: "deliveries",
  object_bytes: "bytes",
};

/** Adds [qty] to a counter. Call inside the same transaction as the operation. */
export function record(db: DatabaseSync, owner: string, meter: Meter, qty = 1, resourceId: string | null = null): void {
  if (!Number.isFinite(qty) || qty <= 0) return;
  db.prepare(
    "INSERT INTO usage_events (id, owner_id, meter, qty, resource_id, at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(newId(), owner, meter, Math.round(qty), resourceId, Date.now());
}

export type UsageMetric = { meter: Meter; unit: string; value: number; limit: number | null; over: boolean };
export type Usage = {
  periodStart: number;
  periodEnd: number;
  plan: string;
  metrics: UsageMetric[];
  billable: boolean;
  note: string;
};

/** Start of the current month in UTC, which is the metering period. */
export function periodStart(now = Date.now()): number {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
}

function limitFor(meter: Meter): number | null {
  const raw = Number(process.env[`MOBILECLOUD_QUOTA_${meter.toUpperCase()}`]);
  return Number.isFinite(raw) && raw >= 0 ? raw : null;
}

/** Current-period usage for a single meter, without building the whole report. */
export function meterUsage(db: DatabaseSync, owner: string, meter: Meter, now = Date.now()): number {
  if (meter === "object_bytes") {
    const stored = db.prepare("SELECT COALESCE(SUM(bytes), 0) AS bytes FROM objects WHERE owner_id = ?").get(owner) as { bytes: number };
    return Number(stored.bytes);
  }
  const row = db.prepare(
    "SELECT COALESCE(SUM(qty), 0) AS qty FROM usage_events WHERE owner_id = ? AND meter = ? AND at >= ?",
  ).get(owner, meter, periodStart(now)) as { qty: number };
  return Number(row.qty);
}

export type QuotaBreach = { meter: Meter; limit: number; used: number; requested: number };

/**
 * The spend cap: a per-owner, per-meter ceiling for the current period.
 *
 * Returns a breach when recording [qty] more would push a configured limit
 * over the top, otherwise null. A meter with no configured limit is never
 * capped (nothing is invoiced because no payment provider is wired). Enforcing
 * the cap is the caller's job — a synchronous API call rejects with 429.
 */
export function quotaBreach(db: DatabaseSync, owner: string, meter: Meter, qty = 1, now = Date.now()): QuotaBreach | null {
  const limit = limitFor(meter);
  if (limit === null) return null;
  const used = meterUsage(db, owner, meter, now);
  return used + qty > limit ? { meter, limit, used, requested: qty } : null;
}

/** Human-readable cap message shared by the API guard and the usage report. */
export function quotaMessage(breach: QuotaBreach): string {
  return `Spend cap reached: ${breach.used} of ${breach.limit} ${UNITS[breach.meter]} used this period. Raise MOBILECLOUD_QUOTA_${breach.meter.toUpperCase()} to allow more.`;
}

export function collectUsage(db: DatabaseSync, owner: string, plan: string, now = Date.now()): Usage {
  const start = periodStart(now);
  const counters = db.prepare(
    "SELECT meter, COALESCE(SUM(qty), 0) AS qty FROM usage_events WHERE owner_id = ? AND at >= ? GROUP BY meter",
  ).all(owner, start) as { meter: string; qty: number }[];
  const counted = new Map(counters.map((row) => [row.meter, Number(row.qty)]));
  const stored = db.prepare("SELECT COALESCE(SUM(bytes), 0) AS bytes FROM objects WHERE owner_id = ?").get(owner) as { bytes: number };

  const metrics: UsageMetric[] = METERS.map((meter) => {
    const value = meter === "object_bytes" ? Number(stored.bytes) : counted.get(meter) ?? 0;
    const limit = limitFor(meter);
    return { meter, unit: UNITS[meter], value, limit, over: limit !== null && value > limit };
  });

  return {
    periodStart: start,
    periodEnd: now,
    plan,
    metrics,
    billable: false,
    note: limitFor("function_invocations") !== null
      ? "Counters are measured from this server's own operations. No payment provider is configured, so nothing is invoiced."
      : "Counters are measured from this server's own operations. No quota is configured and no payment provider is wired, so nothing is invoiced.",
  };
}
