#!/usr/bin/env node
/**
 * Builds the console into an isolated output directory.
 *
 * `next build` writes into the same directory `next dev` uses. When two
 * development servers are running, a production build replaces their chunk
 * manifest: the HTML still answers 200 while every `/_next/static` asset 404s
 * and the console renders unstyled. This wrapper gives the build its own
 * directory and prints the one the matching server must start from.
 *
 *   npm run build                     -> .next-production
 *   MOBILECLOUD_NEXT_DIST_DIR=x npm run build -> x
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveDistDir } from "./instance.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, "..");
const nextBin = join(appRoot, "node_modules", "next", "dist", "bin", "next");
if (!existsSync(nextBin)) {
  console.error(`[build] Next.js is not installed at ${nextBin}. Run \`npm install\` first.`);
  process.exit(1);
}

const distDir = resolveDistDir({ mode: "start", port: Number(process.env.PORT ?? 3230) });
const env = { ...process.env, MOBILECLOUD_NEXT_DIST_DIR: distDir, NEXT_TELEMETRY_DISABLED: process.env.NEXT_TELEMETRY_DISABLED ?? "1" };

console.log(`[build] output directory: ${distDir}`);

const child = spawn(process.execPath, [nextBin, "build"], { cwd: appRoot, env, stdio: "inherit" });
child.on("exit", (code) => {
  if (code !== 0) process.exit(code ?? 1);
  const buildId = join(appRoot, distDir, "BUILD_ID");
  if (!existsSync(buildId)) {
    console.error(`[build] the build reported success but ${buildId} is missing.`);
    process.exit(1);
  }
  console.log(`[build] build ${readFileSync(buildId, "utf8").trim()} written to ${distDir}`);
  console.log(`[build] start it with MOBILECLOUD_NEXT_DIST_DIR=${distDir} node server/run.mjs start`);
});
