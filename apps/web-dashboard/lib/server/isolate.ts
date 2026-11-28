import { spawnSync } from "node:child_process";
import {
  FunctionError,
  MAX_OUTPUT_BYTES,
  inProcessRuntimeAllowed,
  normalizeResult,
  runFunction,
  validateSource,
  type FunctionRequest,
  type FunctionResult,
} from "./runtime.ts";

/**
 * Process-isolated handler runtime (P1).
 *
 * The bounded `node:vm` runtime in `runtime.ts` isolates globals but not the
 * process: a handler that allocates without bound or ignores its budget runs
 * inside the server. This runner executes the same handler in a *separate,
 * resource-limited child process* instead:
 *
 *  - a fresh child process per invocation, so a crash, `process.exit`, or an
 *    out-of-memory handler can only take down the child, never the server;
 *  - a hard V8 old-space ceiling (`--max-old-space-size`), so a memory bomb is
 *    killed by the allocator rather than the host;
 *  - a wall-clock budget enforced both inside the child (via `vm`) and by the
 *    parent as a backstop that SIGKILLs a child that ignores it;
 *  - the child still evaluates the handler inside `vm` with `codeGeneration`
 *    disabled, so the "no host globals" property is preserved.
 *
 * What this is *not*: a filesystem or network jail. The child shares the host
 * kernel and filesystem namespace; it is process and resource isolation, not a
 * container. Operators who need a syscall/interfaces boundary must place the
 * server inside one (seccomp, gVisor, a container). It is enabled with
 * `MOBILECLOUD_ISOLATED_RUNTIME=1`; without it the in-process runtime gate is
 * unchanged and production stays fail-closed.
 */

const EXEC_TIMEOUT_MS = 250;
/** Backstop: if the child ignores its own budget, the parent kills it here. */
const PARENT_KILL_GRACE_MS = 1000;
const CHILD_MAX_OLD_SPACE_MB = 128;
const CHILD_MAX_BUFFER = MAX_OUTPUT_BYTES + 64 * 1024;

/**
 * The child bootstrap. It is a self-contained module passed to `node -e` so it
 * needs no build step or import graph of its own. It reads one JSON request on
 * stdin and writes one JSON reply on stdout.
 */
const BOOTSTRAP = `
const { createContext, Script } = require("node:vm");
const noop = () => {};
const reply = (value) => { process.stdout.write(JSON.stringify(value)); };
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", () => {
  let payload;
  try { payload = JSON.parse(raw); } catch (error) { return reply({ ok: false, status: 422, message: "Isolated runner received a malformed request" }); }
  const source = payload.source;
  const req = payload.req;
  const timeoutMs = payload.timeoutMs;
  const maxOutputBytes = payload.maxOutputBytes;
  const moduleObject = { exports: {} };
  const sandbox = {
    console: Object.freeze({ log: noop, info: noop, warn: noop, error: noop, debug: noop }),
    JSON: JSON, Math: Math, Date: Date, URL: URL, URLSearchParams: URLSearchParams,
    TextEncoder: TextEncoder, TextDecoder: TextDecoder,
    Array: Array, Object: Object, String: String, Number: Number, Boolean: Boolean, BigInt: BigInt,
    Promise: Promise, Error: Error, TypeError: TypeError, RangeError: RangeError, RegExp: RegExp,
    Map: Map, Set: Set, WeakMap: WeakMap, WeakSet: WeakSet, Symbol: Symbol,
    isNaN: isNaN, isFinite: isFinite, parseInt: parseInt, parseFloat: parseFloat,
    encodeURIComponent: encodeURIComponent, decodeURIComponent: decodeURIComponent, structuredClone: structuredClone,
    module: moduleObject, exports: moduleObject.exports, __req: Object.freeze(req)
  };
  try {
    const context = createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
    new Script(source, { filename: "handler.js" }).runInContext(context, { timeout: timeoutMs });
    let handler = null;
    if (typeof moduleObject.exports === "function") handler = moduleObject.exports;
    else if (moduleObject.exports && typeof moduleObject.exports.handler === "function") handler = moduleObject.exports.handler;
    else if (typeof sandbox.handler === "function") handler = sandbox.handler;
    if (!handler) return reply({ ok: false, status: 422, message: "Function must export a handler via module.exports or exports.handler" });
    sandbox.__handler = handler;
    const value = new Script("__handler(__req)").runInContext(context, { timeout: timeoutMs });
    if (value && (typeof value === "object" || typeof value === "function") && typeof value.then === "function") {
      return reply({ ok: false, status: 422, message: "Async handlers are not supported; return a value synchronously" });
    }
    const encoded = JSON.stringify(value === undefined ? null : value);
    if (encoded && encoded.length > maxOutputBytes) return reply({ ok: false, status: 413, message: "Handler response exceeds 256 KB" });
    return reply({ ok: true, value: value === undefined ? null : value });
  } catch (error) {
    const message = error && error.message ? String(error.message).slice(0, 300) : "unknown error";
    if (/timed out/i.test(message)) return reply({ ok: false, status: 422, message: "Function exceeded the " + timeoutMs + " ms execution budget" });
    return reply({ ok: false, status: 422, message: "Function threw: " + message });
  }
});
`;

