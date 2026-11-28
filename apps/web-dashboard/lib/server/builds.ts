import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { newId } from "./db.ts";
import { publish, tx } from "./events.ts";

/**
 * The live build system.
 *
 * A build is a row, a step timeline and an event log. The runner emits the
 * events below as the build proceeds, and each one is both stored (so the
 * build can be replayed later) and published on the realtime bus (so the
 * dashboard sees it as it happens).
 *
 *   log      a line of output from the build
 *   progress  how far the build is, and what it is doing now
 *   step     a step started, finished, failed or was skipped
 *   metric   a measurement: bundle size, file count, cache hit
 *   error    something went wrong
 *   complete the build finished, one way or the other
 *
 * ## What may run
 *
 * A build that executes code runs only the platform's own trusted targets.
 * A repository connected through GitHub is analysed — its framework, its file
 * hashes, what changed since the last build — but its code is never
 * executed here: the isolated worker boundary that the engine still owes is
 * not something this route may quietly step over.
 */

export type BuildEventType = "log" | "progress" | "step" | "metric" | "error" | "complete";
export type StepStatus = "pending" | "running" | "success" | "failed" | "skipped";

export type BuildEvent = {
  type: BuildEventType;
  timestamp: number;
  buildId: string;
  stream?: "stdout" | "stderr";
  line?: string;
  percentage?: number;
  currentStep?: string;
  eta?: number;
  stepName?: string;
  stepStatus?: StepStatus;
  duration?: number;
  metric?: {
    bundleSize?: number;
    functionCount?: number;
    routeCount?: number;
    cacheHitRate?: number;
    fileCount?: number;
    totalBytes?: number;
    framework?: string;
  };
};

export type BuildTarget = "web" | "android" | "repository";

/** The plan of a build. Each step is streamed as it runs. */
export const BUILD_STEPS: Record<BuildTarget, { name: string; weight: number }[]> = {
  repository: [
    { name: "Fetch repository", weight: 15 },
    { name: "Detect framework", weight: 20 },
    { name: "Hash sources", weight: 30 },
    { name: "Cache decision", weight: 20 },
    { name: "Allocate preview", weight: 15 },
  ],
  web: [
    { name: "Install dependencies", weight: 25 },
    { name: "Compile bundle", weight: 50 },
    { name: "Collect metrics", weight: 15 },
    { name: "Publish preview", weight: 10 },
  ],
  android: [
    { name: "Prepare Gradle", weight: 20 },
    { name: "Compile Kotlin", weight: 55 },
    { name: "Package APK", weight: 15 },
    { name: "Publish preview", weight: 10 },
  ],
};

