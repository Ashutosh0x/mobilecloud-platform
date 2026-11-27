import type { DatabaseSync } from "node:sqlite";
import { newId } from "./db.ts";

/**
 * Persisted consent.
 *
 * A consent row records the exact scope set an account approved for a client.
 * It is informational for the consent screen and auditable later; it never
 * substitutes for client authentication or token validation. A changed scope
 * set replaces the stored value, so an expanded request is shown again.
 */

export type Consent = {
  clientId: string;
  scope: string;
  createdAt: number;
  updatedAt: number;
};

export function recordConsent(db: DatabaseSync, userId: string, clientId: string, scope: string): void {
  const normalized = scope.split(/\s+/).filter(Boolean).sort().join(" ");
  const now = Date.now();
  db.prepare(
    `INSERT INTO identity_consents (id, user_id, client_id, scope, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, client_id) DO UPDATE SET scope = excluded.scope, updated_at = excluded.updated_at`,
  ).run(newId(), userId, clientId, normalized, now, now);
}

export function consentFor(db: DatabaseSync, userId: string, clientId: string): Consent | null {
  const row = db.prepare(
    "SELECT client_id AS clientId, scope, created_at AS createdAt, updated_at AS updatedAt FROM identity_consents WHERE user_id = ? AND client_id = ?",
  ).get(userId, clientId) as Consent | undefined;
  return row ?? null;
}

/** True when every requested scope is already covered by a prior approval. */
export function hasConsentFor(db: DatabaseSync, userId: string, clientId: string, scope: string): boolean {
  const existing = consentFor(db, userId, clientId);
  if (!existing) return false;
  const approved = new Set(existing.scope.split(/\s+/).filter(Boolean));
  return scope
    .split(/\s+/)
    .filter(Boolean)
    .every((entry) => approved.has(entry));
}

export function listConsents(db: DatabaseSync, userId: string): Consent[] {
  return db.prepare(
    "SELECT client_id AS clientId, scope, created_at AS createdAt, updated_at AS updatedAt FROM identity_consents WHERE user_id = ? ORDER BY updated_at DESC",
  ).all(userId) as Consent[];
}

export function revokeConsent(db: DatabaseSync, userId: string, clientId: string): boolean {
  return Number(db.prepare("DELETE FROM identity_consents WHERE user_id = ? AND client_id = ?").run(userId, clientId).changes) > 0;
}
