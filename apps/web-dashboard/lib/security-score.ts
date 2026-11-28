/**
 * The security score.
 *
 * The number is a weighted sum of checks that the console can actually
 * evaluate from data it already holds — firewall coverage, the share of
 * requests that failed, session count, token expiry, and whether the console
 * screen is protected. Each check states what it looked at, so the score is
 * never a black box.
 *
 * A check with no data is *skipped*, not failed: its weight is removed and the
 * remaining weights are renormalised. The console never awards or withholds
 * points for something it could not measure.
 */

export type ScoreCheck = {
  id: string;
  label: string;
  ok: boolean;
  skipped: boolean;
  detail: string;
  weight: number;
};

export type SecurityScore = {
  score: number;
  checks: ScoreCheck[];
  /** The weights that actually counted, after skipping unmeasured checks. */
  measuredWeight: number;
};

export type SecurityScoreInput = {
  firewallRules: { action: string; enabled: number }[];
  firewallEvents: { action: string; at: number }[];
  /** Requests observed in the measurement window. */
  requestCount: number;
  /** Server errors among those requests. */
  serverErrorCount: number;
  activeSessions: number;
  tokens: { expiresAt: number | null }[];
  protection: { required: boolean; unlocked: boolean };
  /** The window the events belong to, in milliseconds. */
  windowMs?: number;
};

const WEIGHTS = {
  firewallCoverage: 25,
  ruleActivity: 10,
  errorRate: 20,
  sessionHygiene: 20,
  tokenExpiry: 10,
  screenProtection: 15,
} as const;

export function computeSecurityScore(input: SecurityScoreInput): SecurityScore {
  const windowMs = input.windowMs ?? 24 * 3600 * 1000;
  const since = Date.now() - windowMs;
  const checks: ScoreCheck[] = [];

  // 1. Firewall coverage — is there a rule that can actually deny traffic?
  const enforcing = input.firewallRules.filter(
    (rule) => rule.enabled === 1 && (rule.action === "deny" || rule.action === "rate_limit"),
  );
  checks.push({
    id: "firewall-coverage",
    label: "A firewall rule can deny traffic",
    ok: enforcing.length > 0,
    skipped: false,
    detail: enforcing.length > 0
      ? `${enforcing.length} enforcing rule${enforcing.length === 1 ? "" : "s"}`
      : "No enabled deny or rate-limit rule",
    weight: WEIGHTS.firewallCoverage,
  });

  // 2. Rule activity — did the rules ever match? Only meaningful once traffic
  //    has been seen; with no traffic there is nothing to show.
  const matches = input.firewallEvents.filter((event) => event.at >= since && event.action !== "log");
  checks.push({
    id: "rule-activity",
    label: "Firewall rules have matched traffic",
    ok: matches.length > 0,
    skipped: input.requestCount === 0,
    detail: input.requestCount === 0
      ? "No requests in the window"
      : `${matches.length} rule match${matches.length === 1 ? "" : "es"}`,
    weight: WEIGHTS.ruleActivity,
  });

  // 3. Error rate — the share of requests that failed with a 5xx.
  const errorRate = input.requestCount > 0 ? (input.serverErrorCount / input.requestCount) * 100 : null;
  checks.push({
    id: "error-rate",
    label: "Server errors stay below 1%",
    ok: errorRate !== null && errorRate < 1,
    skipped: errorRate === null,
    detail: errorRate === null
      ? "No requests in the window"
      : `${errorRate.toFixed(2)}% of ${input.requestCount} requests`,
    weight: WEIGHTS.errorRate,
  });

  // 4. Session hygiene — many parallel sessions widen the blast radius.
  const sessions = input.activeSessions;
  checks.push({
    id: "session-hygiene",
    label: "Fewer than six live sessions",
    ok: sessions < 6,
    skipped: false,
    detail: `${sessions} live session${sessions === 1 ? "" : "s"}`,
    weight: WEIGHTS.sessionHygiene,
  });

  // 5. Token expiry — a token that never expires is a token that cannot be
  //    rotated out by policy.
  const perpetual = input.tokens.filter((token) => token.expiresAt === null).length;
  checks.push({
    id: "token-expiry",
    label: "Every API token expires",
    ok: perpetual === 0,
    skipped: false,
    detail: perpetual === 0
      ? `${input.tokens.length} token${input.tokens.length === 1 ? "" : "s"}, all expiring`
      : `${perpetual} token${perpetual === 1 ? "" : "s"} never expire`,
    weight: WEIGHTS.tokenExpiry,
  });

  // 6. Screen protection — the console lock on the shared screen.
  checks.push({
    id: "screen-protection",
    label: "Console screen protection is on",
    ok: input.protection.required,
    skipped: false,
    detail: input.protection.required
      ? "A password gates the console screen"
      : "No console password is set",
    weight: WEIGHTS.screenProtection,
  });

  const measured = checks.filter((check) => !check.skipped);
  const measuredWeight = measured.reduce((sum, check) => sum + check.weight, 0);
  const earned = measured.reduce((sum, check) => sum + (check.ok ? check.weight : 0), 0);
  const score = measuredWeight === 0 ? 0 : Math.round((earned / measuredWeight) * 100);
  return { score, checks, measuredWeight };
}
