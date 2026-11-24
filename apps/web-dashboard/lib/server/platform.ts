import { readdirSync, statSync } from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { newId } from "./db.ts";

const EXEMPT = new Set(["overview", "metrics", "analytics", "events", "vitals", "host", "search"]);

const JA4 = /^[tqd]1[23][di]\d{4}[a-z0-9]{2}_[a-f0-9]{12}_[a-f0-9]{12}$/i;
const CRAWLERS = ["GPTBot", "ClaudeBot", "Bytespider", "Googlebot", "bingbot", "Amazonbot"];

export function clientIp(req: Request) {
  // Do not trust caller-provided forwarding headers. Only opt in behind a
  // private ingress that strips and sets this dedicated header on every request.
  if (process.env.MOBILECLOUD_TRUST_PROXY === "1") {
    const address = req.headers.get("x-mobilecloud-client-ip")?.trim() ?? "";
    if (isIP(address)) return address;
  }
  return "unknown";
}

export function observedJa4(req: Request) {
  const header = req.headers.get("x-ja4-fingerprint")?.trim() ?? "";
  return JA4.test(header) ? header.toLowerCase() : null;
}

function matches(rule: Rule, req: Request, path: string) {
  let subject = "";
  if (rule.match_key === "path") subject = `/${path}`;
  else if (rule.match_key === "ip") subject = clientIp(req);
  else if (rule.match_key === "header") subject = req.headers.get(rule.header_name ?? "") ?? "";
  else if (rule.match_key === "ja4") subject = observedJa4(req) ?? "";
  else if (rule.match_key === "user_agent") subject = req.headers.get("user-agent") ?? "";
  else if (rule.match_key === "host") subject = req.headers.get("host") ?? "";
  else return false;
  if (!subject) return false;
  const expected = rule.match_key === "ja4" ? rule.match_value.toLowerCase() : rule.match_value;
  if (rule.match_op === "equals") return subject === expected;
  if (rule.match_op === "starts_with") return subject.startsWith(expected);
  if (rule.match_op === "contains") return subject.toLowerCase().includes(expected.toLowerCase());
  return false;
}

type Rule = {
  id: string;
  name: string;
  action: string;
  match_key: string;
  match_op: string;
  match_value: string;
  header_name: string | null;
  limit_count: number | null;
  window_sec: number | null;
  enabled: number;
};

