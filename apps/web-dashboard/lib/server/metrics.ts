import { readdirSync, statSync, statfsSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import type { DatabaseSync } from "node:sqlite";
import type { Analytics, HostInfo, Metrics, RangeKey } from "../types.ts";
import { dataRoot } from "./db.ts";

function dirBytes(path: string): number {
  let total = 0;
  let entries: { name: string; isDirectory: () => boolean }[] = [];
  try {
    entries = readdirSync(path, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = join(path, entry.name);
    if (entry.isDirectory()) total += dirBytes(full);
    else {
      try {
        total += statSync(full).size;
      } catch {
        /* skip unreadable files */
      }
    }
  }
  return total;
}

export function cpuBusySinceBootPct(): number | null {
  const cpus = os.cpus();
  if (!cpus.length) return null;
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    idle += cpu.times.idle;
    total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
  }
  if (total <= 0) return null;
  return Math.round((1 - idle / total) * 1000) / 10;
}

let diskUsage: { root: string; bytes: number; sampled: number } | null = null;

function cachedDiskUsage() {
  const root = dataRoot();
  if (!diskUsage || diskUsage.root !== root || Date.now() - diskUsage.sampled > 30_000) {
    diskUsage = { root, bytes: dirBytes(root), sampled: Date.now() };
  }
  return diskUsage.bytes;
}

export function collectMetrics(db: DatabaseSync, ownerId: string, privileged = false): Metrics {
  const unavailable: string[] = [];
  const total = privileged ? os.totalmem() : 0;
  const free = privileged ? os.freemem() : 0;
  const used = Math.max(0, total - free);
  let diskFree: number | null = null;
  let diskTotal: number | null = null;
  if (privileged) {
    try {
      const fs = statfsSync(dataRoot());
      diskFree = Number(fs.bavail) * Number(fs.bsize);
      diskTotal = Number(fs.blocks) * Number(fs.bsize);
    } catch {
      unavailable.push("Disk free space is not readable on this host.");
    }
  } else {
    unavailable.push("Shared host resource metrics are visible only in the operator's password session.");
  }
  unavailable.push("Network interface utilization is not measured. Only requests handled by this server are counted.");
  unavailable.push("Phone battery, bypass charging, and wall power are not visible to this process.");

  const since = Date.now() - 24 * 3600 * 1000;
  const row = db.prepare(
    "SELECT COUNT(*) AS n, AVG(duration_ms) AS avg FROM requests WHERE owner_id = ? AND at >= ?",
  ).get(ownerId, since) as { n: number; avg: number | null };

  return {
    collectedAt: Date.now(),
    processUptimeSec: privileged ? Math.round(process.uptime()) : 0,
    cpuBusySinceBootPct: privileged ? cpuBusySinceBootPct() : null,
    memoryUsedPct: total > 0 ? Math.round((used / total) * 1000) / 10 : null,
    memoryUsedBytes: used,
    memoryTotalBytes: total,
    dataDirBytes: privileged ? cachedDiskUsage() : 0,
    diskFreeBytes: diskFree,
    diskTotalBytes: diskTotal,
    responseAvgMs: row.n > 0 && row.avg != null ? Math.round(row.avg) : null,
    responseSamples: row.n,
    recordedRequests: row.n,
    networkUtilization: null,
    unavailable,
  };
}

export function collectHost(privileged = false): HostInfo {
  if (!privileged) return {
    hostname: "unavailable", platform: "unavailable", arch: "unavailable", release: "unavailable",
    cpuCount: 0, processUptimeSec: 0, memoryUsedBytes: 0, memoryTotalBytes: 0,
    unavailable: ["Shared host details are visible only in the operator's password session."],
  };
  const total = os.totalmem();
  const free = os.freemem();
  return {
    hostname: os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
    release: os.release(),
    cpuCount: os.cpus().length,
    processUptimeSec: Math.round(process.uptime()),
    memoryUsedBytes: Math.max(0, total - free),
    memoryTotalBytes: total,
    unavailable: [
      "Battery percent, charge current, and bypass charging require Android BatteryManager on a device.",
      "SoC temperature requires a readable thermal zone on the device.",
      "Wall power requires an external meter.",
    ],
  };
}

const RANGES: Record<RangeKey, { ms: number; buckets: number }> = {
  "1h": { ms: 3600_000, buckets: 12 },
  "24h": { ms: 86400_000, buckets: 24 },
  "7d": { ms: 7 * 86400_000, buckets: 7 },
  "30d": { ms: 30 * 86400_000, buckets: 30 },
};

export function collectAnalytics(db: DatabaseSync, ownerId: string, range: RangeKey): Analytics {
  const spec = RANGES[range] ?? RANGES["24h"];
  const end = Date.now();
  const start = end - spec.ms;
  const width = spec.ms / spec.buckets;
  const rows = db.prepare(
    "SELECT at FROM requests WHERE owner_id = ? AND at >= ?",
  ).all(ownerId, start) as { at: number }[];
  const counts = Array.from({ length: spec.buckets }, () => 0);
  for (const row of rows) {
    const index = Math.min(spec.buckets - 1, Math.max(0, Math.floor((row.at - start) / width)));
    counts[index] += 1;
  }
  const points = counts.map((count, i) => {
    const t = new Date(start + i * width);
    const label = range === "1h" || range === "24h"
      ? t.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false })
      : t.toLocaleDateString("en-GB", { month: "short", day: "numeric" });
    return { label, count };
  });
  return { range, total: rows.length, points };
}