/** Process isolation is opt-in so the fail-closed default is unchanged. */
export function isolatedRuntimeAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|on)$/i.test((env.MOBILECLOUD_ISOLATED_RUNTIME ?? "").trim());
}

/** Exporting the argv keeps the resource flags reviewable and testable. */
export function isolatedSpawnArgs(maxOldSpaceMb = CHILD_MAX_OLD_SPACE_MB): string[] {
  return [`--max-old-space-size=${maxOldSpaceMb}`, "-e", BOOTSTRAP];
}

/** Functions are live when either runtime is enabled. */
export function runtimeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isolatedRuntimeAllowed(env) || inProcessRuntimeAllowed(env);
}

/** Picks the isolated runner when enabled, otherwise the in-process runtime. */
export function executeFunction(source: string, req: FunctionRequest): FunctionResult {
  return isolatedRuntimeAllowed() ? runFunctionIsolated(source, req) : runFunction(source, req);
}

/** {@link executeFunction} but always the child process, regardless of config. */
export function runFunctionIsolated(
  source: string,
  req: FunctionRequest,
  options: { timeoutMs?: number; maxOldSpaceMb?: number } = {},
): FunctionResult {
  validateSource(source);
  const timeoutMs = options.timeoutMs ?? EXEC_TIMEOUT_MS;
  const started = Date.now();
  const child = spawnSync(process.execPath, isolatedSpawnArgs(options.maxOldSpaceMb), {
    input: JSON.stringify({ source, req, timeoutMs, maxOutputBytes: MAX_OUTPUT_BYTES }),
    timeout: timeoutMs + PARENT_KILL_GRACE_MS,
    maxBuffer: CHILD_MAX_BUFFER,
    encoding: "utf8",
    windowsHide: true,
  });

  const code = (child.error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ETIMEDOUT") throw new FunctionError(422, `Function exceeded the ${timeoutMs} ms execution budget`);
  if (code === "ENOBUFS") throw new FunctionError(413, "Handler response exceeds 256 KB");
  if (child.error) throw new FunctionError(422, `Isolated runner could not start: ${child.error.message}`);
  if (child.signal) {
    throw new FunctionError(422, `Isolated runner was terminated (${child.signal}); the function exceeded its memory or time budget`);
  }

  const stdout = (child.stdout ?? "").trim();
  if (!stdout) {
    const stderr = (child.stderr ?? "").trim().slice(0, 200);
    throw new FunctionError(422, `Isolated runner produced no response (exit ${child.status ?? "null"})${stderr ? `: ${stderr}` : ""}`);
  }
  let reply: { ok?: boolean; value?: unknown; status?: number; message?: string };
  try {
    reply = JSON.parse(stdout) as typeof reply;
  } catch {
    throw new FunctionError(422, "Isolated runner returned a malformed response");
  }
  if (!reply.ok) {
    throw new FunctionError(typeof reply.status === "number" ? reply.status : 422, reply.message ?? "Function failed");
  }
  const normalized = normalizeResult(reply.value);
  return { ...normalized, durationMs: Date.now() - started };
}