export function inspectRequest(db: DatabaseSync, owner: string, req: Request, path: string): { status: number; error: string } | null {
  if (EXEMPT.has(path) || path.startsWith("firewall") || path.startsWith("auth/")) return null;
  const rules = db.prepare(
    "SELECT id, name, action, match_key, match_op, match_value, header_name, limit_count, window_sec, enabled FROM firewall_rules WHERE owner_id = ? AND enabled = 1",
  ).all(owner) as Rule[];
  for (const rule of rules) {
    if (!matches(rule, req, path)) continue;
    const ip = clientIp(req);
    if (rule.action === "rate_limit") {
      const windowMs = Math.max(1, rule.window_sec ?? 60) * 1000;
      const count = db.prepare(
        "SELECT COUNT(*) AS n FROM firewall_events WHERE owner_id = ? AND rule_id = ? AND ip = ? AND at >= ?",
      ).get(owner, rule.id, ip, Date.now() - windowMs) as { n: number };
      db.prepare(
        "INSERT INTO firewall_events (id, owner_id, rule_id, action, path, ip, at, user_agent, host, ja4) VALUES (?, ?, ?, 'rate_limit', ?, ?, ?, ?, ?, ?)",
      ).run(newId(), owner, rule.id, `/${path}`, ip, Date.now(), req.headers.get("user-agent")?.slice(0, 180) ?? null, req.headers.get("host"), observedJa4(req));
      if (count.n + 1 > (rule.limit_count ?? 60)) {
        return { status: 429, error: `Rate limit "${rule.name}" exceeded` };
      }
      continue;
    }
    db.prepare(
      "INSERT INTO firewall_events (id, owner_id, rule_id, action, path, ip, at, user_agent, host, ja4) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(newId(), owner, rule.id, rule.action, `/${path}`, ip, Date.now(), req.headers.get("user-agent")?.slice(0, 180) ?? null, req.headers.get("host"), observedJa4(req));
    if (rule.action === "deny") return { status: 403, error: `Blocked by firewall rule "${rule.name}"` };
  }
  return null;
}

export function listRules(db: DatabaseSync, owner: string) {
  return db.prepare(
    "SELECT id, name, action, match_key AS matchKey, match_op AS matchOp, match_value AS matchValue, header_name AS headerName, limit_count AS limitCount, window_sec AS windowSec, enabled, created_at AS createdAt FROM firewall_rules WHERE owner_id = ? ORDER BY created_at DESC",
  ).all(owner);
}

export function listFirewallEvents(db: DatabaseSync, owner: string) {
  return db.prepare(
    "SELECT id, rule_id AS ruleId, action, path, ip, at, user_agent AS userAgent, host, ja4 FROM firewall_events WHERE owner_id = ? ORDER BY at DESC LIMIT 50",
  ).all(owner);
}

export function trafficSummary(db: DatabaseSync, owner: string) {
  const since = Date.now() - 24 * 3600 * 1000;
  const hour = 3600 * 1000;
  const rows = db.prepare(
    "SELECT path, status, at, user_agent AS userAgent, ja4 FROM requests WHERE owner_id = ? AND at >= ?",
  ).all(owner, since) as { path: string; status: number; at: number; userAgent: string | null; ja4: string | null }[];
  const events = db.prepare(
    "SELECT action FROM firewall_events WHERE owner_id = ? AND at >= ?",
  ).all(owner, since) as { action: string }[];
  const buckets = new Map<number, number>();
  const paths = new Map<string, number>();
  const agents = new Map<string, number>();
  const ja4s = new Map<string, number>();
  const crawlers = new Map<string, number>();
  for (const row of rows) {
    const start = Math.floor(row.at / hour) * hour;
    buckets.set(start, (buckets.get(start) ?? 0) + 1);
    paths.set(row.path, (paths.get(row.path) ?? 0) + 1);
    if (row.userAgent) agents.set(row.userAgent, (agents.get(row.userAgent) ?? 0) + 1);
    if (row.ja4) ja4s.set(row.ja4, (ja4s.get(row.ja4) ?? 0) + 1);
    for (const token of CRAWLERS) {
      if (row.userAgent?.includes(token)) crawlers.set(token, (crawlers.get(token) ?? 0) + 1);
    }
  }
  const rank = (map: Map<string, number>) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([value, count]) => ({ value, count }));
  return {
    window: "24h" as const,
    requests: rows.length,
    denied: events.filter((event) => event.action === "deny").length,
    logged: events.filter((event) => event.action === "log").length,
    rateLimited: events.filter((event) => event.action === "rate_limit").length,
    buckets: [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([start, requests]) => ({ start, requests })),
    topPaths: rank(paths),
    topAgents: rank(agents),
    topJa4: rank(ja4s),
    crawlerTokens: rank(crawlers),
    notes: [
      "Counts are API calls this server stored for your account. They are not edge traffic.",
      "JA4 rows appear only when the request included an x-ja4-fingerprint header with JA4 shape.",
      "ASN, country, and bot scores are not measured.",
    ],
  };
}

