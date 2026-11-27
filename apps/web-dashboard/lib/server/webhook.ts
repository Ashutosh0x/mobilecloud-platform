import { createHmac } from "node:crypto";
import { isIP } from "node:net";
import type { DatabaseSync } from "node:sqlite";
import { newId } from "./db.ts";
import { record as recordUsage } from "./metering.ts";

/**
 * Outbound webhook delivery.
 *
 * `enqueueForEvent()` runs inside the same transaction as the event it
 * describes (it is called from `events.publish()`), so the queue row and the
 * event commit together. `(webhook_id, event_id)` is unique, so a retried or
 * redelivered event can never be sent twice. `deliverPending()` is the worker:
 * it signs each request with the webhook secret, retries with exponential
 * backoff, and records the terminal outcome.
 */

export const MAX_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;
const REQUEST_TIMEOUT_MS = 5_000;

export type DeliveryRow = {
  id: string;
  owner_id: string;
  webhook_id: string;
  event_id: string;
  event_type: string;
  payload: string;
  status: string;
  attempts: number;
  response_status: number | null;
  last_error: string | null;
  next_attempt_at: number;
};

export function subscribed(events: string, type: string): boolean {
  return events
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean)
    .some((token) => {
      if (token === "*") return true;
      if (token.endsWith(".*")) return type.startsWith(token.slice(0, -1));
      return token === type;
    });
}

/** Enqueue one delivery per subscribed webhook. Safe to call twice for the same event. */
export function enqueueForEvent(
  db: DatabaseSync,
  owner: string,
  eventType: string,
  eventId: string,
  payload: Record<string, unknown>,
): number {
  const hooks = db.prepare("SELECT id, events FROM webhooks WHERE owner_id = ?").all(owner) as { id: string; events: string }[];
  const now = Date.now();
  let queued = 0;
  for (const hook of hooks) {
    if (!subscribed(hook.events, eventType)) continue;
    const result = db.prepare(
      `INSERT OR IGNORE INTO webhook_deliveries
        (id, owner_id, webhook_id, event_id, event_type, payload, status, attempts, next_attempt_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)`,
    ).run(newId(), owner, hook.id, eventId, eventType, JSON.stringify(payload ?? {}), now, now, now);
    queued += Number(result.changes);
  }
  return queued;
}

/** Signs `${timestamp}.${body}` so a receiver can reject replays outside a window. */
export function signature(secret: string, timestamp: number, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

export function backoffMs(attempts: number): number {
  return Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1));
}

/** Fails closed on loopback/private targets unless explicitly opted in for local testing. */
export function deliverableHost(rawUrl: string): boolean {
  let host: string;
  try {
    host = new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  const privateHost = host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")
    || (isIP(bare) === 4 && (/^10\./.test(bare) || /^127\./.test(bare) || /^192\.168\./.test(bare) || /^169\.254\./.test(bare) || /^172\.(1[6-9]|2\d|3[01])\./.test(bare)))
    || (isIP(bare) === 6 && (bare === "::1" || bare.startsWith("fe80:") || bare.startsWith("fc") || bare.startsWith("fd")));
  return !privateHost || process.env.MOBILECLOUD_WEBHOOK_ALLOW_PRIVATE === "1";
}

export type DeliveryAttempt = {
  id: string;
  status: "delivered" | "pending" | "failed" | "skipped";
  responseStatus: number | null;
  error: string | null;
};

export async function deliverPending(
  db: DatabaseSync,
  options: { limit?: number; now?: number; fetchImpl?: typeof fetch } = {},
): Promise<DeliveryAttempt[]> {
  const now = options.now ?? Date.now();
  const limit = Math.max(1, Math.min(100, options.limit ?? 20));
  const doFetch = options.fetchImpl ?? fetch;
  const rows = db.prepare(
    `SELECT id, owner_id, webhook_id, event_id, event_type, payload, status, attempts, response_status, last_error, next_attempt_at
     FROM webhook_deliveries WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY next_attempt_at ASC LIMIT ?`,
  ).all(now, limit) as DeliveryRow[];

  const attempts: DeliveryAttempt[] = [];
  for (const row of rows) {
    const hook = db.prepare("SELECT url, secret FROM webhooks WHERE id = ? AND owner_id = ?")
      .get(row.webhook_id, row.owner_id) as { url: string; secret: string } | undefined;
    if (!hook) {
      finalize(db, row, "failed", null, "webhook was removed", now);
      attempts.push({ id: row.id, status: "failed", responseStatus: null, error: "webhook was removed" });
      continue;
    }
    if (!deliverableHost(hook.url)) {
      finalize(db, row, "failed", null, "target host is not allowed", now);
      attempts.push({ id: row.id, status: "failed", responseStatus: null, error: "target host is not allowed" });
      continue;
    }
    const timestamp = Math.floor(now / 1000);
    try {
      const response = await doFetch(hook.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "MobileCloud-Webhooks/1",
          "x-mobilecloud-event": row.event_type,
          "x-mobilecloud-delivery": row.id,
          "x-mobilecloud-timestamp": String(timestamp),
          "x-mobilecloud-signature": `sha256=${signature(hook.secret, timestamp, row.payload)}`,
        },
        body: row.payload,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.status >= 200 && response.status < 300) {
        finalize(db, row, "delivered", response.status, null, now);
        recordUsage(db, row.owner_id, "webhook_deliveries", 1, row.webhook_id);
        attempts.push({ id: row.id, status: "delivered", responseStatus: response.status, error: null });
      } else {
        retry(db, row, response.status, `receiver responded ${response.status}`, now);
        attempts.push({ id: row.id, status: row.attempts + 1 >= MAX_ATTEMPTS ? "failed" : "pending", responseStatus: response.status, error: `receiver responded ${response.status}` });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 200) : "delivery failed";
      retry(db, row, null, message, now);
      attempts.push({ id: row.id, status: row.attempts + 1 >= MAX_ATTEMPTS ? "failed" : "pending", responseStatus: null, error: message });
    }
  }
  return attempts;
}

function finalize(db: DatabaseSync, row: DeliveryRow, status: string, responseStatus: number | null, error: string | null, now: number) {
  db.prepare(
    "UPDATE webhook_deliveries SET status = ?, attempts = attempts + 1, response_status = ?, last_error = ?, updated_at = ? WHERE id = ?",
  ).run(status, responseStatus, error, now, row.id);
}

function retry(db: DatabaseSync, row: DeliveryRow, responseStatus: number | null, error: string, now: number) {
  const attempts = row.attempts + 1;
  const exhausted = attempts >= MAX_ATTEMPTS;
  db.prepare(
    "UPDATE webhook_deliveries SET status = ?, attempts = ?, response_status = ?, last_error = ?, next_attempt_at = ?, updated_at = ? WHERE id = ?",
  ).run(exhausted ? "failed" : "pending", attempts, responseStatus, error, exhausted ? now : now + backoffMs(attempts), now, row.id);
}

/** Most recent delivery attempts for the account, newest first. This is the delivery log. */
export function listDeliveries(db: DatabaseSync, owner: string, limit = 50) {
  return db.prepare(
    `SELECT id, webhook_id AS webhookId, event_type AS eventType, status, attempts,
            response_status AS responseStatus, last_error AS lastError,
            next_attempt_at AS nextAttemptAt, created_at AS createdAt, updated_at AS updatedAt
     FROM webhook_deliveries WHERE owner_id = ? ORDER BY created_at DESC LIMIT ?`,
  ).all(owner, Math.min(200, Math.max(1, limit)));
}
