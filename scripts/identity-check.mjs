#!/usr/bin/env node
/**
 * Prints the identity configuration readiness report.
 *
 * Usage:
 *   node --experimental-strip-types scripts/identity-check.mjs
 *
 * Exit code 1 means at least one production blocker is present. In
 * development the same checks are informational.
 */
import { validateRuntimeConfig } from "../apps/web-dashboard/lib/server/config.ts";

const checks = validateRuntimeConfig(process.env);
const production = process.env.NODE_ENV === "production";
for (const check of checks) {
  const status = check.ok ? "ok" : production ? "BLOCKER" : "note";
  console.log(`${status.padEnd(8)} ${check.name.padEnd(20)} ${check.detail}`);
}
const blockers = checks.filter((check) => !check.ok);
if (production && blockers.length) {
  console.error(`\n${blockers.length} production blocker(s).`);
  process.exit(1);
}
console.log(`\n${checks.length} checks; ${blockers.length} problem(s).`);