function percentile(sorted: number[], p: number) {
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

export function collectObservability(db: DatabaseSync, owner: string) {
  const since = Date.now() - 24 * 3600 * 1000;
  const rows = db.prepare(
    "SELECT status, duration_ms AS duration FROM requests WHERE owner_id = ? AND at >= ?",
  ).all(owner, since) as { status: number; duration: number }[];
  const durations = rows.map((row) => row.duration).sort((a, b) => a - b);
  const statuses = { s2xx: 0, s3xx: 0, s4xx: 0, s5xx: 0 };
  for (const row of rows) {
    if (row.status >= 500) statuses.s5xx += 1;
    else if (row.status >= 400) statuses.s4xx += 1;
    else if (row.status >= 300) statuses.s3xx += 1;
    else statuses.s2xx += 1;
  }
  return {
    collectedAt: Date.now(),
    samples: rows.length,
    window: "24h",
    statuses,
    p50: percentile(durations, 50),
    p95: percentile(durations, 95),
    p99: percentile(durations, 99),
    unavailable: [
      "OpenTelemetry traces are not exported from this process.",
      "JA4 is read only from an x-ja4-fingerprint header. This process does not parse a TLS ClientHello.",
      "Geographic country is not measured.",
    ],
  };
}

export function summarizeVitals(db: DatabaseSync, owner: string) {
  const since = Date.now() - 24 * 3600 * 1000;
  const rows = db.prepare(
    "SELECT metric, value FROM vitals WHERE owner_id = ? AND at >= ?",
  ).all(owner, since) as { metric: string; value: number }[];
  const groups = new Map<string, number[]>();
  for (const row of rows) {
    const list = groups.get(row.metric) ?? [];
    list.push(row.value);
    groups.set(row.metric, list);
  }
  const metrics = ["LCP", "INP", "CLS", "FCP", "TTFB"].map((metric) => {
    const values = (groups.get(metric) ?? []).sort((a, b) => a - b);
    return { metric, samples: values.length, p75: percentile(values, 75) };
  });
  const enough = metrics.filter((item) => item.metric !== "FCP" && item.metric !== "TTFB").every((item) => item.samples > 0);
  return {
    collectedAt: Date.now(),
    metrics,
    res: enough ? score(metrics) : null,
    note: enough ? "Score uses only vitals posted by this browser." : "No Real Experience Score until LCP, INP, and CLS samples exist.",
  };
}

function score(metrics: { metric: string; p75: number | null }[]) {
  const bands: Record<string, [number, number]> = { LCP: [2500, 4000], INP: [200, 500], CLS: [0.1, 0.25] };
  let total = 0;
  let n = 0;
  for (const item of metrics) {
    const band = bands[item.metric];
    if (!band || item.p75 == null) continue;
    const [good, poor] = band;
    const value = item.p75 <= good ? 100 : item.p75 >= poor ? 0 : Math.round(100 * (1 - (item.p75 - good) / (poor - good)));
    total += value;
    n += 1;
  }
  return n ? Math.round(total / n) : null;
}

export function listBuilds(db: DatabaseSync, owner: string) {
  return db.prepare(
    `SELECT b.id, p.name AS project, b.target, b.status, b.note, b.created_at AS createdAt
     FROM builds b JOIN projects p ON p.id = b.project_id
     WHERE b.owner_id = ? ORDER BY b.created_at DESC LIMIT 50`,
  ).all(owner);
}

export function listWorkflows(db: DatabaseSync, owner: string) {
  const rows = db.prepare(
    "SELECT id, name, created_at AS createdAt FROM workflows WHERE owner_id = ? ORDER BY created_at DESC",
  ).all(owner) as { id: string; name: string; createdAt: number }[];
  return rows.map((row) => {
    const last = db.prepare(
      "SELECT status, note, at FROM workflow_runs WHERE owner_id = ? AND workflow_id = ? ORDER BY at DESC LIMIT 1",
    ).get(owner, row.id) as { status: string; note: string; at: number } | undefined;
    return { ...row, lastRun: last ?? null };
  });
}

function dirBytes(path: string): number | null {
  try {
    const entries = readdirSync(path, { withFileTypes: true });
    let total = 0;
    for (const entry of entries) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) {
        const nested = dirBytes(full);
        total += nested ?? 0;
      } else total += statSync(full).size;
    }
    return total;
  } catch {
    return null;
  }
}

export function listDrives(db: DatabaseSync, owner: string) {
  const rows = db.prepare(
    "SELECT id, name, path, created_at AS createdAt FROM drives WHERE owner_id = ?",
  ).all(owner) as { id: string; name: string; path: string; createdAt: number }[];
  return rows.map((row) => ({ id: row.id, name: row.name, bytes: dirBytes(row.path), createdAt: row.createdAt }));
}

export function capabilities() {
  return [
    { name: "Request firewall", state: "active", detail: "Rules run in this API process for the signed-in account. They are not a global anycast WAF." },
    { name: "Measured latency", state: "active", detail: "Percentiles come from requests this server recorded." },
    { name: "Browser vitals", state: "active", detail: "LCP, INP, CLS, FCP, and TTFB are posted by this browser when the browser reports them." },
    { name: "JA4 header", state: "active", detail: "Rules can match x-ja4-fingerprint when it has JA4 shape. This process does not compute the digest and does not fill one in." },
    { name: "JA4 from TLS", state: "unavailable", detail: "Node does not expose the ClientHello. No edge proxy is running in front of this server." },
    { name: "Bot scoring", state: "unavailable", detail: "No BotID challenge is configured. Known crawler names are counted only when they appear in the User-Agent." },
    { name: "Host shell", state: "unavailable", detail: "CloudShell stays on a fixed command list. A PTY is not attached because this server is reachable beyond localhost." },
    { name: "Firecracker sandboxes", state: "unavailable", detail: "No microVM runtime is installed, so untrusted code is not executed." },
    { name: "Mobile CI runners", state: "unavailable", detail: "No bare-metal ARM64 pool, Gradle daemon snapshot, or Android SDK runner is configured." },
    { name: "Play Integrity and App Attest", state: "unavailable", detail: "No attestation credentials are configured." },
    { name: "AI Gateway", state: "unavailable", detail: "No model provider key is configured." },
    { name: "Workflow worker", state: "unavailable", detail: "Workflows can be saved. Runs are recorded and are not executed." },
    { name: "Webhook delivery", state: "unavailable", detail: "Webhook setup stores metadata only; no outbound requests are sent." },
    { name: "Console screen privacy", state: "active", detail: "The optional screen password does not authorize API requests." },
    { name: "Local resource records", state: "active", detail: "Functions, DNS, team invites and billing are not provisioned; storage and databases have limited local-only lifecycles." },
  ];
}
