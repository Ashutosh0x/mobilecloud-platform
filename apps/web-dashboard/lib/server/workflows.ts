import type { DatabaseSync } from "node:sqlite";
import { FunctionError, runFunction } from "./runtime.ts";

/**
 * Workflow worker.
 *
 * A workflow persists an ordered list of steps. Each step invokes one of the
 * owner's functions (by id or name) and passes along the previous step's
 * output as `input`. Steps run sequentially and stop at the first failure, so
 * a run has a definite, recorded outcome instead of "not executed".
 */

export type Step = { function: string; input?: unknown };

export type StepResult = {
  index: number;
  function: string;
  status: "succeeded" | "failed";
  output: unknown;
  error: string | null;
};

const MAX_STEPS = 20;

export function parseSteps(raw: unknown): Step[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new FunctionError(400, "steps must be an array");
  if (raw.length > MAX_STEPS) throw new FunctionError(400, `A workflow may have at most ${MAX_STEPS} steps`);
  return raw.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new FunctionError(400, `Step ${index + 1} must be an object`);
    }
    const value = entry as { function?: unknown; input?: unknown };
    const name = typeof value.function === "string" ? value.function.trim() : "";
    if (!name) throw new FunctionError(400, `Step ${index + 1} needs a function id or name`);
    return { function: name, input: value.input };
  });
}

export function parseStoredSteps(raw: string | null): Step[] {
  if (!raw) return [];
  try {
    return parseSteps(JSON.parse(raw));
  } catch (error) {
    throw new FunctionError(500, `Stored workflow steps are invalid: ${error instanceof Error ? error.message : "parse error"}`);
  }
}

function findFunction(db: DatabaseSync, owner: string, reference: string) {
  return db.prepare(
    "SELECT id, name, route, source FROM functions WHERE owner_id = ? AND (id = ? OR name = ?) LIMIT 1",
  ).get(owner, reference, reference) as { id: string; name: string; route: string; source: string | null } | undefined;
}

export type WorkflowOutcome = { status: "succeeded" | "failed"; note: string; steps: StepResult[] };

export function runWorkflow(db: DatabaseSync, owner: string, workflow: { id: string; name: string; steps: string | null }): WorkflowOutcome {
  const steps = parseStoredSteps(workflow.steps);
  const results: StepResult[] = [];
  let previous: unknown = null;

  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    const target = findFunction(db, owner, step.function);
    if (!target) {
      results.push({ index, function: step.function, status: "failed", output: null, error: "Function not found" });
      return { status: "failed", note: `Step ${index + 1} (${step.function}) failed: function not found`, steps: results };
    }
    if (!target.source) {
      results.push({ index, function: target.name, status: "failed", output: null, error: "No handler source is stored" });
      return { status: "failed", note: `Step ${index + 1} (${target.name}) failed: no handler source is stored`, steps: results };
    }
    try {
      const result = runFunction(target.source, {
        method: "POST",
        path: target.route,
        query: {},
        headers: {},
        body: { input: step.input ?? previous, step: index, workflow: workflow.name },
      });
      previous = result.body;
      results.push({ index, function: target.name, status: "succeeded", output: result.body ?? null, error: null });
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      results.push({ index, function: target.name, status: "failed", output: null, error: message });
      return { status: "failed", note: `Step ${index + 1} (${target.name}) failed: ${message}`, steps: results };
    }
  }

  return { status: "succeeded", note: `${steps.length} step${steps.length === 1 ? "" : "s"} executed`, steps: results };
}
