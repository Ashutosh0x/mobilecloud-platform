import type { DatabaseSync } from "node:sqlite";
import { newId } from "./db.ts";
import { haversineKm, lookupGeo, type GeoLocation } from "./geo.ts";

/**
 * The authentication audit trail and the risk engine that reads it.
 *
 * Every credential event is appended to `auth_events`: who signed in, from
 * where, with what, and whether it looked ordinary. The trail is append-only
 * and is the input to the risk assessment, so the same data that is shown in
 * the console is the data the engine reasons about.
 */

export type AuthEventType =
  | "auth.register"
  | "auth.login.passkey"
  | "auth.login.password"
  | "auth.login.qr_approved"
  | "auth.login.device_grant"
  | "auth.login.failed"
  | "auth.logout"
  | "auth.session.expired"
  | "auth.session.revoked"
  | "auth.device.paired"
  | "auth.device.revoked"
  | "auth.token.created"
  | "auth.token.refreshed"
  | "auth.token.reuse_detected"
  | "auth.credential.created"
  | "auth.credential.deleted"
  | "auth.suspicious.new_location"
  | "auth.suspicious.new_device"
  | "auth.suspicious.brute_force"
  | "auth.suspicious.impossible_travel";

export type AuthEventInput = {
  userId?: string | null;
  eventType: AuthEventType | string;
  clientType?: string | null;
  credentialType?: string | null;
  sessionId?: string | null;
  deviceId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  geo?: GeoLocation | null;
  outcome?: "success" | "failure" | "suspicious";
  failureReason?: string | null;
  riskScore?: "low" | "medium" | "high" | "critical";
  metadata?: Record<string, unknown> | null;
  /** The moment the event happened. Defaults to now. */
  createdAt?: number;
};

