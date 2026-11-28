/**
 * Dispatch to the Rust core engine.
 *
 * The engine clones and builds repository code, and its management API is a
 * loopback service guarded by a bearer credential. The dashboard only ever
 * talks to it when an operator has explicitly configured *both* the base URL
 * and the shared token; with either missing, every route stays fail-closed and
 * records nothing. The engine is always the authority: it re-validates the
 * project, the clone URL and the ref, and refuses anything it was not
 * configured for.
 */

export const BUILDER_DISABLED =
  "Engine dispatch is disabled. Configure MOBILECLOUD_BUILDER_URL and MOBILECLOUD_BUILDER_TOKEN to dispatch to an isolated engine.";

export type BuilderConfig = { enabled: boolean; url: string; token: string };

/** Reads the engine endpoint. Enabled only with a usable URL *and* a token. */
export function builderConfig(env: NodeJS.ProcessEnv = process.env): BuilderConfig {
  const url = (env.MOBILECLOUD_BUILDER_URL ?? "").trim().replace(/\/+$/, "");
  const token = (env.MOBILECLOUD_BUILDER_TOKEN ?? "").trim();
  let valid = false;
  if (url && token) {
    try {
      const parsed = new URL(url);
      valid = (parsed.protocol === "http:" || parsed.protocol === "https:") && !parsed.username && !parsed.password && !parsed.search && !parsed.hash;
    } catch {
      valid = false;
    }
  }
  return { enabled: valid, url, token };
}

export type DeployRequest = { project: string; cloneUrl: string; branch: string; commit?: string; agentId?: string };

export type EngineResult = { ok: boolean; status: number; note: string };

async function callEngine(
  config: BuilderConfig,
  path: string,
  body: unknown,
  timeoutMs: number,
): Promise<EngineResult> {
  if (!config.enabled) return { ok: false, status: 0, note: BUILDER_DISABLED };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${config.url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.token}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const detail = (await response.text()).slice(0, 400).trim();
    return {
      ok: response.ok,
      status: response.status,
      note: response.ok ? "Dispatched to the engine." : `Engine refused the request (HTTP ${response.status}): ${detail || "no detail"}`,
    };
  } catch (error) {
    const detail = error instanceof Error && error.name === "AbortError" ? `timed out after ${timeoutMs} ms` : error instanceof Error ? error.message : "unreachable";
    return { ok: false, status: 0, note: `Engine unreachable: ${detail}` };
  } finally {
    clearTimeout(timer);
  }
}

/** Queues a build for [request] on the engine. Never throws. */
export async function dispatchDeploy(config: BuilderConfig, request: DeployRequest, timeoutMs = 10_000): Promise<EngineResult> {
  return callEngine(config, "/api/v1/deploy/agent", {
    project: request.project,
    clone_url: request.cloneUrl,
    branch: request.branch,
    commit: request.commit,
    agent_id: request.agentId ?? "dashboard",
  }, timeoutMs);
}

/** Rolls the engine back to a previous deployment artifact. Never throws. */
export async function dispatchRollback(config: BuilderConfig, project: string, deployId: string, timeoutMs = 10_000): Promise<EngineResult> {
  return callEngine(config, "/api/v1/deploy/rollback", { project, deploy_id: deployId }, timeoutMs);
}

/** Best-effort liveness probe against the engine's public health route. */
export async function probeBuilder(config: BuilderConfig, timeoutMs = 2000): Promise<boolean> {
  if (!config.enabled) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${config.url}/healthz`, { signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
