import type { DatabaseSync } from "node:sqlite";
import { newId } from "./db.ts";

/**
 * Proof-of-reserve read model.
 *
 * The reconciliation mathematics is *not* implemented here. It lives in the
 * Rust `por-kernel` crate — the single source of financial truth — and is
 * executed by the attestor / mesh nodes. This module only stores the kernel's
 * output and serves it read-only, so a client can never invent a reserve
 * ratio: with no published attestation the state is explicitly `unverified`.
 */

export const POR_STATUSES = ["healthy", "warning", "stale", "critical", "frozen", "zero_supply"] as const;
export type PorStatus = (typeof POR_STATUSES)[number];

export type AttestationInput = {
  status: PorStatus;
  reserveRatioBps: number;
  totalBackingBase: string;
  totalLiabilitiesBase: string;
  netDifferenceBase: string;
  evidenceAgeSec: number;
  ledgerSequence: number | null;
  digest: string | null;
  quorum: string | null;
  observedAt: number;
};

export type PorAttestation = AttestationInput & { id: string; recordedAt: number };

export type PorState = {
  verified: boolean;
  status: PorStatus | "unverified";
  reason: string;
  attestation: PorAttestation | null;
  checkedAt: number;
};

export const UNVERIFIED_REASON =
  "No proof-of-reserve attestation has been published for this account. Reserve figures shown anywhere else would be unverified.";

/** u128 base-unit amounts arrive as decimal strings (they exceed JS integers). */
const BASE_UNITS = /^\d{1,39}$/;
const DIGEST = /^[a-fA-F0-9]{16,128}$/;
const RATIO_CEILING = 1_000_000; // 10,000 bps = 100%; cap absurd "backing" faults.

function asInt(value: unknown, min: number, max: number): number | null {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof n === "number" && Number.isSafeInteger(n) && n >= min && n <= max ? n : null;
}

function asOptionalString(value: unknown, max: number): { ok: true; value: string | null } | { ok: false } {
  if (value === undefined || value === null || value === "") return { ok: true, value: null };
  if (typeof value !== "string" || value.length > max) return { ok: false };
  return { ok: true, value };
}

export function validateAttestation(
  input: Record<string, unknown>,
): { ok: true; value: AttestationInput } | { ok: false; error: string } {
  const status = String(input.status ?? "");
  if (!(POR_STATUSES as readonly string[]).includes(status)) {
    return { ok: false, error: `status must be one of ${POR_STATUSES.join(", ")}` };
  }
  const reserveRatioBps = asInt(input.reserveRatioBps, 0, RATIO_CEILING);
  if (reserveRatioBps === null) return { ok: false, error: "reserveRatioBps must be an integer between 0 and 1000000" };

  const amounts: Record<string, string> = {};
  for (const field of ["totalBackingBase", "totalLiabilitiesBase", "netDifferenceBase"] as const) {
    const value = input[field];
    if (typeof value !== "string" || !BASE_UNITS.test(value)) {
      return { ok: false, error: `${field} must be a decimal string (u128 base units)` };
    }
    amounts[field] = value;
  }

  const evidenceAgeSec = asInt(input.evidenceAgeSec, 0, 10 * 365 * 86_400);
  if (evidenceAgeSec === null) return { ok: false, error: "evidenceAgeSec must be a non-negative integer" };

  const ledgerSequence = input.ledgerSequence == null ? null : asInt(input.ledgerSequence, 0, Number.MAX_SAFE_INTEGER);
  if (ledgerSequence === null && input.ledgerSequence != null) {
    return { ok: false, error: "ledgerSequence must be a non-negative integer" };
  }

  const digestResult = asOptionalString(input.digest, 128);
  if (!digestResult.ok) return { ok: false, error: "digest must be a hex string" };
  const digest = digestResult.value;
  if (digest !== null && !DIGEST.test(digest)) return { ok: false, error: "digest must be a hex string" };
  const quorumResult = asOptionalString(input.quorum, 120);
  if (!quorumResult.ok) return { ok: false, error: "quorum is too long" };
  const quorum = quorumResult.value;

  const observedAt = input.observedAt == null ? Date.now() : asInt(input.observedAt, 0, Number.MAX_SAFE_INTEGER);
  if (observedAt === null) return { ok: false, error: "observedAt must be a millisecond timestamp" };

  return {
    ok: true,
    value: {
      status: status as PorStatus,
      reserveRatioBps,
      totalBackingBase: amounts.totalBackingBase,
      totalLiabilitiesBase: amounts.totalLiabilitiesBase,
      netDifferenceBase: amounts.netDifferenceBase,
      evidenceAgeSec,
      ledgerSequence,
      digest,
      quorum,
      observedAt,
    },
  };
}

type Row = {
  id: string;
  status: string;
  reserve_ratio_bps: number;
  total_backing_base: string;
  total_liabilities_base: string;
  net_difference_base: string;
  evidence_age_sec: number;
  ledger_sequence: number | null;
  digest: string | null;
  quorum: string | null;
  observed_at: number;
  created_at: number;
};

function toAttestation(row: Row): PorAttestation {
  return {
    id: row.id,
    status: row.status as PorStatus,
    reserveRatioBps: Number(row.reserve_ratio_bps),
    totalBackingBase: row.total_backing_base,
    totalLiabilitiesBase: row.total_liabilities_base,
    netDifferenceBase: row.net_difference_base,
    evidenceAgeSec: Number(row.evidence_age_sec),
    ledgerSequence: row.ledger_sequence == null ? null : Number(row.ledger_sequence),
    digest: row.digest,
    quorum: row.quorum,
    observedAt: Number(row.observed_at),
    recordedAt: Number(row.created_at),
  };
}

export function insertAttestation(db: DatabaseSync, owner: string, value: AttestationInput): PorAttestation {
  const id = newId();
  const now = Date.now();
  db.prepare(
    `INSERT INTO por_attestations
       (id, owner_id, status, reserve_ratio_bps, total_backing_base, total_liabilities_base,
        net_difference_base, evidence_age_sec, ledger_sequence, digest, quorum, observed_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    owner,
    value.status,
    value.reserveRatioBps,
    value.totalBackingBase,
    value.totalLiabilitiesBase,
    value.netDifferenceBase,
    value.evidenceAgeSec,
    value.ledgerSequence,
    value.digest,
    value.quorum,
    value.observedAt,
    now,
  );
  return { ...value, id, recordedAt: now };
}

export function readAttestation(db: DatabaseSync, owner: string): PorAttestation | null {
  const row = db.prepare(
    "SELECT * FROM por_attestations WHERE owner_id = ? ORDER BY created_at DESC LIMIT 1",
  ).get(owner) as Row | undefined;
  return row ? toAttestation(row) : null;
}

export function porState(db: DatabaseSync, owner: string): PorState {
  const attestation = readAttestation(db, owner);
  if (!attestation) {
    return { verified: false, status: "unverified", reason: UNVERIFIED_REASON, attestation: null, checkedAt: Date.now() };
  }
  return {
    verified: true,
    status: attestation.status,
    reason: `Latest attestation recorded ${new Date(attestation.recordedAt).toISOString()}.`,
    attestation,
    checkedAt: Date.now(),
  };
}