/** Appends one authentication event to the trail. */
export function logAuthEvent(db: DatabaseSync, event: AuthEventInput): string {
  const id = newId();
  try {
    db.prepare(
      `INSERT INTO auth_events (id, user_id, event_type, client_type, credential_type, session_id, device_id,
         ip_address, user_agent, geo_location, outcome, failure_reason, risk_score, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      event.userId ?? null,
      event.eventType,
      event.clientType ?? null,
      event.credentialType ?? null,
      event.sessionId ?? null,
      event.deviceId ?? null,
      event.ipAddress ?? null,
      event.userAgent ?? null,
      event.geo ? JSON.stringify(event.geo) : null,
      event.outcome ?? "success",
      event.failureReason ?? null,
      event.riskScore ?? "low",
      event.metadata ? JSON.stringify(event.metadata) : null,
      // Callers replaying history (tests, imports, a backfill) can pin the
      // moment; a live login simply uses the clock.
      event.createdAt ?? Date.now(),
    );
  } catch {
    // The trail must never break a login. A failed write is visible in the
    // console's own error log, but it must not deny an account its session.
    console.warn("Authentication audit write failed");
  }
  return id;
}

export type RiskFactor =
  | { kind: "brute_force"; attempts: number }
  | { kind: "repeated_failure"; attempts: number }
  | { kind: "new_ip_address" }
  | { kind: "new_geo_location"; location: string }
  | { kind: "impossible_travel"; distanceKm: number; timeHours: number; requiredSpeedKmh: number }
  | { kind: "unusual_hour"; hour: number }
  | { kind: "password_auth" };

export type RiskAction = "allow" | "allow_with_notification" | "require_additional_factor" | "block";

export type RiskAssessment = {
  score: number;
  factors: RiskFactor[];
  action: RiskAction;
  riskScore: "low" | "medium" | "high" | "critical";
};

export type LoginContext = {
  userId: string;
  ipAddress: string | null;
  userAgent: string | null;
  geo: GeoLocation | null;
  credentialType: "passkey" | "password" | "qr" | "device_grant" | "token";
  timezone?: string | null;
};

const DAY_MS = 86_400_000;
const FAILURE_WINDOW_MS = 10 * 60_000;

/** The hour of day in the account's own timezone, when it is known. */
function localHour(timezone: string | null | undefined, at: number): number | null {
  if (!timezone) return null;
  try {
    const formatter = new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: timezone });
    const hour = Number(formatter.format(new Date(at)));
    return Number.isFinite(hour) ? hour % 24 : null;
  } catch {
    return null;
  }
}

/** The hours of day the account usually signs in, from its own history. */
function usualHours(db: DatabaseSync, userId: string): Set<number> {
  const hours = new Set<number>();
  const rows = db.prepare(
    "SELECT created_at AS at FROM auth_events WHERE user_id = ? AND outcome = 'success' AND created_at > ? LIMIT 200",
  ).all(userId, Date.now() - 30 * DAY_MS) as { at: number }[];
  for (const row of rows) {
    const hour = new Date(row.at).getUTCHours();
    if (Number.isFinite(hour)) hours.add(hour);
  }
  return hours;
}

/**
 * Scores a login attempt against the account's own history.
 *
 * The score is a sum of independent signals, each of which is worth little on
 * its own:
 *   - repeated failures inside ten minutes (credential stuffing);
 *   - an address the account has never used;
 *   - a country the account has never used;
 *   - a distance that could not be covered in the time between logins;
 *   - an hour of day the account never signs in at;
 *   - a password, which is the weakest factor the platform still accepts.
 *
 * The action follows the score: below 0.3 the login is allowed, below 0.6 it
 * is allowed and the account is notified, below 0.8 it needs a second factor,
 * and at 0.8 or above it is blocked.
 */
export function assessLoginRisk(db: DatabaseSync, context: LoginContext): RiskAssessment {
  let score = 0;
  const factors: RiskFactor[] = [];

  // 1. Failures inside the last ten minutes.
  const failures = db.prepare(
    "SELECT COUNT(*) AS n FROM auth_events WHERE user_id = ? AND event_type = 'auth.login.failed' AND created_at > ?",
  ).get(context.userId, Date.now() - FAILURE_WINDOW_MS) as { n: number };
  const attempts = Number(failures?.n ?? 0);
  if (attempts >= 5) {
    score += 0.4;
    factors.push({ kind: "brute_force", attempts });
  } else if (attempts >= 3) {
    score += 0.2;
    factors.push({ kind: "repeated_failure", attempts });
  }

  // 2. An address the account has never signed in from.
  if (context.ipAddress) {
    const known = db.prepare(
      "SELECT COUNT(*) AS n FROM auth_events WHERE user_id = ? AND outcome = 'success' AND ip_address = ? AND created_at > ?",
    ).get(context.userId, context.ipAddress, Date.now() - 30 * DAY_MS) as { n: number };
    if (Number(known?.n ?? 0) === 0) {
      score += 0.15;
      factors.push({ kind: "new_ip_address" });
    }
  }

  // 3. A country the account has never signed in from.
  if (context.geo) {
    const rows = db.prepare(
      "SELECT geo_location AS geo FROM auth_events WHERE user_id = ? AND outcome = 'success' AND geo_location IS NOT NULL AND created_at > ?",
    ).all(context.userId, Date.now() - 365 * DAY_MS) as { geo: string }[];
    const countries = new Set<string>();
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.geo) as GeoLocation;
        if (parsed?.country) countries.add(parsed.country.toUpperCase());
      } catch { /* an unreadable row is simply not a known country */ }
    }
    if (!countries.has(context.geo.country.toUpperCase())) {
      score += 0.2;
      factors.push({ kind: "new_geo_location", location: context.geo.country });
    }
  }

  // 4. A distance that could not be covered in the time between logins.
  const last = db.prepare(
    "SELECT created_at AS at, geo_location AS geo FROM auth_events WHERE user_id = ? AND outcome = 'success' AND geo_location IS NOT NULL ORDER BY created_at DESC LIMIT 1",
  ).get(context.userId) as { at: number; geo: string } | undefined;
  if (last && context.geo) {
    try {
      const previous = JSON.parse(last.geo) as GeoLocation;
      if (previous?.lat !== undefined && previous?.lon !== undefined) {
        const distanceKm = haversineKm(previous, context.geo);
        const timeHours = Math.max((Date.now() - last.at) / 3_600_000, 0.01);
        const requiredSpeed = distanceKm / timeHours;
        if (requiredSpeed > 1000) {
          // Impossible travel is not a hint, it is evidence: two continents
          // cannot be visited faster than a commercial airliner, so this
          // signal alone pushes a login that also uses a new address and a new
          // country over the block threshold.
          score += 0.5;
          factors.push({ kind: "impossible_travel", distanceKm, timeHours, requiredSpeedKmh: requiredSpeed });
        }
      }
    } catch { /* an unreadable row cannot prove anything */ }
  }

  // 5. An hour of day the account never signs in at.
  const hour = localHour(context.timezone, Date.now());
  if (hour !== null) {
    const hours = usualHours(db, context.userId);
    if (hours.size >= 3 && !hours.has(hour)) {
      score += 0.1;
      factors.push({ kind: "unusual_hour", hour });
    }
  }

  // 6. A password is the weakest factor the platform still accepts.
  if (context.credentialType === "password") {
    score += 0.1;
    factors.push({ kind: "password_auth" });
  }

  const total = Math.min(1, score);
  const action: RiskAction =
    total >= 0.8 ? "block" : total >= 0.6 ? "require_additional_factor" : total >= 0.3 ? "allow_with_notification" : "allow";
  const riskScore = total >= 0.8 ? "critical" : total >= 0.6 ? "high" : total >= 0.3 ? "medium" : "low";
  return { score: total, factors, action, riskScore };
}

/** Resolves the geography of a request, when the local table can answer it. */
export function geoFor(ip: string | null | undefined): GeoLocation | null {
  return lookupGeo(ip);
}

/** The audit trail of an account, newest first. */
export function listAuthEvents(db: DatabaseSync, userId: string, limit = 100) {
  return db.prepare(
    `SELECT id, event_type AS eventType, client_type AS clientType, credential_type AS credentialType,
       session_id AS sessionId, device_id AS deviceId, ip_address AS ipAddress, user_agent AS userAgent,
       geo_location AS geoLocation, outcome, failure_reason AS failureReason, risk_score AS riskScore,
       metadata, created_at AS createdAt
     FROM auth_events WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`,
  ).all(userId, limit);
}