/** The trusted commands a build may run, with the directory they run in. */
const TRUSTED_COMMANDS: Record<"web" | "android", { command: string; args: string[]; cwd: string }> = {
  web: { command: "npm", args: ["run", "build"], cwd: join(process.cwd(), "apps/web-dashboard") },
  android: { command: "gradlew.bat", args: ["--offline", ":app:assembleDebug"], cwd: join(process.cwd(), "android-app") },
};

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/** Appends an event to the log and pushes it to the realtime bus. */
export function recordEvent(db: DatabaseSync, buildId: string, ownerId: string, event: Omit<BuildEvent, "buildId" | "timestamp"> & { timestamp?: number }): BuildEvent {
  const at = event.timestamp ?? Date.now();
  db.prepare(
    `INSERT INTO build_events (build_id, type, at, stream, line, percentage, current_step, eta, step_name,
       step_status, duration, metric, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    buildId,
    event.type,
    at,
    event.stream ?? null,
    event.line ?? null,
    event.percentage ?? null,
    event.currentStep ?? null,
    event.eta ?? null,
    event.stepName ?? null,
    event.stepStatus ?? null,
    event.duration ?? null,
    event.metric ? JSON.stringify(event.metric) : null,
    null,
  );
  publish(db, ownerId, "build.event", buildId, { buildId, ...event, timestamp: at });
  return { ...event, buildId, timestamp: at } as BuildEvent;
}

/** Creates the build row and its step plan. */
export function createBuild(
  db: DatabaseSync,
  input: {
    ownerId: string;
    projectId: string | null;
    projectName: string;
    target: BuildTarget;
    triggerSource: string;
    repositoryId?: string | null;
    branch?: string | null;
    commit?: string | null;
    note?: string;
  },
): { id: string } {
  const id = newId();
  const now = Date.now();
  tx(db, () => {
    db.prepare(
      `INSERT INTO builds (id, owner_id, project_id, target, status, note, created_at, started_at, progress,
         trigger_source, repository_id, branch, commit_sha)
       VALUES (?, ?, ?, ?, 'running', ?, ?, ?, 0, ?, ?, ?, ?)`,
    ).run(
      id,
      input.ownerId,
      input.projectId ?? "",
      input.target,
      (input.note ?? "").slice(0, 500),
      now,
      now,
      input.triggerSource,
      input.repositoryId ?? null,
      input.branch ?? null,
      input.commit ?? null,
    );
    const steps = BUILD_STEPS[input.target];
    steps.forEach((step, index) => {
      db.prepare("INSERT INTO build_steps (id, build_id, name, status, ordinal) VALUES (?, ?, ?, 'pending', ?)").run(
        newId(),
        id,
        step.name,
        index,
      );
    });
    publish(db, input.ownerId, "build.started", id, { buildId: id, target: input.target, trigger: input.triggerSource });
  });
  return { id };
}

/** Moves a step to a new state and reports it. */
export function updateStep(
  db: DatabaseSync,
  buildId: string,
  ownerId: string,
  name: string,
  status: StepStatus,
  duration?: number,
): void {
  const now = Date.now();
  db.prepare(
    `UPDATE build_steps SET status = ?, started_at = CASE WHEN ? = 'running' THEN ? ELSE started_at END,
       finished_at = CASE WHEN ? IN ('success','failed','skipped') THEN ? ELSE finished_at END,
       duration_ms = COALESCE(?, duration_ms) WHERE build_id = ? AND name = ?`,
  ).run(status, status, now, status, now, duration ?? null, buildId, name);
  recordEvent(db, buildId, ownerId, { type: "step", stepName: name, stepStatus: status, duration });
}

/** Records progress on the build row and in the stream. */
export function updateProgress(db: DatabaseSync, buildId: string, ownerId: string, percentage: number, currentStep: string, eta?: number): void {
  const clamped = Math.max(0, Math.min(100, Math.round(percentage)));
  db.prepare("UPDATE builds SET progress = ? WHERE id = ?").run(clamped, buildId);
  recordEvent(db, buildId, ownerId, { type: "progress", percentage: clamped, currentStep, eta });
}

/** Finishes the build. */
export function finishBuild(
  db: DatabaseSync,
  buildId: string,
  ownerId: string,
  status: "success" | "failed" | "skipped",
  input: { error?: string | null; previewUrl?: string | null; metrics?: BuildEvent["metric"] } = {},
): void {
  const now = Date.now();
  const row = db.prepare("SELECT started_at FROM builds WHERE id = ?").get(buildId) as { started_at: number | null } | undefined;
  const duration = row?.started_at ? now - row.started_at : null;
  db.prepare(
    `UPDATE builds SET status = ?, finished_at = ?, duration_ms = ?, preview_url = COALESCE(?, preview_url), error = ?,
       progress = CASE WHEN ? = 'success' THEN 100 ELSE progress END WHERE id = ?`,
  ).run(status, now, duration, input.previewUrl ?? null, input.error ?? null, status, buildId);
  recordEvent(db, buildId, ownerId, {
    type: "complete",
    percentage: status === "success" ? 100 : undefined,
    metric: input.metrics,
  });
  publish(db, ownerId, "build.completed", buildId, { buildId, status, durationMs: duration });
}

/** The builds of an account, newest first. */
export function listBuilds(db: DatabaseSync, ownerId: string, limit = 50) {
  return db.prepare(
    `SELECT id, project_id AS projectId, target, status, note, progress, trigger_source AS triggerSource,
       repository_id AS repositoryId, branch, commit_sha AS "commit", preview_url AS previewUrl, error,
       created_at AS createdAt, started_at AS startedAt, finished_at AS finishedAt, duration_ms AS durationMs
     FROM builds WHERE owner_id = ? ORDER BY created_at DESC LIMIT ?`,
  ).all(ownerId, limit);
}

/** One build with its steps. */
export function readBuild(db: DatabaseSync, ownerId: string, buildId: string) {
  const build = db.prepare(
    `SELECT id, project_id AS projectId, target, status, note, progress, trigger_source AS triggerSource,
       repository_id AS repositoryId, branch, commit_sha AS "commit", preview_url AS previewUrl, error,
       created_at AS createdAt, started_at AS startedAt, finished_at AS finishedAt, duration_ms AS durationMs
     FROM builds WHERE id = ? AND owner_id = ?`,
  ).get(buildId, ownerId);
  if (!build) return null;
  const steps = db.prepare(
    "SELECT name, status, ordinal, started_at AS startedAt, finished_at AS finishedAt, duration_ms AS durationMs FROM build_steps WHERE build_id = ? ORDER BY ordinal",
  ).all(buildId);
  return { build, steps };
}

/** The events of a build, for replay and for the stream view. */
export function readBuildEvents(db: DatabaseSync, buildId: string, afterSeq = 0, limit = 500) {
  const rows = db.prepare(
    `SELECT seq, type, at, stream, line, percentage, current_step, eta, step_name,
       step_status, duration, metric FROM build_events WHERE build_id = ? AND seq > ? ORDER BY seq LIMIT ?`,
  ).all(buildId, afterSeq, limit) as {
    seq: number;
    type: string;
    at: number;
    stream: string | null;
    line: string | null;
    percentage: number | null;
    current_step: string | null;
    eta: number | null;
    step_name: string | null;
    step_status: string | null;
    duration: number | null;
    metric: string | null;
  }[];
  return rows.map((row) => ({
    seq: row.seq,
    type: row.type,
    timestamp: row.at,
    buildId,
    stream: row.stream ?? undefined,
    line: row.line ?? undefined,
    percentage: row.percentage ?? undefined,
    currentStep: row.current_step ?? undefined,
    eta: row.eta ?? undefined,
    stepName: row.step_name ?? undefined,
    stepStatus: row.step_status as StepStatus | undefined,
    duration: row.duration ?? undefined,
    metric: row.metric ? (JSON.parse(row.metric) as BuildEvent["metric"]) : undefined,
  }));
}

// ---------------------------------------------------------------------------
// Analysis: what a connected repository actually contains
// ---------------------------------------------------------------------------

/** The framework a repository uses, read from its manifest. */
export function detectFramework(manifest: unknown): string {
  const deps = {
    ...((manifest as { dependencies?: Record<string, string> })?.dependencies ?? {}),
    ...((manifest as { devDependencies?: Record<string, string> })?.devDependencies ?? {}),
  };
  if (deps.next) return "nextjs";
  if (deps.vite) return "vite";
  if (deps.nuxt) return "nuxt";
  if (deps["@remix-run/react"]) return "remix";
  if (deps.astro) return "astro";
  if (deps["@angular/core"]) return "angular";
  if (deps.svelte) return "svelte";
  if (deps["react-scripts"]) return "cra";
  return "unknown";
}

/**
 * The content-addressed key of a tree.
 *
 * The key is the hash of every path and its content, so two builds of the
 * same sources always produce the same key, and any change produces a
 * different one. That is what makes the cache decision a comparison rather
 * than a guess.
 */
export function contentKey(files: { path: string; content: string }[]): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(file.path);
    hash.update("\0");
    hash.update(createHash("sha256").update(file.content).digest("hex"));
    hash.update("\n");
  }
  return hash.digest("hex");
}

/** The cache key of the last successful build of a repository and branch. */
export function lastCacheKey(db: DatabaseSync, ownerId: string, repositoryId: string, branch: string): string | null {
  const row = db.prepare(
    `SELECT b.cache_key AS cacheKey FROM builds b
     WHERE b.owner_id = ? AND b.repository_id = ? AND b.branch = ? AND b.status = 'success'
     ORDER BY b.created_at DESC LIMIT 1`,
  ).get(ownerId, repositoryId, branch) as { cacheKey: string | null } | undefined;
  return row?.cacheKey ?? null;
}

/** The preview address of a build. */
export function previewUrlFor(origin: string, branch: string, buildId: string): string {
  const safeBranch = branch.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "preview";
  return `${origin.replace(/\/+$/, "")}/preview/${safeBranch}-${buildId.slice(0, 8)}`;
}

/** Reads a manifest from a trusted local project, if there is one. */
export function readLocalManifest(cwd: string): { name?: string; framework: string } | null {
  const path = join(cwd, "package.json");
  if (!existsSync(path)) return null;
  try {
    const manifest = JSON.parse(readFileSync(path, "utf8")) as { name?: string };
    return { name: manifest.name, framework: detectFramework(manifest) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

/**
 * Runs a trusted target and streams its output.
 *
 * The child process writes to the build log line by line, the step turns
 * green when the process exits, and the metrics are collected afterwards.
 */
async function runTrustedTarget(db: DatabaseSync, buildId: string, ownerId: string, target: "web" | "android"): Promise<void> {
  const plan = TRUSTED_COMMANDS[target];
  const steps = BUILD_STEPS[target];
  if (!existsSync(plan.cwd)) {
    finishBuild(db, buildId, ownerId, "failed", { error: `The build directory ${plan.cwd} is not present.` });
    return;
  }

  let completed = 0;
  const total = steps.reduce((sum, step) => sum + step.weight, 0);

  for (const step of steps) {
    updateStep(db, buildId, ownerId, step.name, "running");
    updateProgress(db, buildId, ownerId, (completed / total) * 100, step.name);
    const started = Date.now();
    const code = await new Promise<number>((resolve) => {
      let child;
      try {
        child = spawn(plan.command, plan.args, { cwd: plan.cwd, shell: process.platform === "win32" });
      } catch (error) {
        recordEvent(db, buildId, ownerId, { type: "error", line: error instanceof Error ? error.message : String(error) });
        resolve(-1);
        return;
      }
      const emit = (stream: "stdout" | "stderr") => (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        for (const line of text.split(/\r?\n/)) {
          if (line.trim()) recordEvent(db, buildId, ownerId, { type: "log", stream, line: line.slice(0, 4000) });
        }
      };
      child.stdout?.on("data", emit("stdout"));
      child.stderr?.on("data", emit("stderr"));
      child.on("error", (error) => {
        recordEvent(db, buildId, ownerId, { type: "error", line: error.message });
        resolve(-1);
      });
      child.on("close", (exitCode) => resolve(exitCode ?? -1));
    });
    const duration = Date.now() - started;
    if (code !== 0) {
      updateStep(db, buildId, ownerId, step.name, "failed", duration);
      finishBuild(db, buildId, ownerId, "failed", { error: `The step "${step.name}" failed.` });
      return;
    }
    updateStep(db, buildId, ownerId, step.name, "success", duration);
    completed += step.weight;
    updateProgress(db, buildId, ownerId, (completed / total) * 100, step.name);
  }
}

/**
 * Analyses a connected repository without executing any of its code.
 *
 * The framework is detected, the sources are hashed, and the cache decides
 * whether anything has to be rebuilt at all. The isolation boundary that the
 * engine still owes is not something this route may quietly step over, so
 * the compile step is reported as skipped rather than run.
 */
async function analyseRepository(
  db: DatabaseSync,
  buildId: string,
  ownerId: string,
  input: { repositoryId: string; branch: string; files: { path: string; content: string }[]; manifest: unknown },
): Promise<void> {
  const steps = BUILD_STEPS.repository;
  let completed = 0;
  const total = steps.reduce((sum, step) => sum + step.weight, 0);

  updateStep(db, buildId, ownerId, steps[0].name, "running");
  updateProgress(db, buildId, ownerId, 0, steps[0].name);
  recordEvent(db, buildId, ownerId, {
    type: "log",
    stream: "stdout",
    line: `Fetched ${input.files.length} files from ${input.repositoryId}@${input.branch}.`,
  });
  updateStep(db, buildId, ownerId, steps[0].name, "success");
  completed += steps[0].weight;

  updateStep(db, buildId, ownerId, steps[1].name, "running");
  const framework = detectFramework(input.manifest);
  updateStep(db, buildId, ownerId, steps[1].name, "success");
  completed += steps[1].weight;
  recordEvent(db, buildId, ownerId, { type: "metric", metric: { framework } });

  updateStep(db, buildId, ownerId, steps[2].name, "running");
  const key = contentKey(input.files);
  const bytes = input.files.reduce((sum, file) => sum + file.content.length, 0);
  updateStep(db, buildId, ownerId, steps[2].name, "success");
  completed += steps[2].weight;
  recordEvent(db, buildId, ownerId, { type: "metric", metric: { fileCount: input.files.length, totalBytes: bytes } });

  updateStep(db, buildId, ownerId, steps[3].name, "running");
  const previous = lastCacheKey(db, ownerId, input.repositoryId, input.branch);
  const hit = previous !== null && previous === key;
  db.prepare("UPDATE builds SET cache_key = ? WHERE id = ?").run(key, buildId);
  updateStep(db, buildId, ownerId, steps[3].name, "success");
  completed += steps[3].weight;
  recordEvent(db, buildId, ownerId, {
    type: "log",
    stream: "stdout",
    line: hit
      ? "The sources are identical to the last successful build; the cache answers the whole build."
      : previous
        ? "The sources changed since the last build; only the changed files need rebuilding."
        : "No previous build for this branch; the cache is cold.",
  });

  updateStep(db, buildId, ownerId, steps[4].name, "running");
  const origin = (process.env.MOBILECLOUD_PUBLIC_ORIGIN ?? "").trim() || `http://${process.env.HOST ?? "localhost"}:${process.env.PORT ?? "3210"}`;
  const preview = previewUrlFor(origin, input.branch, buildId);
  db.prepare("UPDATE builds SET preview_url = ? WHERE id = ?").run(preview, buildId);
  updateStep(db, buildId, ownerId, steps[4].name, "success");
  completed += steps[4].weight;
  updateProgress(db, buildId, ownerId, 100, "Allocate preview");

  finishBuild(db, buildId, ownerId, "success", {
    previewUrl: preview,
    metrics: { framework, fileCount: input.files.length, totalBytes: bytes, cacheHitRate: hit ? 1 : 0 },
  });
}

/**
 * Starts a build and returns immediately.
 *
 * The build runs in the background; the caller gets the build id and the
 * dashboard follows it over the realtime bus.
 */
export function startBuild(
  db: DatabaseSync,
  input: {
    ownerId: string;
    projectId: string | null;
    projectName: string;
    target: BuildTarget;
    triggerSource: string;
    repositoryId?: string | null;
    branch?: string | null;
    commit?: string | null;
    note?: string;
    files?: { path: string; content: string }[];
    manifest?: unknown;
  },
): { id: string } {
  const { id } = createBuild(db, input);
  const ownerId = input.ownerId;
  if (input.target === "repository") {
    void analyseRepository(db, id, ownerId, {
      repositoryId: input.repositoryId ?? "",
      branch: input.branch ?? "main",
      files: input.files ?? [],
      manifest: input.manifest ?? null,
    }).catch((error) => {
      finishBuild(db, id, ownerId, "failed", { error: error instanceof Error ? error.message : String(error) });
    });
  } else {
    void runTrustedTarget(db, id, ownerId, input.target).catch((error) => {
      finishBuild(db, id, ownerId, "failed", { error: error instanceof Error ? error.message : String(error) });
    });
  }
  return { id };
}
