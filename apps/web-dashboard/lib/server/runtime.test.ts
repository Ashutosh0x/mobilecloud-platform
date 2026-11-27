import assert from "node:assert/strict";
import test from "node:test";
import { FunctionError, MAX_SOURCE_BYTES, runFunction, validateSource } from "./runtime.ts";

const req = { method: "POST", path: "/fn", query: {}, headers: {}, body: { hello: "world" } };

test("a handler runs and its response is normalised", () => {
  const result = runFunction("module.exports = (req) => ({ status: 201, body: { echo: req.body.hello } });", req);
  assert.equal(result.status, 201);
  // The handler runs in a separate vm realm, so compare structurally, not by prototype.
  assert.deepEqual(JSON.parse(JSON.stringify(result.body)), { echo: "world" });
  assert.equal(typeof result.durationMs, "number");
});

test("a bare module.exports function and a named handler both resolve", () => {
  assert.equal(runFunction("module.exports = () => 'bare';", req).body, "bare");
  assert.equal(runFunction("exports.handler = () => 'named';", req).body, "named");
});

test("a handler cannot reach the host process, require, or fetch", () => {
  for (const source of [
    "module.exports = () => process.env;",
    "module.exports = () => require('node:fs');",
    "module.exports = () => fetch('http://example.com');",
  ]) {
    assert.throws(() => runFunction(source, req), (error: unknown) => error instanceof FunctionError && error.status === 422);
  }
});

test("a handler with no exported function is rejected", () => {
  assert.throws(() => runFunction("const x = 1;", req), (error: unknown) => error instanceof FunctionError && error.status === 422);
});

test("an async handler is rejected instead of running unbounded", () => {
  assert.throws(() => runFunction("module.exports = async () => 1;", req), /Async handlers/);
});

test("a runaway handler is stopped by the execution budget", () => {
  assert.throws(() => runFunction("module.exports = () => { while (true) {} };", req), /budget/);
});

test("handler output size and status are validated", () => {
  assert.throws(() => runFunction("module.exports = () => ({ status: 999, body: 1 });", req), (error: unknown) => error instanceof FunctionError && error.status === 422);
  assert.throws(
    () => runFunction("module.exports = () => 'x'.repeat(300000);", req),
    (error: unknown) => error instanceof FunctionError && error.status === 413,
  );
});

test("stored source is bounded and must be a non-empty string", () => {
  assert.equal(validateSource("module.exports = () => 1;"), "module.exports = () => 1;");
  assert.throws(() => validateSource("   "), (error: unknown) => error instanceof FunctionError && error.status === 400);
  assert.throws(() => validateSource("x".repeat(MAX_SOURCE_BYTES + 1)), (error: unknown) => error instanceof FunctionError && error.status === 413);
});
