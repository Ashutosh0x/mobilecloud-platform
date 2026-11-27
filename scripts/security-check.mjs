#!/usr/bin/env node
/**
 * Dependency and vulnerability gate.
 *
 * Usage: node scripts/security-check.mjs
 *
 * Runs the package manager's audit for the dashboard and, when the cargo-audit
 * binary is installed, the Rust advisory database check. A missing network or
 * a missing cargo-audit is reported, not silently treated as success.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const app = resolve(root, "apps/web-dashboard");
let failed = false;

const npm = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["audit", "--omit=dev", "--audit-level=high"], {
  cwd: app,
  stdio: "inherit",
  shell: false,
});
if (npm.status !== 0) {
  console.error("npm audit reported high or critical advisories (or could not run).");
  failed = true;
}

const cargoAudit = spawnSync("cargo", ["audit", "--version"], { cwd: root, stdio: "ignore" });
if (cargoAudit.status === 0) {
  const audit = spawnSync("cargo", ["audit"], { cwd: root, stdio: "inherit" });
  if (audit.status !== 0) {
    console.error("cargo audit reported advisories.");
    failed = true;
  }
} else {
  console.warn("cargo-audit is not installed; Rust advisories were not checked (`cargo install cargo-audit`).");
}

if (!existsSync(resolve(root, "artifacts/sbom.cdx.json"))) {
  console.warn("No SBOM found; run `node scripts/generate-sbom.mjs`.");
}

process.exit(failed ? 1 : 0);
