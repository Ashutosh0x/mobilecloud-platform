import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openDb, newId } from "./db.ts";
import { FunctionError } from "./runtime.ts";
import { parseSteps, runWorkflow } from "./workflows.ts";

const db = openDb(join(mkdtempSync(join(tmpdir(), "mc-wf-")), "t.db"));
const owner = "owner-1";

function addFunction(name: string, source: string | null): string {
  const id = newId();
  db.prepare("INSERT INTO functions (id, owner_id, name, route, source, invocations, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)")
    .run(id, owner, name, `/${name}`, source, Date.now());
  return id;
}

addFunction("double", "module.exports = (req) => ({ body: { value: (req.body.input ?? 0) * 2 } });");
addFunction("increment", "module.exports = (req) => ({ body: { value: (req.body.input?.value ?? req.body.input ?? 0) + 1 } });");
addFunction("boom", "module.exports = () => { throw new Error('nope'); };");
addFunction("empty", null);

test("step lists are validated before they are stored", () => {
  assert.deepEqual(parseSteps([{ function: "double" }]), [{ function: "double", input: undefined }]);
  assert.throws(() => parseSteps("nope"), (error: unknown) => error instanceof FunctionError && error.status === 400);
  assert.throws(() => parseSteps([{ input: 1 }]), (error: unknown) => error instanceof FunctionError && error.status === 400);
  assert.throws(() => parseSteps(Array.from({ length: 21 }, () => ({ function: "double" }))), (error: unknown) => error instanceof FunctionError && error.status === 400);
});

test("a workflow threads each step's output into the next step", () => {
  const workflow = { id: "wf-1", name: "math", steps: JSON.stringify([{ function: "double", input: 5 }, { function: "increment" }]) };
  const outcome = runWorkflow(db, owner, workflow);
  assert.equal(outcome.status, "succeeded");
  assert.deepEqual(outcome.steps.map((step) => step.status), ["succeeded", "succeeded"]);
  // 5 * 2 = 10, then 10 + 1 = 11: the previous output was passed through.
  assert.deepEqual(JSON.parse(JSON.stringify(outcome.steps[1].output)), { value: 11 });
});

test("a workflow stops at the first failing step and records why", () => {
  const outcome = runWorkflow(db, owner, { id: "wf-2", name: "broken", steps: JSON.stringify([{ function: "boom" }, { function: "double" }]) });
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.steps.length, 1);
  assert.match(outcome.note, /boom/);
  assert.match(outcome.steps[0].error ?? "", /nope/);
});

test("a step that references a missing function fails cleanly", () => {
  const outcome = runWorkflow(db, owner, { id: "wf-3", name: "ghost", steps: JSON.stringify([{ function: "does-not-exist" }]) });
  assert.equal(outcome.status, "failed");
  assert.match(outcome.steps[0].error ?? "", /not found/);
});

test("a function with no stored source is not executed", () => {
  const outcome = runWorkflow(db, owner, { id: "wf-4", name: "sourceless", steps: JSON.stringify([{ function: "empty" }]) });
  assert.equal(outcome.status, "failed");
  assert.match(outcome.steps[0].error ?? "", /No handler source/);
});
