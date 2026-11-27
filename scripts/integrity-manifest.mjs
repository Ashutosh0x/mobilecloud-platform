#!/usr/bin/env node
/**
 * Verifies or regenerates INTEGRITY_MANIFEST.sha256.
 *
 *   node scripts/integrity-manifest.mjs           # verify (CI)
 *   node scripts/integrity-manifest.mjs --write   # recompute after an intentional change
 *
 * The manifest is an integrity inventory, not tamper evidence: it lives in the
 * same repository. Signed tags/commits or an external anchor are required for
 * that property.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const manifestPath = resolve(root, "INTEGRITY_MANIFEST.sha256");
const write = process.argv.includes("--write");
const lines = readFileSync(manifestPath, "utf8").trim().split(/\r?\n/);
const rows = lines.map((line) => {
  const match = /^([a-f0-9]{64})\s+\*?(.+)$/.exec(line.trim());
  if (!match) throw new Error(`Malformed manifest line: ${line}`);
  return { hash: match[1], path: match[2] };
});

let failed = 0;
const next = [];
for (const row of rows) {
  const file = resolve(root, row.path);
  if (!existsSync(file)) {
    console.error(`MISSING ${row.path}`);
    failed += 1;
    next.push(row);
    continue;
  }
  const hash = createHash("sha256").update(readFileSync(file)).digest("hex");
  if (hash !== row.hash && !write) {
    console.error(`CHANGED ${row.path}`);
    failed += 1;
  }
  next.push({ hash, path: row.path });
}

if (write) {
  writeFileSync(manifestPath, `${next.map((row) => `${row.hash} *${row.path}`).join("\n")}\n`);
  console.log(`wrote ${next.length} entries`);
  process.exit(failed ? 1 : 0);
}
if (failed) {
  console.error(`${failed} manifest entr${failed === 1 ? "y" : "ies"} do not match. Run --write only after reviewing the diff.`);
  process.exit(1);
}
console.log(`ok ${rows.length} entries`);
