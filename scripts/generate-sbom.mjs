#!/usr/bin/env node
/**
 * Builds a CycloneDX-style software bill of materials from the two lockfiles.
 *
 * Usage: node scripts/generate-sbom.mjs [output]
 * Default output: artifacts/sbom.cdx.json
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const output = resolve(root, process.argv[2] ?? "artifacts/sbom.cdx.json");
const components = new Map();

function add(name, version, ecosystem) {
  if (!name || !version) return;
  const purl = ecosystem === "npm" ? `pkg:npm/${encodeURIComponent(name)}@${version}` : `pkg:cargo/${name}@${version}`;
  components.set(purl, { type: "library", name, version, purl, properties: [{ name: "ecosystem", value: ecosystem }] });
}

const lockPath = resolve(root, "apps/web-dashboard/package-lock.json");
const lock = JSON.parse(readFileSync(lockPath, "utf8"));
for (const [path, entry] of Object.entries(lock.packages ?? {})) {
  if (!path.includes("node_modules/")) continue;
  const name = entry.name ?? path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
  add(name, entry.version, "npm");
}

const cargoLock = readFileSync(resolve(root, "Cargo.lock"), "utf8");
for (const block of cargoLock.split("[[package]]").slice(1)) {
  const name = /^name = "(.+)"$/m.exec(block)?.[1];
  const version = /^version = "(.+)"$/m.exec(block)?.[1];
  add(name, version, "cargo");
}

const list = [...components.values()].sort((a, b) => a.purl.localeCompare(b.purl));
const body = {
  bomFormat: "CycloneDX",
  specVersion: "1.5",
  version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    tools: [{ name: "mobilecloud-sbom", version: "1.0.0" }],
    component: { type: "application", name: "mobilecloud-platform" },
  },
  components: list,
};
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(body, null, 2)}\n`);
const digest = createHash("sha256").update(JSON.stringify(body)).digest("hex");
writeFileSync(`${output}.sha256`, `${digest}  ${output.split(/[\\/]/).pop()}\n`);
console.log(`wrote ${output} (${list.length} components, sha256 ${digest.slice(0, 16)}…)`);
