import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { dataRoot } from "./db.ts";

/**
 * A local GeoIP table for the login risk engine.
 *
 * The engine answers two questions about a login: is this a country the
 * account has used before, and is the distance from the last login physically
 * possible. Both need coordinates, and both must keep working without a
 * network call, so the table is read from a local CSV file.
 *
 * File format, one record per line:
 *
 *     203.0.113.0/24,DE,52.52,13.40
 *     198.51.100.0/24,US,37.77,-122.42
 *
 * The first column is an IPv4 network in CIDR notation, the second an ISO
 * country code, the third and fourth the latitude and longitude. Lines that do
 * not parse are skipped, and a missing file simply means "no geography", which
 * disables the geography based risk factors instead of failing a login.
 */

export type GeoLocation = {
  country: string;
  lat: number;
  lon: number;
};

type Record = { network: number; prefix: number; geo: GeoLocation };

let cached: { path: string; mtime: number; records: Record[] } | null = null;

/** The table path: an explicit override, else `geoip.csv` beside the database. */
function tablePath(): string {
  const override = process.env.MOBILECLOUD_GEOIP?.trim();
  if (override) return override;
  return join(dataRoot(), "geoip.csv");
}

/** Parses an IPv4 address into its 32 bit value, or null when it is not one. */
function ipv4ToInt(address: string): number | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet < 0 || octet > 255) return null;
    value = value * 256 + octet;
  }
  return value >>> 0;
}

/** Parses `a.b.c.d/len` into a network address and its prefix length. */
function parseNetwork(cidr: string): { network: number; prefix: number } | null {
  const [address, length] = cidr.split("/");
  const value = ipv4ToInt(address.trim());
  if (value === null) return null;
  const prefix = Number(length);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return { network: (value & mask) >>> 0, prefix };
}

function load(): Record[] {
  const path = tablePath();
  let mtime = 0;
  try {
    mtime = statSync(path).mtimeMs;
  } catch {
    mtime = 0;
  }
  if (cached && cached.path === path && cached.mtime === mtime) return cached.records;
  if (!existsSync(path)) {
    cached = { path, mtime, records: [] };
    return cached.records;
  }
  const records: Record[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const [cidr, country, lat, lon] = trimmed.split(",").map((part) => part.trim());
    const network = parseNetwork(cidr ?? "");
    const latitude = Number(lat);
    const longitude = Number(lon);
    if (!network || !country || !Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;
    records.push({ network: network.network, prefix: network.prefix, geo: { country: country.toUpperCase(), lat: latitude, lon: longitude } });
  }
  cached = { path, mtime, records };
  return records;
}

/**
 * Resolves an IP address to a country and coordinates.
 *
 * The most specific network wins, so a `/24` entry overrides a `/8` entry for
 * the same address.
 */
export function lookupGeo(ip: string | null | undefined): GeoLocation | null {
  if (!ip) return null;
  const value = ipv4ToInt(ip.trim());
  if (value === null) return null;
  let best: Record | null = null;
  for (const record of load()) {
    if (record.prefix === 0) {
      if (!best) best = record;
      continue;
    }
    const mask = (0xffffffff << (32 - record.prefix)) >>> 0;
    if ((value & mask) !== record.network) continue;
    if (!best || record.prefix > best.prefix) best = record;
  }
  return best?.geo ?? null;
}

/** Great-circle distance in kilometres between two coordinates. */
export function haversineKm(a: GeoLocation, b: GeoLocation): number {
  const radius = 6371;
  const toRad = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * radius * Math.asin(Math.min(1, Math.sqrt(h)));
}
