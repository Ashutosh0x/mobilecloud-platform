#!/usr/bin/env node
/**
 * Competitor Radar self-audit (roadmap P7).
 *
 *   node scripts/radar.mjs          # validate + print the ranked gap audit
 *   node scripts/radar.mjs --check  # CI: validate only, fail on any problem
 *   node scripts/radar.mjs --json   # machine-readable audit on stdout
 *
 * The Radar stores one curated record per competitor claim in
 * `data/radar/items.json`, each mapped to a component in `features/status.json`.
 * This script is the guard that keeps it honest and un-stale:
 *
 *   - every row needs a source link, and that host must be on the allowlist in
 *     `data/radar/feeds.json`;
 *   - every URL must be public, refusing loopback and private targets with the
 *     same policy as webhook delivery (deliverableHost);
 *   - every `mapsTo` must name a real status.json component, so the audit can
 *     never reference a capability that was not assessed;
 *   - the newest record must be fresh, so the audit cannot silently rot.
 *
 * Summaries are our own words; this script does not fetch the sources or check
 * that a summary matches one, so every row is reported as UNVERIFIED.
 */
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const check = process.argv.includes("--check");
const asJson = process.argv.includes("--json");
const MAX_AGE_DAYS = Number(process.env.RADAR_MAX_AGE_DAYS ?? 180);
const VERDICTS = new Set(["have", "partial", "absent"]);

const errors = [];
const fail = (message) => errors.push(message);

/** Loopback/private refusal, mirroring deliverableHost (without the local opt-in). */
function publicHost(rawUrl) {
  let host;
  try {
    host = new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  const privateHost = host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")
    || (isIP(bare) === 4 && (/^10\./.test(bare) || /^127\./.test(bare) || /^192\.168\./.test(bare) || /^169\.254\./.test(bare) || /^172\.(1[6-9]|2\d|3[01])\./.test(bare)))
    || (isIP(bare) === 6 && (bare === "::1" || bare.startsWith("fe80:") || bare.startsWith("fc") || bare.startsWith("fd")));
  return privateHost ? null : bare;
}

function httpsUrl(value, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(`${label}: not a URL`);
    return null;
  }
  if (url.protocol !== "https:") fail(`${label}: must be https`);
  const host = publicHost(value);
  if (!host) fail(`${label}: host is not public`);
  return host;
}

const readJson = (relative) => JSON.parse(readFileSync(resolve(root, relative), "utf8"));

// --- Feeds: the allowlist ---------------------------------------------------
const feedFile = readJson("data/radar/feeds.json");
const competitors = new Set();
const allowedHosts = new Set();
if (!Array.isArray(feedFile.feeds) || feedFile.feeds.length === 0) fail("data/radar/feeds.json: needs a non-empty feeds array");
for (const [index, feed] of (feedFile.feeds ?? []).entries()) {
  const label = `feeds[${index}]`;
  if (!feed.competitor || typeof feed.competitor !== "string") fail(`${label}: competitor is required`);
  const host = httpsUrl(feed.url, `${label} (${feed.competitor ?? "?"})`);
  if (feed.competitor && typeof feed.competitor === "string") competitors.add(feed.competitor);
  if (host) allowedHosts.add(host);
}

// --- Items: the curated records --------------------------------------------
const status = readJson("features/status.json");
const components = new Set(status.components.map((component) => component.name));
const itemFile = readJson("data/radar/items.json");
const items = itemFile.items ?? [];
if (!Array.isArray(items) || items.length === 0) fail("data/radar/items.json: needs a non-empty items array");

const ids = new Set();
let newest = null;
const now = Date.now();
for (const [index, item] of items.entries()) {
  const label = `items[${index}]${item.id ? ` (${item.id})` : ""}`;
  if (!item.id || typeof item.id !== "string") fail(`${label}: id is required`);
  else if (ids.has(item.id)) fail(`${label}: duplicate id`);
  else ids.add(item.id);
  if (!competitors.has(item.competitor)) fail(`${label}: competitor "${item.competitor}" has no allowlisted feed`);
  const date = Date.parse(item.date);
  if (Number.isNaN(date)) fail(`${label}: date must be ISO (YYYY-MM-DD)`);
  else {
    if (date > now + 86_400_000) fail(`${label}: date is in the future`);
    if (newest === null || date > newest) newest = date;
  }
  const host = httpsUrl(item.source, `${label}: source`);
  if (host && !allowedHosts.has(host)) fail(`${label}: source host "${host}" is not on the feed allowlist`);
  if (typeof item.summary !== "string" || item.summary.trim().length < 20 || item.summary.length > 400) {
    fail(`${label}: summary must be 20-400 characters in our own words`);
  }
  if (!components.has(item.mapsTo)) fail(`${label}: mapsTo "${item.mapsTo}" is not a features/status.json component`);
  if (!VERDICTS.has(item.verdict)) fail(`${label}: verdict must be have, partial or absent`);
}
if (newest !== null) {
  const ageDays = Math.floor((now - newest) / 86_400_000);
  if (ageDays > MAX_AGE_DAYS) fail(`the newest record is ${ageDays} days old (limit ${MAX_AGE_DAYS}); refresh data/radar/items.json`);
}

if (errors.length > 0) {
  for (const message of errors) console.error(`radar: ${message}`);
  console.error(`radar: ${errors.length} problem(s)`);
  process.exit(1);
}

// --- Audit: rank the gaps ---------------------------------------------------
const order = { absent: 0, partial: 1, have: 2 };
const ranked = [...items].sort((a, b) => order[a.verdict] - order[b.verdict] || a.competitor.localeCompare(b.competitor) || a.id.localeCompare(b.id));

if (asJson) {
  console.log(JSON.stringify({
    generatedFrom: { feeds: feedFile.feeds.length, items: items.length },
    unverified: true,
    gaps: ranked.map(({ id, competitor, verdict, mapsTo, source, date }) => ({ id, competitor, verdict, mapsTo, source, date })),
  }, null, 2));
} else if (!check) {
  console.log(`Competitor Radar — ${items.length} records from ${feedFile.feeds.length} allowlisted sources (summaries UNVERIFIED)`);
  for (const item of ranked) {
    console.log(`  [${item.verdict.toUpperCase().padEnd(7)}] ${item.competitor.padEnd(11)} ${item.id.padEnd(22)} -> ${item.mapsTo}`);
  }
  const counts = ranked.reduce((acc, item) => ({ ...acc, [item.verdict]: (acc[item.verdict] ?? 0) + 1 }), {});
  console.log(`  gaps: ${counts.absent ?? 0} absent · ${counts.partial ?? 0} partial · ${counts.have ?? 0} have`);
  console.log(check === false ? "  run with --check in CI to fail on drift." : "");
} else {
  console.log(`ok ${items.length} records, ${feedFile.feeds.length} feeds`);
}
