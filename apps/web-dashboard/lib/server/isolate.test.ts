import assert from "node:assert/strict";
import test from "node:test";
import { executeFunction, isolatedRuntimeAllowed, isolatedSpawnArgs, runFunctionIsolated, runtimeEnabled } from "./isolate.ts";
import { FunctionError, type FunctionRequest } from "./runtime.ts";

/**
 * Hostile-code acceptance suite for the process-isolated runner (P1).
 *
 * Each case drives deliberately hostile handler source through a real child
 * process and asserts the *server* survives. This is the acceptance test the
 * roadmap asks for: the boundary is the OS process, not the `vm` realm.
 */

const req: FunctionRequest = { method: "POST", path: "/fn", query: {}, headers: {}, body: { hello: "world" } };

test("the child is spawned with a hard memory ceiling", () => {
  const args = isolatedSpawnArgs(128);
  assert.ok(args.some((arg) => arg === "--max-old-space-size=128"), "expected an old-space cap in argv");
  assert.equal(args[args.length - 2], "-e");
});

test("a handler runs in the child and its response is normalised", () => {
  const result = runFunctionIsolated("module.exports = (req) => ({ status: 201, body: { echo: req.body.hello } });", req);
  assert.equal(result.status, 201);
  assert.deepEqual(result.body, { echo: "world" });
  assert.equal(typeof result.durationMs, "number");
});

test("the child still cannot reach host globals", () => {
  for (const source of [
    "module.exports = () => process.env;",
    "module.exports = () => require('node:fs');",
    "module.exports = () => fetch('http://example.com');",
  ]) {
    assert.throws(() => runFunctionIsolated(source, req), (error: unknown) => error instanceof FunctionError && error.status === 422);
  }
});

test("a runaway handler is killed and the server keeps serving", () => {
  assert.throws(
    () => runFunctionIsolated("module.exports = () => { while (true) {} };", req, { timeoutMs: 150 }),
    (error: unknown) => error instanceof FunctionError && error.status === 422,
  );
  // The parent is unaffected: a later, well-behaved handler still executes.
  assert.equal(runFunctionIsolated("module.exports = () => 'still alive';", req).body, "still alive");
});

test("a memory-hungry handler is bounded by the child, not the server", () => {
  assert.throws(
    () => runFunctionIsolated("module.exports = () => { const a = []; while (true) { a.push('x'.repeat(1e6)); } };", req, { timeoutMs: 200 }),
    (error: unknown) => error instanceof FunctionError && error.status === 422,
  );
  assert.equal(runFunctionIsolated("module.exports = () => 1 + 1;", req).body, 2);
});

test("a handler that throws is reported without crashing the runner", () => {
  assert.throws(
    () => runFunctionIsolated("module.exports = () => { throw new Error('kaboom'); };", req),
    (error: unknown) => error instanceof FunctionError && error.status === 422 && /kaboom/.test(error.message),
  );
});

test("oversized output is rejected in the child", () => {
  assert.throws(
    () => runFunctionIsolated("module.exports = () => 'x'.repeat(300000);", req),
    (error: unknown) => error instanceof FunctionError && error.status === 413,
  );
});

test("an async handler is rejected instead of running unbounded", () => {
  assert.throws(
    () => runFunctionIsolated("module.exports = async () => 1;", req),
    (error: unknown) => error instanceof FunctionError && error.status === 422,
  );
});

test("isolation is opt-in and the runtime gate honours it", (t) => {
  const previous = process.env.MOBILECLOUD_ISOLATED_RUNTIME;
  t.after(() => { if (previous === undefined) delete process.env.MOBILECLOUD_ISOLATED_RUNTIME; else process.env.MOBILECLOUD_ISOLATED_RUNTIME = previous; });

  delete process.env.MOBILECLOUD_ISOLATED_RUNTIME;
  assert.equal(isolatedRuntimeAllowed(), false);
  assert.equal(runtimeEnabled({ NODE_ENV: "production" } as unknown as NodeJS.ProcessEnv), false);
  assert.equal(runtimeEnabled({ NODE_ENV: "production", MOBILECLOUD_ISOLATED_RUNTIME: "1" } as unknown as NodeJS.ProcessEnv), true);

  process.env.MOBILECLOUD_ISOLATED_RUNTIME = "1";
  assert.equal(isolatedRuntimeAllowed(), true);
  // executeFunction now takes the isolated path and behaves identically.
  assert.equal(executeFunction("module.exports = () => 'isolated';", req).body, "isolated");
});
