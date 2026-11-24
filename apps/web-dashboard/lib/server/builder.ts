/**
 * Core-engine client.
 *
 * The core engine (`mobilecloud-core`) is the on-device builder: a Rust daemon
 * that clones a repository, runs the framework build, and atomically promotes
 * the resulting deployment. It listens on loopback (`http://127.0.0.1:3000` by
 * default, relocatable with `MOBILECLOUD_BIND`) and the dashboard reaches it
 * over that loopback interface (or a tunnel) at `MOBILECLOUD_BUILDER_URL`.
 *
 * Every function here is best-effort and never fabricates success: an
 * unreachable engine or a non-2xx response is reported as a failure with the
 * engine's own message, so the caller can record an honest result.
 */

const CONTROL_TIMEOUT_MS = 4000;
const HEALTH_TIMEOUT_MS = 1500;
const DEFAULT_BASE_URL = "http://127.0.0.1:3000";

/** Base URL of the core engine, or `""` when the builder is explicitly disabled. */
export function builderBaseUrl(): string {
  const configured = process.env.MOBILECLOUD_BUILDER_URL;
  if (configured !== undefined && configured.trim() === "") return "";
  return configured?.trim() || DEFAULT_BASE_URL;
}

/** Bearer token the engine expects when `MOBILECLOUD_WEBHOOK_SECRET` is set. */
export function builderToken(): string | null {
  return (
    process.env.MOBILECLOUD_BUILDER_TOKEN?.trim() ||
    process.env.MOBILECLOUD_WEBHOOK_SECRET?.trim() ||
    null
  );
}

/** True when a base URL is configured. The loopback default counts as enabled. */
export function builderEnabled(): boolean {
  return builderBaseUrl() !== "";
}

export type EngineResult = { ok: boolean; status: number; detail: string; body: unknown };

function authHeaders(json: boolean): Record<string, string> {
  const headers: Record<string, string> = {};
  if (json) headers["content-type"] = "application/json";
  const token = builderToken();
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Pulls the most useful human string out of an engine response body. */
function messageOf(body: unknown): string | null {
  if (typeof body === "string") return body.trim() || null;
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    for (const key of ["status", "error", "message"]) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  return null;
}

function unreachable(baseUrl: string, error: unknown): string {
  const cause = error instanceof Error ? error.message : String(error);
  return `engine unreachable at ${baseUrl}: ${cause}`;
}

const DISABLED = "No build runner is configured. Set MOBILECLOUD_BUILDER_URL to a reachable builder.";

/** Health probe. Never throws; reports reachability honestly. */
export async function probeBuilder(): Promise<{ reachable: boolean; baseUrl: string; detail: string; health?: unknown }> {
  const baseUrl = builderBaseUrl();
  if (!baseUrl) return { reachable: false, baseUrl, detail: "builder disabled: MOBILECLOUD_BUILDER_URL is empty" };
  try {
    const res = await fetch(`${baseUrl}/healthz`, {
      headers: authHeaders(false),
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    const health = await readBody(res);
    if (!res.ok) return { reachable: false, baseUrl, detail: `engine answered HTTP ${res.status} on /healthz`, health };
    return { reachable: true, baseUrl, detail: `engine healthy (HTTP ${res.status})`, health };
  } catch (error) {
    return { reachable: false, baseUrl, detail: unreachable(baseUrl, error) };
  }
}

/** Queues an agent-triggered deploy on the core engine. Never throws. */
export async function dispatchDeploy(input: {
  project: string;
  cloneUrl: string;
  branch?: string;
  commit?: string;
  agentId?: string;
}): Promise<EngineResult> {
  const baseUrl = builderBaseUrl();
  if (!baseUrl) return { ok: false, status: 0, detail: DISABLED, body: null };
  const payload: Record<string, string> = {
    project: input.project,
    clone_url: input.cloneUrl,
    branch: input.branch?.trim() || "main",
  };
  if (input.commit?.trim()) payload.commit = input.commit.trim();
  if (input.agentId?.trim()) payload.agent_id = input.agentId.trim();
  try {
    const res = await fetch(`${baseUrl}/api/v1/deploy/agent`, {
      method: "POST",
      headers: authHeaders(true),
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
    });
    const body = await readBody(res);
    if (res.status === 202) return { ok: true, status: res.status, detail: messageOf(body) ?? `HTTP ${res.status}`, body };
    return { ok: false, status: res.status, detail: messageOf(body) ?? `engine answered HTTP ${res.status}`, body };
  } catch (error) {
    return { ok: false, status: 0, detail: unreachable(baseUrl, error), body: null };
  }
}

/** Rolls a project back to a prior deploy id. Never throws. */
export async function dispatchRollback(input: { project: string; deployId: string }): Promise<EngineResult> {
  const baseUrl = builderBaseUrl();
  if (!baseUrl) return { ok: false, status: 0, detail: DISABLED, body: null };
  try {
    const res = await fetch(`${baseUrl}/api/v1/deploy/rollback`, {
      method: "POST",
      headers: authHeaders(true),
      body: JSON.stringify({ project: input.project, deploy_id: input.deployId }),
      signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
    });
    const body = await readBody(res);
    if (res.ok) return { ok: true, status: res.status, detail: messageOf(body) ?? `HTTP ${res.status}`, body };
    return { ok: false, status: res.status, detail: messageOf(body) ?? `engine answered HTTP ${res.status}`, body };
  } catch (error) {
    return { ok: false, status: 0, detail: unreachable(baseUrl, error), body: null };
  }
}

/** Reads the engine's deployment history for a project. Never throws. */
export async function fetchEngineDeployments(project: string): Promise<EngineResult> {
  const baseUrl = builderBaseUrl();
  if (!baseUrl) return { ok: false, status: 0, detail: DISABLED, body: null };
  try {
    const res = await fetch(`${baseUrl}/api/v1/deployments/${encodeURIComponent(project)}`, {
      headers: authHeaders(false),
      signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
    });
    const body = await readBody(res);
    if (res.ok) return { ok: true, status: res.status, detail: `HTTP ${res.status}`, body };
    return { ok: false, status: res.status, detail: messageOf(body) ?? `engine answered HTTP ${res.status}`, body };
  } catch (error) {
    return { ok: false, status: 0, detail: unreachable(baseUrl, error), body: null };
  }
}
