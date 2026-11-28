import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openDb } from "./db.ts";
import {
  BUILD_STEPS,
  contentKey,
  createBuild,
  detectFramework,
  finishBuild,
  lastCacheKey,
  previewUrlFor,
  readBuild,
  readBuildEvents,
  recordEvent,
  startBuild,
  updateProgress,
  updateStep,
} from "./builds.ts";

function freshDb() {
  const file = join(mkdtempSync(join(tmpdir(), "mc-builds-")), "t.db");
  const db = openDb(file);
  db.prepare("INSERT INTO users (id, email, name, password_hash, role, plan, created_at) VALUES ('u1', 'a@b.co', 'A', '!', 'owner', 'community', ?)").run(Date.now());
  return db;
}

test("a framework is detected from the manifest", () => {
  assert.equal(detectFramework({ dependencies: { next: "15.0.0" } }), "nextjs");
  assert.equal(detectFramework({ devDependencies: { vite: "6.0.0" } }), "vite");
  assert.equal(detectFramework({ dependencies: { "@remix-run/react": "2.0.0" } }), "remix");
  assert.equal(detectFramework({ dependencies: {} }), "unknown");
  assert.equal(detectFramework(null), "unknown");
});

test("the content key is stable for the same sources and changes with them", () => {
  const files = [{ path: "src/a.ts", content: "one" }, { path: "src/b.ts", content: "two" }];
  assert.equal(contentKey(files), contentKey([...files].reverse()));
  assert.notEqual(contentKey(files), contentKey([{ path: "src/a.ts", content: "one" }, { path: "src/b.ts", content: "changed" }]));
  assert.notEqual(contentKey(files), contentKey(files.slice(0, 1)));
});

test("a preview address is derived from the branch and the build", () => {
  assert.equal(previewUrlFor("https://console.example.com", "main", "abcdef1234"), "https://console.example.com/preview/main-abcdef12");
  assert.equal(previewUrlFor("https://console.example.com/", "feat/new thing", "abcdef1234"), "https://console.example.com/preview/feat-new-thing-abcdef12");
});

test("a build records its steps, its events and its completion", () => {
  const db = freshDb();
  const { id } = createBuild(db, {
    ownerId: "u1",
    projectId: null,
    projectName: "acme/site",
    target: "repository",
    triggerSource: "test",
    repositoryId: "11:acme/site",
    branch: "main",
    commit: "abc123",
    note: "a build",
  });
  const detail = readBuild(db, "u1", id);
  assert.ok(detail);
  assert.equal(detail?.steps.length, BUILD_STEPS.repository.length);
  assert.equal(detail?.build.progress, 0);
  assert.equal(detail?.build.repositoryId, "11:acme/site");
  assert.equal(detail?.build.commit, "abc123");

  updateStep(db, id, "u1", "Fetch repository", "running");
  updateProgress(db, id, "u1", 40, "Hash sources");
  recordEvent(db, id, "u1", { type: "log", stream: "stdout", line: "hello" });
  updateStep(db, id, "u1", "Fetch repository", "success", 12);
  finishBuild(db, id, "u1", "success", { previewUrl: "https://console.example.com/preview/main-abcdef12" });

  const events = readBuildEvents(db, id);
  assert.ok(events.some((event) => event.type === "step" && event.stepStatus === "success"));
  assert.ok(events.some((event) => event.type === "progress" && event.percentage === 40));
  assert.ok(events.some((event) => event.type === "log" && event.line === "hello"));
  assert.ok(events.some((event) => event.type === "complete"));

  const finished = readBuild(db, "u1", id);
  assert.equal(finished?.build.status, "success");
  assert.equal(finished?.build.progress, 100);
  assert.equal(finished?.build.previewUrl, "https://console.example.com/preview/main-abcdef12");
  assert.ok(Number(finished?.build.durationMs ?? 0) >= 0);
  db.close();
});

test("a build of a repository analyses it and answers the cache", async () => {
  const db = freshDb();
  const files = [
    { path: "package.json", content: JSON.stringify({ dependencies: { next: "15.0.0" } }) },
    { path: "src/app.tsx", content: "export default function App() {}" },
  ];
  const first = startBuild(db, {
    ownerId: "u1",
    projectId: null,
    projectName: "acme/site",
    target: "repository",
    triggerSource: "test",
    repositoryId: "11:acme/site",
    branch: "main",
    files,
    manifest: JSON.parse(files[0].content),
  });
  await waitFor(() => readBuild(db, "u1", first.id)?.build.status !== "running");
  const finished = readBuild(db, "u1", first.id);
  assert.equal(finished?.build.status, "success");
  assert.equal(finished?.build.progress, 100);
  assert.ok(finished?.build.previewUrl);
  const metrics = readBuildEvents(db, first.id).filter((event) => event.type === "metric");
  assert.ok(metrics.some((event) => event.metric?.framework === "nextjs"));
  assert.ok(metrics.some((event) => event.metric?.fileCount === 2));

  // The same sources answer the cache the second time.
  const second = startBuild(db, {
    ownerId: "u1",
    projectId: null,
    projectName: "acme/site",
    target: "repository",
    triggerSource: "test",
    repositoryId: "11:acme/site",
    branch: "main",
    files,
    manifest: JSON.parse(files[0].content),
  });
  await waitFor(() => readBuild(db, "u1", second.id)?.build.status !== "running");
  const logs = readBuildEvents(db, second.id).filter((event) => event.type === "log").map((event) => event.line ?? "");
  assert.ok(logs.some((line) => line.includes("cache answers the whole build")));
  assert.ok(lastCacheKey(db, "u1", "11:acme/site", "main"));
  db.close();
});

test("a build is invisible to another account", () => {
  const db = freshDb();
  const { id } = createBuild(db, {
    ownerId: "u1",
    projectId: null,
    projectName: "acme/site",
    target: "repository",
    triggerSource: "test",
  });
  assert.equal(readBuild(db, "u2", id), null);
  db.close();
});

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("the build did not finish in time");
}
