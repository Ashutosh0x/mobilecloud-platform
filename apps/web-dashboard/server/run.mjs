#!/usr/bin/env node
/**
 * Starts the MobileCloud control plane: the Next.js dashboard and the realtime
 * WebSocket gateway, wired to the same SQLite database.
 *
 *   npm run dev     -> next dev  + realtime gateway
 *   npm start       -> next start + realtime gateway
 *
 * Keeping two processes (instead of one) is deliberate: Next owns the HTTP API
 * on :3210 and cannot answer a WebSocket `upgrade`, so the gateway needs its
 * own listener. `server/realtime.mjs` reads the same WAL database, so both
 * processes share one authoritative data model.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, "..");
const mode = process.argv[2] === "start" ? "start" : "dev";
const port = String(process.env.PORT ?? 3210);
const realtimePort = String(process.env.MOBILECLOUD_REALTIME_PORT ?? 3211);

const nextBin = join(appRoot, "node_modules", "next", "dist", "bin", "next");
if (!existsSync(nextBin)) {
  console.error(`[run] Next.js is not installed at ${nextBin}. Run \`npm install\` first.`);
  process.exit(1);
}

const children = new Set();
const restarts = new Set();
let stopping = false;

function launch(label, script, args, env, failures = 0) {
  if (stopping) return;
  const started = Date.now();
  const child = spawn(process.execPath, [script, ...args], { cwd: appRoot, env, stdio: "inherit" });
  children.add(child);
  const restart = () => {
    if (!children.delete(child) || stopping) return;
    const next = Date.now() - started < 60_000 ? failures + 1 : 1;
    const delay = Math.min(30_000, 500 * 2 ** Math.min(next, 6));
    console.error(`[run] ${label} stopped; restarting in ${delay} ms`);
    const timer = setTimeout(() => {
      restarts.delete(timer);
      launch(label, script, args, env, next);
    }, delay);
    restarts.add(timer);
  };
  child.once("error", restart);
  child.once("exit", restart);
}

function shutdown() {
  if (stopping) return;
  stopping = true;
  for (const timer of restarts) clearTimeout(timer);
  for (const child of children) {
    try { child.kill(); } catch { /* already gone */ }
  }
  setTimeout(() => process.exit(0), 1200).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

const webEnv = { ...process.env, PORT: port, NODE_ENV: mode === "start" ? "production" : "development", MOBILECLOUD_REALTIME_PORT: realtimePort };
const realtimeEnv = { ...webEnv };
delete realtimeEnv.MOBILECLOUD_BOOTSTRAP_PASSWORD;
launch("web", nextBin, [mode, "--hostname", process.env.MOBILECLOUD_WEB_HOST ?? "127.0.0.1", "--port", port], webEnv);
launch("realtime", join(here, "realtime.mjs"), [], realtimeEnv);

console.log("");
console.log(`  MobileCloud control plane`);
console.log(`  web app   http://localhost:${port}`);
console.log(`  realtime  ws://localhost:${realtimePort}/api/realtime`);
console.log(`  mode      ${mode}`);
console.log("");
