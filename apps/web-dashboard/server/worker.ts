#!/usr/bin/env node
/**
 * MobileCloud background worker.
 *
 * Drains the durable webhook delivery queue (`webhook_deliveries`) that
 * `events.publish()` fills inside the same transaction as every mutation. It
 * signs each request, retries with exponential backoff, and stops after
 * `MAX_ATTEMPTS`. It also prunes the event outbox on the same schedule.
 *
 * Why a separate process: the Next.js API request path must not block on an
 * outbound HTTP call to a third party. Both processes read the same WAL
 * SQLite file, so there is exactly one source of truth.
 */
import { openDb } from "../lib/server/db.ts";
import { prune } from "../lib/server/events.ts";
import { deliverPending } from "../lib/server/webhook.ts";

const INTERVAL_MS = clamp(Number(process.env.MOBILECLOUD_WORKER_INTERVAL_MS ?? 2_000), 250, 60_000);
const BATCH = clamp(Number(process.env.MOBILECLOUD_WORKER_BATCH ?? 20), 1, 100);
const PRUNE_EVERY = 60;

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function log(level: string, message: string, extra?: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), level, service: "worker", message, ...(extra ?? {}) })}\n`);
}

const db = openDb();
let running = false;
let ticks = 0;

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const attempts = await deliverPending(db, { limit: BATCH });
    for (const attempt of attempts) {
      log(attempt.status === "failed" ? "warn" : "info", "webhook delivery", {
        delivery: attempt.id, status: attempt.status, response: attempt.responseStatus, error: attempt.error,
      });
    }
    ticks += 1;
    if (ticks % PRUNE_EVERY === 0) prune(db);
  } catch (error) {
    log("error", "worker tick failed", { error: error instanceof Error ? error.message : "unknown error" });
  } finally {
    running = false;
  }
}

// The timer is deliberately *not* unref'd. An unreferenced timer does not
// keep the event loop alive, so the worker printed its banner and exited
// immediately, leaving the webhook delivery queue undrained while the
// supervisor restarted it in a loop.
const timer = setInterval(() => { void tick(); }, INTERVAL_MS);

process.on("SIGINT", () => { clearInterval(timer); process.exit(0); });
process.on("SIGTERM", () => { clearInterval(timer); process.exit(0); });

log("info", "worker started", { intervalMs: INTERVAL_MS, batch: BATCH });
