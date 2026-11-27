import { createContext, Script } from "node:vm";

/**
 * In-process handler runtime for the Functions surface.
 *
 * A function stores a small JavaScript module body. It is executed inside a
 * Node `vm` context that has no `require`, `process`, `fetch`, filesystem, or
 * timer access, so a stored handler cannot reach the host. Execution is
 * synchronous and bounded by a wall-clock timeout; an async handler is
 * rejected rather than left to run unbounded.
 *
 * This is intentionally a *bounded* runtime, not a sandbox for hostile code:
 * `vm` isolates globals but does not isolate the process. Only the signed-in
 * owner of a function can register or invoke it.
 */

export const MAX_SOURCE_BYTES = 32 * 1024;
export const MAX_OUTPUT_BYTES = 256 * 1024;
const EXEC_TIMEOUT_MS = 250;

/**
 * Whether the in-process runtime may execute untrusted handler code.
 *
 * Production is fail-closed: `vm` is not a sandbox, so operators must opt in
 * explicitly after moving execution to an isolated worker. Development and
 * tests keep the bounded runtime for the documented feature.
 */
export function inProcessRuntimeAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV !== "production" || /^(1|true|yes|on)$/i.test((env.MOBILECLOUD_IN_PROCESS_RUNTIME ?? "").trim());
}

/** Stable error text used by API routes and operators. */
export const RUNTIME_DISABLED =
  "In-process functions and workflows are disabled in production. Move execution to an isolated worker, or explicitly set MOBILECLOUD_IN_PROCESS_RUNTIME=1 for a non-production evaluation deployment.";

export type FunctionRequest = {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: unknown;
};

export type FunctionResult = {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  durationMs: number;
};

export class FunctionError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function validateSource(source: unknown): string {
  if (typeof source !== "string" || !source.trim()) throw new FunctionError(400, "Provide the function source");
  if (Buffer.byteLength(source, "utf8") > MAX_SOURCE_BYTES) throw new FunctionError(413, "Function source exceeds 32 KB");
  return source;
}

const noop = () => {};
const sandboxConsole = Object.freeze({ log: noop, info: noop, warn: noop, error: noop, debug: noop });

/** Deterministic, side-effect-free globals. Anything not listed is absent. */
function globals(): Record<string, unknown> {
  return {
    console: sandboxConsole,
    JSON, Math, Date, URL, URLSearchParams, TextEncoder, TextDecoder,
    Array, Object, String, Number, Boolean, BigInt, Promise, Error, TypeError, RangeError, RegExp, Map, Set, WeakMap, WeakSet, Symbol,
    isNaN, isFinite, parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
    structuredClone,
  };
}

/** Errors thrown inside the vm belong to another realm, so `instanceof` is unreliable. */
function describe(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 300);
  if (error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string") {
    return (error as { message: string }).message.slice(0, 300);
  }
  return "unknown error";
}

function isTimeout(error: unknown): boolean {
  return /timed out/i.test(describe(error));
}

function resolveHandler(exported: unknown, sandbox: Record<string, unknown>): ((req: unknown) => unknown) | null {
  if (typeof exported === "function") return exported as (req: unknown) => unknown;
  if (exported && typeof (exported as { handler?: unknown }).handler === "function") {
    return (exported as { handler: (req: unknown) => unknown }).handler;
  }
  if (typeof sandbox.handler === "function") return sandbox.handler as (req: unknown) => unknown;
  return null;
}

function normalize(raw: unknown): Omit<FunctionResult, "durationMs"> {
  if (raw === undefined || raw === null) return { status: 200, headers: {}, body: null };
  if (typeof raw === "string") {
    if (Buffer.byteLength(raw, "utf8") > MAX_OUTPUT_BYTES) throw new FunctionError(413, "Handler response exceeds 256 KB");
    return { status: 200, headers: {}, body: raw };
  }
  if (typeof raw === "number" || typeof raw === "boolean") {
    return { status: 200, headers: {}, body: raw };
  }
  if (typeof raw === "object") {
    const value = raw as { status?: unknown; headers?: unknown; body?: unknown };
    let status = 200;
    if (value.status !== undefined) {
      if (!Number.isInteger(value.status) || (value.status as number) < 100 || (value.status as number) > 599) {
        throw new FunctionError(422, "Handler status must be an integer from 100 to 599");
      }
      status = value.status as number;
    }
    const headers: Record<string, string> = {};
    if (value.headers && typeof value.headers === "object") {
      for (const [name, header] of Object.entries(value.headers as Record<string, unknown>)) {
        if (typeof header === "string" && /^[A-Za-z0-9-]{1,64}$/.test(name)) headers[name.toLowerCase()] = header.slice(0, 512);
      }
    }
    const body = "body" in value ? value.body : raw;
    const encoded = JSON.stringify(body ?? null);
    if (encoded.length > MAX_OUTPUT_BYTES) throw new FunctionError(413, "Handler response exceeds 256 KB");
    return { status, headers, body };
  }
  throw new FunctionError(422, "Handler must return a string, number, boolean, or object");
}

/** Runs [source] for [req]. Throws {@link FunctionError} on any failure. */
export function runFunction(source: string, req: FunctionRequest): FunctionResult {
  validateSource(source);
  const moduleObject = { exports: {} as unknown };
  const sandbox: Record<string, unknown> = { ...globals(), module: moduleObject, exports: moduleObject.exports, __req: Object.freeze({ ...req }) };
  const context = createContext(sandbox);
  const started = Date.now();
  try {
    new Script(source, { filename: "handler.js" }).runInContext(context, { timeout: EXEC_TIMEOUT_MS });
  } catch (error) {
    if (isTimeout(error)) {
      throw new FunctionError(422, `Function exceeded the ${EXEC_TIMEOUT_MS} ms execution budget`);
    }
    throw new FunctionError(422, `Function failed to load: ${describe(error)}`);
  }
  const handler = resolveHandler(moduleObject.exports, sandbox);
  if (!handler) throw new FunctionError(422, "Function must export a handler via module.exports or exports.handler");
  // The handler body is where user code actually runs, so it must be bounded too:
  // invoke it from inside the same context under the wall-clock timeout rather than
  // calling it directly (a direct call would run unbounded and hang the server).
  sandbox.__handler = handler;
  let result: unknown;
  try {
    result = new Script("__handler(__req)").runInContext(context, { timeout: EXEC_TIMEOUT_MS });
  } catch (error) {
    if (isTimeout(error)) {
      throw new FunctionError(422, `Function exceeded the ${EXEC_TIMEOUT_MS} ms execution budget`);
    }
    throw new FunctionError(422, `Function threw: ${describe(error)}`);
  }
  if (result && (typeof result === "object" || typeof result === "function") && typeof (result as { then?: unknown }).then === "function") {
    throw new FunctionError(422, "Async handlers are not supported; return a value synchronously");
  }
  const normalized = normalize(result);
  return { ...normalized, durationMs: Date.now() - started };
}
