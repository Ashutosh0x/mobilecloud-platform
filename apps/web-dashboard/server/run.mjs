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

const children = [];
let stopping = false;

function launch(label, script, args, env) {
  const child = spawn(process.execPath, [script, ...args], {
    cwd: appRoot,
    env: { ...process.env, ...env },
    stdio: "inherit",
  });
  child.on("exit", (code) => {
    if (stopping) return;
    console.error(`[run] ${label} exited with code ${code}`);
    shutdown(code ?? 1);
  });
  children.push(child);
  return child;
}

function shutdown(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  }
  setTimeout(() => process.exit(code), 400);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

launch("web", nextBin, [mode, "--port", port], {});
launch("realtime", join(here, "realtime.mjs"), [], { MOBILECLOUD_REALTIME_PORT: realtimePort });

console.log("");
console.log(`  MobileCloud control plane`);
console.log(`  web app   http://localhost:${port}`);
console.log(`  realtime  ws://localhost:${realtimePort}/api/realtime`);
console.log(`  mode      ${mode}`);
console.log("");
