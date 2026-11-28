import type { DatabaseSync } from "node:sqlite";

/**
 * Subsystem health for the console's global health banner.
 *
 * Every entry is a check this process actually performed: the database is
 * queried, the realtime gateway and the edge engine are probed over HTTP with
 * a hard timeout. A subsystem that is not deployed is reported as
 * `unconfigured` rather than as a failure — the banner must distinguish
 * "broken" from "not installed here", because only the first is an incident.
 *
 * Nothing in this module invents a metric. If a check cannot run, the detail
 * says why.
 */

export type SubsystemStatus = "healthy" | "degraded" | "down" | "unconfigured";

export type Subsystem = {
  id: string;
  label: string;
  status: SubsystemStatus;
  detail: string;
  /** Round-trip time of the probe in milliseconds; null when nothing answered. */
  latencyMs: number | null;
  checkedAt: number;
};

export type SubsystemReport = {
  checkedAt: number;
  /** The aggregate the banner shows. Unconfigured subsystems never degrade it. */
  status: "healthy" | "degraded" | "down";
  subsystems: Subsystem[];
};

export type HealthTargets = {
  /** Base URL of the realtime gateway, e.g. `http://127.0.0.1:3211`. */
  realtimeUrl?: string | null;
  /** Base URL of the Rust edge engine, e.g. `http://127.0.0.1:3000`. */
  engineUrl?: string | null;
  /** Base URL of the sovereign DNS management API, e.g. `http://127.0.0.1:8053`. */
  dnsApiUrl?: string | null;
  /** Per-probe timeout. A probe that exceeds it counts as down. */
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 2500;

type Probe = { ok: boolean; status: number | null; latencyMs: number; detail: string };

/**
 * A single HTTP probe. It never throws: a refused connection, a timeout and a
 * 500 are all results the banner can describe.
 */
export async function probe(url: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<Probe> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json" },
      redirect: "manual",
    });
    return {
      ok: response.ok,
      status: response.status,
      latencyMs: Date.now() - started,
      detail: `HTTP ${response.status}`,
    };
  } catch (error) {
    const detail = error instanceof Error && error.name === "AbortError"
      ? `No answer within ${timeoutMs} ms`
      : error instanceof Error && error.message
        ? error.message
        : "Unreachable";
    return { ok: false, status: null, latencyMs: Date.now() - started, detail };
  } finally {
    clearTimeout(timer);
  }
}

function trim(url: string | null | undefined): string | null {
  const value = (url ?? "").trim();
  return value ? value.replace(/\/+$/, "") : null;
}

/**
 * Probes every subsystem the deployment knows about and aggregates the result.
 *
 * The aggregate ignores `unconfigured` subsystems: an installation without an
 * edge engine is not degraded, it simply does not run one. A `down` subsystem
 * fails the whole report; anything else that is not healthy degrades it.
 */
export async function collectSubsystems(db: DatabaseSync, targets: HealthTargets = {}): Promise<SubsystemReport> {
  const timeoutMs = targets.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const checkedAt = Date.now();
  const subsystems: Subsystem[] = [];

  // The identity plane itself. We are executing, so it answered.
  subsystems.push({
    id: "control_plane",
    label: "Control plane",
    status: "healthy",
    detail: "This API process answered the request.",
    latencyMs: null,
    checkedAt,
  });

  // The database is a real query, not a flag.
  try {
    db.prepare("SELECT 1").get();
    subsystems.push({
      id: "database",
      label: "Account database",
      status: "healthy",
      detail: "The SQLite store answered a read.",
      latencyMs: null,
      checkedAt,
    });
  } catch (error) {
    subsystems.push({
      id: "database",
      label: "Account database",
      status: "down",
      detail: error instanceof Error && error.message ? error.message : "The database did not answer.",
      latencyMs: null,
      checkedAt,
    });
  }

  const realtime = trim(targets.realtimeUrl);
  if (!realtime) {
    subsystems.push({
      id: "realtime",
      label: "Realtime gateway",
      status: "unconfigured",
      detail: "No realtime gateway URL is configured for this deployment.",
      latencyMs: null,
      checkedAt,
    });
  } else {
    const result = await probe(`${realtime}/api/health`, timeoutMs);
    subsystems.push({
      id: "realtime",
      label: "Realtime gateway",
      status: result.ok ? "healthy" : "down",
      detail: result.ok ? "The gateway answered its health probe." : result.detail,
      latencyMs: result.latencyMs,
      checkedAt,
    });
  }

  const engine = trim(targets.engineUrl);
  if (!engine) {
    subsystems.push({
      id: "edge_engine",
      label: "Edge engine",
      status: "unconfigured",
      detail: "No edge engine is attached to this deployment.",
      latencyMs: null,
      checkedAt,
    });
  } else {
    const result = await probe(`${engine}/healthz`, timeoutMs);
    subsystems.push({
      id: "edge_engine",
      label: "Edge engine",
      status: result.ok ? "healthy" : "down",
      detail: result.ok ? "The engine answered its health probe." : result.detail,
      latencyMs: result.latencyMs,
      checkedAt,
    });
  }

  const dns = trim(targets.dnsApiUrl);
  if (!dns) {
    subsystems.push({
      id: "dns_authority",
      label: "Sovereign DNS authority",
      status: "unconfigured",
      detail: "No DNS authority API is attached to this deployment.",
      latencyMs: null,
      checkedAt,
    });
  } else {
    const result = await probe(`${dns}/api/v1/dns/health`, timeoutMs);
    subsystems.push({
      id: "dns_authority",
      label: "Sovereign DNS authority",
      status: result.ok ? "healthy" : "down",
      detail: result.ok ? "The authority answered its health probe." : result.detail,
      latencyMs: result.latencyMs,
      checkedAt,
    });
  }

  const status: SubsystemReport["status"] = subsystems.some((entry) => entry.status === "down")
    ? "down"
    : subsystems.some((entry) => entry.status === "degraded")
      ? "degraded"
      : "healthy";

  return { checkedAt, status, subsystems };
}
