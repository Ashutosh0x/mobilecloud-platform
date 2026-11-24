import type { DatabaseSync } from "node:sqlite";
import { newId } from "./db.ts";

/**
 * Durable event log / transactional outbox.
 *
 * `publish()` is called *inside* the same transaction as the mutation it
 * describes. The row it appends is the single source of truth for real-time
 * delivery: the WebSocket gateway tails this table, and any client that was
 * offline replays it through `GET /api/sync/changes?cursor=<seq>`. A dropped
 * socket frame therefore can never lose a change.
 */

export const SCHEMA_VERSION = 1;

/** Every event type the platform can emit. Subscriptions are validated against it. */
export const EVENT_TYPES = [
  "account.updated",
  "session.created",
  "session.revoked",
  "project.created",
  "project.updated",
  "project.deleted",
  "deployment.started",
  "deployment.updated",
  "deployment.completed",
  "deployment.failed",
  "build.started",
  "build.updated",
  "build.completed",
  "build.failed",
  "configuration.updated",
  "notification.created",
  "notification.read",
  "server.status_changed",
  // QR device pairing + connected-device lifecycle. Every transition of a
  // pairing session (create → scan → approve → connect, or expire/revoke) is
  // appended to the outbox so both the browser and the Android device update
  // without polling.
  "device.pairing.created",
  "device.pairing.scanned",
  "device.pairing.approval_requested",
  "device.pairing.approved",
  "device.pairing.connected",
  "device.pairing.expired",
  "device.pairing.revoked",
  "device.connected",
  "device.disconnected",
  "device.updated",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export type EventEnvelope = {
  event_id: string;
  event_type: string;
  schema_version: number;
  account_id: string;
  resource_id: string | null;
  sequence: number;
  occurred_at: string;
  payload: Record<string, unknown>;
};

export type StoredEvent = EventEnvelope & { seq: number; at: number };

/** How many events are kept per… (globally) before the oldest are pruned. */
const RETENTION_ROWS = 50_000;
/** Never let the outbox grow past this, regardless of age. */
const RETENTION_DAYS = 30;

/**
 * Runs [fn] inside a single SQLite transaction. Mutations use this so the write
 * and its outbox row commit atomically: either both are visible or neither is.
 */
export function tx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* the transaction was already unwound */
    }
    throw error;
  }
}

/**
 * Appends one event to the outbox and returns its global sequence number.
 * Must be called inside a `tx()` block (or a single-statement mutation) so the
 * event and the data change commit together.
 */
export function publish(
  db: DatabaseSync,
  ownerId: string,
  type: EventType | string,
  resourceId: string | null,
  payload: Record<string, unknown> = {},
): number {
  const result = db.prepare(
    `INSERT INTO events (id, owner_id, type, resource_id, schema_version, payload, at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(newId(), ownerId, type, resourceId, SCHEMA_VERSION, JSON.stringify(payload ?? {}), Date.now());
  return Number(result.lastInsertRowid);
}

function rowToEnvelope(row: Record<string, unknown>): StoredEvent {
  const seq = Number(row.seq);
  const at = Number(row.at);
  let payload: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(String(row.payload ?? "{}"));
    if (parsed && typeof parsed === "object") payload = parsed as Record<string, unknown>;
  } catch {
    payload = {};
  }
  return {
    event_id: String(row.id),
    event_type: String(row.type),
    schema_version: Number(row.schema_version ?? SCHEMA_VERSION),
    account_id: String(row.owner_id),
    resource_id: row.resource_id == null ? null : String(row.resource_id),
    sequence: seq,
    occurred_at: new Date(at).toISOString(),
    payload,
    seq,
    at,
  };
}

/** Highest sequence number currently stored (0 when the outbox is empty). */
export function latestSeq(db: DatabaseSync, ownerId?: string): number {
  const row = ownerId
    ? db.prepare("SELECT COALESCE(MAX(seq), 0) AS s FROM events WHERE owner_id = ?").get(ownerId)
    : db.prepare("SELECT COALESCE(MAX(seq), 0) AS s FROM events").get();
  return Number((row as { s: number }).s);
}

/**
 * Authorized catch-up: every event for [ownerId] newer than [cursor], oldest
 * first. This is what a client calls after reconnecting from a long offline
 * period — it cannot see another account's rows.
 */
export function changesSince(
  db: DatabaseSync,
  ownerId: string,
  cursor: number,
  limit = 500,
): { cursor: number; events: StoredEvent[]; more: boolean; latest: number } {
  const rows = db.prepare(
    `SELECT seq, id, owner_id, type, resource_id, schema_version, payload, at
     FROM events WHERE owner_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`,
  ).all(ownerId, cursor, limit + 1) as Record<string, unknown>[];
  const more = rows.length > limit;
  const page = more ? rows.slice(0, limit) : rows;
  const events = page.map(rowToEnvelope);
  return {
    cursor: events.length ? events[events.length - 1].seq : cursor,
    events,
    more,
    latest: latestSeq(db, ownerId),
  };
}

/** Drops events older than the retention window. Safe to call periodically. */
export function prune(db: DatabaseSync) {
  const cutoff = Date.now() - RETENTION_DAYS * 86_400_000;
  db.prepare("DELETE FROM events WHERE at < ?").run(cutoff);
  const count = db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number };
  if (count.n > RETENTION_ROWS) {
    const cut = db.prepare("SELECT seq FROM events ORDER BY seq DESC LIMIT 1 OFFSET ?").get(RETENTION_ROWS) as
      | { seq: number }
      | undefined;
    if (cut) db.prepare("DELETE FROM events WHERE seq <= ?").run(cut.seq);
  }
}
