import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { CSRF_COOKIE, CSRF_HEADER } from "../csrf.ts";
import type { RangeKey, User } from "../types.ts";
import { BUILDER_DISABLED } from "./builder.ts";
import { dataRoot, isRetiredPassword, newId, openDb, tokenHash, verifyPassword } from "./db.ts";
import { collectAnalytics, collectHost, collectMetrics } from "./metrics.ts";
import { capabilities, collectObservability, inspectRequest, listBuilds, listDrives, listFirewallEvents, listRules, listWorkflows, observedJa4, summarizeVitals, trafficSummary } from "./platform.ts";
import { approveDevice, clearProtection, createToken, gateCookie, identityProviders, listNotifications, listSessions, listTokens, listWebhooks, notify, pollDevice, protectionStatus, readGate, setProtection, startDevice, unlockProtection, userFromBearer } from "./identity.ts";
import { changesSince, latestSeq, publish, snapshot, tx } from "./events.ts";
import { approveFromBrowser, approvePairing, closePairing, createPairing, expireStale, listDevices, markAwaitingApproval, publicPairing, readPairing, renameDevice, revokeDevice, scanPairing, scanProofMatches, secretMatches } from "./pairing.ts";
import { encodePairingTicket, renderPairingQr } from "./qr.ts";

const COOKIE = "mc_session";
const WEEK = 7 * 24 * 3600 * 1000;
const attempts = new Map<string, { n: number; reset: number }>();

/** Port the realtime gateway listens on; advertised through `GET /api/health`. */
function realtimePort(): number {
  const raw = Number(process.env.MOBILECLOUD_REALTIME_PORT ?? 3211);
  return Number.isFinite(raw) && raw > 0 ? raw : 3211;
}

type Authentication =
  | { user: User; via: "bearer"; tokenId: string; deviceId: string | null }
  | { user: User; via: "cookie"; hash: string; csrf: string; deviceId: string | null; createdAt: number | null };

class RequestError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function json(body: unknown, status = 200, headers?: Headers) {
  const h = headers ?? new Headers();
  h.set("content-type", "application/json");
  h.set("cache-control", "no-store");
  return new Response(JSON.stringify(body), { status, headers: h });
}

function publicOrigin(): string | null {
  try {
    const url = new URL(process.env.MOBILECLOUD_PUBLIC_ORIGIN ?? "");
    const schemeAllowed = url.protocol === "https:" || (process.env.NODE_ENV !== "production" && url.protocol === "http:");
    return schemeAllowed && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash ? url.origin : null;
  } catch {
    return null;
  }
}

function secureCookie(req: Request): boolean {
  return process.env.NODE_ENV === "production" || publicOrigin()?.startsWith("https://") === true || new URL(req.url).protocol === "https:";
}

function cookieHeader(req: Request, token: string, maxAge: number) {
  return `${COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}${secureCookie(req) ? "; Secure" : ""}`;
}

function readCookie(req: Request, name = COOKIE): string | null {
  const hits = (req.headers.get("cookie") ?? "").split(";").map((p) => p.trim()).filter((p) => p.startsWith(`${name}=`));
  if (hits.length !== 1) return null;
  const token = hits[0].slice(name.length + 1);
  return /^[a-f0-9]{64}$/.test(token) ? token : null;
}

// Reuse the native client's session cookie jar, but a scan capability is
// neither a login token (different value format) nor sent outside this ticket.
function pairingCookie(req: Request, id: string, proof: string, maxAge: number) {
  return `${COOKIE}=${proof}; HttpOnly; Path=/api/device/pairing/${id}; SameSite=Strict; Max-Age=${maxAge}${secureCookie(req) ? "; Secure" : ""}`;
}

function readScanProof(req: Request): string | null {
  const hits = (req.headers.get("cookie") ?? "").split(";").map((p) => p.trim()).filter((p) => /^mc_session=scan_[a-f0-9]{64}$/.test(p));
  return hits.length === 1 ? hits[0].slice(COOKIE.length + 1) : null;
}

/** The browser echoes this session-bound token; native clients can read auth/me. */
function csrfCookieHeader(req: Request, token: string, maxAge: number) {
  return `${CSRF_COOKIE}=${token}; Path=/; SameSite=Lax; Max-Age=${maxAge}${secureCookie(req) ? "; Secure" : ""}`;
}

/** Constant-time string comparison over equal-length byte arrays. */
function timingSafeEq(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function requireOrigin(req: Request): void {
  const origin = req.headers.get("origin");
  let allowed = origin === null || origin === publicOrigin();
  // Match the gateway's dev allowlist without trusting a request-derived host.
  if (!allowed && process.env.NODE_ENV !== "production" && !process.env.MOBILECLOUD_PUBLIC_ORIGIN) {
    const port = Number(process.env.PORT ?? 3210);
    if (Number.isInteger(port) && port > 0 && port <= 65535) {
      allowed = ["localhost", "127.0.0.1", "[::1]"].some((host) => origin === new URL(`http://${host}:${port}`).origin);
    }
  }
  if (!allowed || req.headers.get("sec-fetch-site") === "cross-site") {
    throw new RequestError(403, "Request origin is not allowed");
  }
}

function requireCsrf(req: Request, auth: Authentication | null): void {
  if (auth?.via !== "cookie" || req.method === "GET" || req.method === "HEAD") return;
  const header = req.headers.get(CSRF_HEADER);
  if (!header || !timingSafeEq(header, auth.csrf)) throw new RequestError(403, "The CSRF token is missing or invalid");
}

function authenticate(req: Request, db: DatabaseSync): Authentication | null {
  const authorization = req.headers.get("authorization");
  if (authorization !== null) {
    const bearer = userFromBearer(db, authorization);
    return bearer ? { ...bearer, via: "bearer" } : null;
  }
  const token = readCookie(req);
  if (!token) return null;
  const hash = tokenHash(token);
  const now = Date.now();
  const row = db.prepare(
    `SELECT u.id, u.email, u.name, u.role, u.plan, s.csrf, s.device_id AS deviceId, s.created_at AS createdAt
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ? AND s.csrf IS NOT NULL
       AND (s.device_id IS NULL OR EXISTS (
         SELECT 1 FROM connected_devices d JOIN access_tokens t ON t.id = d.token_id AND t.owner_id = d.owner_id
         WHERE d.id = s.device_id AND d.owner_id = s.user_id AND d.revoked = 0 AND t.expires_at > ?
       ))`,
  ).get(hash, now, now) as (User & { csrf: string; deviceId: string | null; createdAt: number | null }) | undefined;
  if (!row) return null;
  const { csrf, deviceId, createdAt, ...user } = row;
  return { user, csrf, hash, via: "cookie", deviceId, createdAt };
}

function requireRecentLogin(auth: Authentication) {
  if (auth.via !== "cookie" || auth.deviceId || !auth.createdAt || Date.now() - auth.createdAt > 15 * 60_000) {
    throw new RequestError(403, "Sign in again with your password to perform this action");
  }
}

function log(ownerId: string, level: "info" | "warn" | "error", source: string, message: string) {
  try {
    openDb().prepare("INSERT INTO logs (id, owner_id, level, source, message, at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(newId(), ownerId, level, source, message.slice(0, 500), Date.now());
  } catch {
    console.warn("Control-plane activity log write failed");
  }
}

function record(ownerId: string | null, path: string, status: number, started: number, req: Request) {
  openDb().prepare(
    "INSERT INTO requests (id, owner_id, path, status, duration_ms, at, user_agent, host, ja4) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    newId(),
    ownerId,
    path,
    status,
    Date.now() - started,
    Date.now(),
    req.headers.get("user-agent")?.slice(0, 180) ?? null,
    req.headers.get("host"),
    observedJa4(req),
  );
}

// The route has no trusted peer address. Do not accept forwarded headers as
// a rate-limit identity; apply an operation-wide budget and a target budget.
function throttle(operation: string, target?: string, targetLimit = 12) {
  const now = Date.now();
  for (const [key, row] of attempts) if (row.reset <= now) attempts.delete(key);
  function consume(key: string, allowance: number) {
    let row = attempts.get(key);
    if (!row) {
      if (attempts.size >= 2048) return false;
      row = { n: 0, reset: now + 60_000 };
      attempts.set(key, row);
    }
    return ++row.n <= allowance;
  }
  if (!consume(operation, 240) || (target && !consume(`${operation}:${target}`, targetLimit))) {
    throw new RequestError(429, "Too many attempts");
  }
}

function safeSlug(input: string, label: string) {
  const name = input.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "");
  if (!name || name.length > 48) throw new RequestError(400, `${label} must be 1-48 letters, numbers, or hyphens`);
  return name;
}

function requireJson(req: Request) {
  if (req.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new RequestError(415, "Content-Type must be application/json");
  }
}

async function body(req: Request, maxBytes = 64 * 1024): Promise<Record<string, unknown>> {
  requireJson(req);
  if (Number(req.headers.get("content-length")) > maxBytes) throw new RequestError(413, "Request body is too large");
  const reader = req.body?.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        void reader.cancel().catch(() => undefined);
        throw new RequestError(413, "Request body is too large");
      }
      chunks.push(value);
    }
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks, length).toString("utf8"));
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
  } catch { /* rejected below */ }
  throw new RequestError(400, "Provide a valid JSON object");
}

function str(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function originOf(req: Request) {
  const configured = publicOrigin();
  if (configured) return configured;
  if (process.env.NODE_ENV === "production") throw new RequestError(503, "Configure the public HTTPS origin before starting pairing");
  return new URL(req.url).origin;
}

/** Turns a pairing state-machine reason into something a user can act on. */
function pairingError(reason: string) {
  switch (reason) {
    case "unknown_session":
    case "invalid_secret":
      return "This QR code is not valid. Ask the dashboard to show a new one.";
    case "expired":
      return "This QR code has expired. QR codes are valid for two minutes.";
    case "closed":
      return "This pairing was cancelled on the dashboard.";
    case "already_connected":
      return "This QR code was already used. If the phone did not receive its session, revoke the linked device and start a new pairing.";
    case "already_approved":
      return "This QR code was already approved. Ask the dashboard to show a new one.";
    case "not_approved":
      return "This pairing has not been approved on the dashboard yet.";
    case "account_mismatch":
      return "This QR code belongs to a different account.";
    default:
      return "This pairing could not be completed. Try again from the dashboard.";
  }
}

/** A repository URL must look like a git remote the builder can clone. */
function isGitUrl(value: string) {
  try {
    const url = new URL(value);
    return value.length <= 2048 && url.protocol === "https:" && !url.username && !url.password && !url.hash && !url.search && url.pathname !== "/";
  } catch {
    return false;
  }
}

const NO_REPO_NOTE = "No repository is configured for this project. Engine dispatch is also disabled.";

/** Records a deployment row and publishes `deployment.updated` atomically. */
function recordDeployment(
  db: DatabaseSync,
  owner: string,
  project: { id: string; name: string },
  status: string,
  note: string,
) {
  const id = newId();
  tx(db, () => {
    db.prepare(
      "INSERT INTO deployments (id, owner_id, project_id, status, note, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(id, owner, project.id, status, note, Date.now());
    publish(db, owner, "deployment.updated", id, { id, projectId: project.id, project: project.name, status, note });
  });
  return id;
}

/** Records a build row and publishes `build.updated` atomically. */
function recordBuild(
  db: DatabaseSync,
  owner: string,
  project: { id: string; name: string },
  target: string,
  status: string,
  note: string,
) {
  const id = newId();
  tx(db, () => {
    db.prepare(
      "INSERT INTO builds (id, owner_id, project_id, target, status, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(id, owner, project.id, target, status, note, Date.now());
    publish(db, owner, "build.updated", id, { id, projectId: project.id, project: project.name, target, status, note });
  });
  return id;
}

export async function handle(req: Request, parts: string[]): Promise<Response> {
  const started = Date.now();
  const path = parts.join("/");
  let owner: string | null = null;
  let status = 200;
  try {
    const result = await route(req, parts);
    owner = result.owner;
    status = result.status;
    return new Response(result.response.body, { status: result.status, headers: result.response.headers });
  } catch (error) {
    status = error instanceof RequestError ? error.status : 500;
    if (status === 500) console.warn("Unexpected control-plane request failure");
    return json({ error: error instanceof RequestError ? error.message : "Request failed" }, status);
  } finally {
    if (owner && path !== "events" && path !== "health") {
      try { record(owner, `/${path}`.slice(0, 180), status, started, req); }
      catch { console.warn("Control-plane request telemetry write failed"); }
    }
  }
}

async function route(req: Request, parts: string[]): Promise<{ response: Response; status: number; owner: string | null }> {
  const method = req.method;
  const key = `${method} ${parts.join("/")}`;
  if (method !== "GET" && method !== "HEAD") requireOrigin(req);
  if (key === "POST auth/signup") throw new RequestError(403, "Public registration is disabled. Contact your MobileCloud operator.");
  if (key === "GET health") {
    return {
      response: json({
        service: "MobileCloud",
        apiVersion: 1,
        status: "ok",
        environment: process.env.NODE_ENV ?? "development",
        time: new Date().toISOString(),
        signupEnabled: false,
        realtime: {
          transport: "websocket",
          path: "/api/realtime",
          port: realtimePort(),
          url: publicOrigin()?.replace(/^http/, "ws")?.concat("/api/realtime") ?? null,
          fallback: "/api/sync/changes",
          schemaVersion: 1,
        },
      }),
      status: 200,
      owner: null,
    };
  }
  const db = openDb();

  if (key === "POST auth/login") {
    const input = await body(req, 4096);
    const email = str(input.email).toLowerCase();
    const password = str(input.password);
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+$/.test(email) || password.length < 8 || password.length > 256) {
      throw new RequestError(400, "A valid email and password are required");
    }
    throttle("login", email);
    const row = db.prepare("SELECT id, password_hash FROM users WHERE email = ?").get(email) as { id: string; password_hash: string } | undefined;
    // Run the same costly verifier for missing and reset-required accounts.
    const stored = row?.password_hash.includes(":") ? row.password_hash : `00000000000000000000000000000000:${"0".repeat(64)}`;
    if (!verifyPassword(password, stored) || !row || isRetiredPassword(password)) {
      throw new RequestError(401, "Email or password is wrong");
    }
    log(row.id, "info", "auth", "signed in");
    return issueSession(db, row.id, req);
  }

  if (key === "POST auth/device/code") {
    throttle("device-code");
    const started = startDevice(db);
    return { response: json(started), status: 200, owner: null };
  }
  if (key === "POST auth/device/token") {
    const deviceCode = str((await body(req, 4096)).deviceCode);
    throttle("device-token", /^[a-f0-9]{48}$/.test(deviceCode) ? tokenHash(deviceCode) : undefined, 30);
    const result = pollDevice(db, deviceCode);
    const status = result.status === "approved" ? 200 : result.status === "expired" ? 400 : 202;
    return { response: json(result, status), status, owner: null };
  }

  // ---- QR device pairing: the scanning device's half ---------------------
  // After the first scan, only the client holding the scoped scan cookie may
  // follow or claim this ticket. A QR copy alone cannot claim that approval.
  if (parts[0] === "device" && parts[1] === "pairing" && parts[2] && !/^[a-f0-9]{32}$/.test(parts[2])) {
    throw new RequestError(404, "Pairing session not found");
  }

  if (method === "POST" && parts[0] === "device" && parts[1] === "pairing" && parts[2] && parts[3] === "scan") {
    const input = await body(req);
    const secret = str(input.secret);
    if (!secret) return { response: json({ error: "A pairing secret is required" }, 400), status: 400, owner: null };
    const device = {
      name: str(input.name) || undefined,
      platform: str(input.platform) || undefined,
      appVersion: str(input.appVersion) || undefined,
    };
    throttle("pairing-scan", parts[2].slice(0, 64));
    const proof = `scan_${randomBytes(32).toString("hex")}`;
    const result = tx(db, () => {
      const outcome = scanPairing(db, parts[2], secret, device, proof, readScanProof(req));
      if (!outcome.ok || outcome.duplicate) return outcome;
      publish(db, outcome.row.owner_id, "device.pairing.scanned", outcome.row.id, publicPairing(outcome.row));
      markAwaitingApproval(db, parts[2]);
      const row = readPairing(db, parts[2]) ?? outcome.row;
      publish(db, row.owner_id, "device.pairing.approval_requested", row.id, publicPairing(row));
      return { ...outcome, row };
    });
    if (!result.ok) {
      const status = result.reason === "unknown_session" || result.reason === "invalid_secret" ? 404 : 409;
      return { response: json({ error: pairingError(result.reason), reason: result.reason }, status), status, owner: null };
    }
    const headers = new Headers();
    if (!result.duplicate) headers.append("set-cookie", pairingCookie(req, parts[2], proof, 240));
    return { response: json({ pairing: publicPairing(result.row), duplicate: result.duplicate }, 200, headers), status: 200, owner: null };
  }

  if (method === "POST" && parts[0] === "device" && parts[1] === "pairing" && parts[2] && parts[3] === "status") {
    throttle("pairing-status", parts[2].slice(0, 64), 100);
    const secret = str((await body(req, 4096)).secret);
    const row = readPairing(db, parts[2]);
    if (!row || !secretMatches(row, secret) || (row.scan_hash && !scanProofMatches(row, readScanProof(req)))) {
      return { response: json({ error: pairingError("unknown_session"), reason: "unknown_session" }, 404), status: 404, owner: null };
    }
    return { response: json({ pairing: publicPairing(row) }), status: 200, owner: null };
  }

  if (method === "POST" && parts[0] === "device" && parts[1] === "pairing" && parts[2] && parts[3] === "claim") {
    const input = await body(req);
    const row = readPairing(db, parts[2]);
    if (!row || !secretMatches(row, str(input.secret)) || (row.scan_hash && !scanProofMatches(row, readScanProof(req)))) {
      return { response: json({ error: pairingError("unknown_session"), reason: "unknown_session" }, 404), status: 404, owner: null };
    }
    throttle("pairing-claim", parts[2].slice(0, 64));
    const claimed = tx(db, () => {
      const outcome = approvePairing(db, row, row.owner_id);
      if (!outcome.ok) return outcome;
      const pairing = publicPairing(outcome.row);
      publish(db, row.owner_id, "device.pairing.connected", row.id, pairing);
      publish(db, row.owner_id, "device.connected", outcome.device.id, {
        device_id: outcome.device.id,
        device_name: outcome.device.name,
        platform: outcome.device.platform,
        method: "qr",
      });
      const headers = startSession(db, row.owner_id, req, outcome.device.id);
      return { ...outcome, headers, pairing };
    });
    if (!claimed.ok) {
      const status = claimed.reason === "not_approved" || claimed.reason === "race" ? 409 : 410;
      return { response: json({ error: pairingError(claimed.reason), reason: claimed.reason }, status), status, owner: null };
    }
    log(row.owner_id, "info", "device", `linked ${claimed.device.name} (${claimed.device.platform}) with a QR code`);
    const { headers, pairing } = claimed;
    headers.append("set-cookie", pairingCookie(req, parts[2], "", 0));
    return {
      response: json({
        account_id: claimed.row.owner_id,
        device: {
          id: claimed.device.id,
          name: claimed.device.name,
          platform: claimed.device.platform,
          app_version: claimed.device.appVersion,
        },
        // Shown to the phone exactly once; only its hash is stored server-side.
        credential: claimed.credential,
        credential_expires_at: claimed.credentialExpiresAt ? new Date(claimed.credentialExpiresAt).toISOString() : null,
        pairing,
      }, 200, headers),
      status: 200,
      owner: claimed.row.owner_id,
    };
  }

  if (key === "POST auth/logout") {
    if (req.body && req.headers.get("content-length") !== "0") await body(req, 4096);
    const auth = authenticate(req, db);
    if (req.headers.has("authorization") && !auth) throw new RequestError(401, "Sign in required");
    requireCsrf(req, auth);
    if (auth) tx(db, () => {
      const owner = auth.user.id;
      if (auth.via === "cookie") {
        const row = db.prepare("SELECT id FROM sessions WHERE token_hash = ?").get(auth.hash) as { id: string } | undefined;
        db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(auth.hash);
        if (row) publish(db, owner, "session.revoked", row.id, { sessionId: row.id, reason: "signed_out" });
      }
      if (auth.deviceId) {
        if (revokeDevice(db, owner, auth.deviceId).ok) {
          publish(db, owner, "device.disconnected", auth.deviceId, { device_id: auth.deviceId, reason: "signed_out" });
        }
      } else if (auth.via === "bearer") {
        db.prepare("DELETE FROM access_tokens WHERE owner_id = ? AND id = ?").run(owner, auth.tokenId);
        publish(db, owner, "configuration.updated", auth.tokenId, { resource: "token", id: auth.tokenId, deleted: true });
      }
    });
    const headers = new Headers();
    if (!auth || auth.via === "cookie") {
      headers.append("set-cookie", cookieHeader(req, "", 0));
      headers.append("set-cookie", csrfCookieHeader(req, "", 0));
      headers.append("set-cookie", gateCookie("", 0, secureCookie(req)));
    }
    return { response: json({ ok: true }, 200, headers), status: 200, owner: auth?.user.id ?? null };
  }

  if (key === "GET auth/me") {
    requireOrigin(req);
    const auth = authenticate(req, db);
    const headers = new Headers();
    const csrfToken = auth?.via === "cookie" ? auth.csrf : null;
    if (csrfToken && readCookie(req, CSRF_COOKIE) !== csrfToken) {
      headers.append("set-cookie", csrfCookieHeader(req, csrfToken, WEEK / 1000));
    }
    return { response: json({ user: auth?.user ?? null, csrfToken }, 200, headers), status: 200, owner: auth?.user.id ?? null };
  }

  const auth = authenticate(req, db);
  if (!auth) throw new RequestError(401, "Sign in required");
  const user = auth.user;
  const owner = user.id;
  const operatorMetrics = user.role === "owner" && auth.via === "cookie" && auth.deviceId === null;
  requireCsrf(req, auth);
  if (auth.via === "bearer" && method !== "GET" && method !== "HEAD") {
    throw new RequestError(403, "Bearer credentials are read-only; use an authenticated session for changes");
  }
  if (method !== "GET" && (parts[0] === "tokens" || parts[0] === "sessions" || parts[0] === "webhooks" || parts[0] === "devices"
    || key === "POST device/approve" || (parts[0] === "device" && parts[1] === "pairing")
    || key === "POST protection" || key === "DELETE protection")) {
    requireRecentLogin(auth);
  }
  const blocked = inspectRequest(db, owner, req, parts.join("/"));
  if (blocked) {
    notify(db, owner, "firewall.denied", "Request blocked", blocked.error);
    return { response: json({ error: blocked.error }, blocked.status), status: blocked.status, owner };
  }

  // Authorized catch-up feed. A client that was offline (or whose socket
  // dropped) replays from its last cursor and receives every change it missed,
  // scoped to its own account. Returns the new cursor to persist.
  if (key === "GET sync/changes") {
    const params = new URL(req.url).searchParams;
    const rawCursor = Number(params.get("cursor") ?? 0);
    const cursor = Number.isSafeInteger(rawCursor) && rawCursor > 0 ? rawCursor : 0;
    const rawLimit = Number(params.get("limit") ?? 500);
    const limit = Number.isSafeInteger(rawLimit) && rawLimit > 0 ? Math.min(1000, rawLimit) : 500;
    const page = snapshot(db, () => changesSince(db, owner, cursor, limit));
    return { response: json({ ...page, account_id: owner }), status: 200, owner };
  }

  if (key === "GET overview") {
    const result = snapshot(db, () => ({
      cursor: latestSeq(db, owner),
      user: db.prepare("SELECT id, email, name, role, plan FROM users WHERE id = ?").get(owner) ?? user,
      projects: listProjects(owner),
      deployments: listDeployments(owner),
      domains: listDomains(owner),
      databases: listDatabases(owner),
      functions: listFunctions(owner),
      objects: listObjects(owner),
      logs: listLogs(owner),
      team: listTeam(owner),
      settings: listSettings(owner),
      metrics: collectMetrics(db, owner, operatorMetrics),
      host: collectHost(operatorMetrics),
      billing: billing(user),
      firewall: { rules: listRules(db, owner), events: listFirewallEvents(db, owner), traffic: trafficSummary(db, owner) },
      observability: collectObservability(db, owner),
      vitals: summarizeVitals(db, owner),
      builds: listBuilds(db, owner),
      workflows: listWorkflows(db, owner),
      drives: listDrives(db, owner),
      capabilities: capabilities(),
      notifications: listNotifications(db, owner),
      sessions: listSessions(db, owner, auth.via === "cookie" ? auth.hash : null),
      tokens: listTokens(db, owner),
      webhooks: listWebhooks(db, owner),
      protection: protectionStatus(db, owner, readGate(req)),
      identity: identityProviders(),
    }));
    return { response: json(result), status: 200, owner };
  }

  if (key === "GET metrics") return { response: json(collectMetrics(db, owner, operatorMetrics)), status: 200, owner };
  if (key === "GET host") return { response: json(collectHost(operatorMetrics)), status: 200, owner };
  if (parts[0] === "analytics" && method === "GET") {
    const range = (new URL(req.url).searchParams.get("range") ?? "24h") as RangeKey;
    if (!["1h", "24h", "7d", "30d"].includes(range)) return { response: json({ error: "Unknown range" }, 400), status: 400, owner };
    return { response: json(collectAnalytics(db, owner, range)), status: 200, owner };
  }
  if (key === "GET search") {
    const q = `%${(new URL(req.url).searchParams.get("q") ?? "").trim().toLowerCase()}%`;
    const projects = db.prepare("SELECT id, name FROM projects WHERE owner_id = ? AND name LIKE ? LIMIT 8").all(owner, q);
    return { response: json({ projects }), status: 200, owner };
  }
  if (key === "POST events") {
    const input = await body(req);
    if (listSettings(owner).recordPageViews === false) return { response: json({ skipped: true }), status: 200, owner };
    const page = str(input.path).slice(0, 120) || "/";
    log(owner, "info", "nav", `opened ${page}`);
    return { response: json({ ok: true }), status: 200, owner };
  }

  if (key === "POST projects") {
    const input = await body(req);
    const name = safeSlug(str(input.name), "Project name");
    const framework = str(input.framework) || "Next.js";
    if (!["Next.js", "Vite", "Astro", "Nuxt", "Remix", "React"].includes(framework)) {
      return { response: json({ error: "Unknown framework" }, 400), status: 400, owner };
    }
    const repoUrl = str(input.repoUrl);
    if (repoUrl && !isGitUrl(repoUrl)) {
      return { response: json({ error: "Enter an HTTPS repository URL without embedded credentials, query, or fragment" }, 400), status: 400, owner };
    }
    const id = newId();
    tx(db, () => {
      db.prepare(
        "INSERT INTO projects (id, owner_id, name, framework, target, repo_url, created_at) VALUES (?, ?, ?, ?, 'production', ?, ?)",
      ).run(id, owner, name, framework, repoUrl || null, Date.now());
      publish(db, owner, "project.created", id, { id, name, framework, target: "production", repoUrl: repoUrl || null });
    });
    log(owner, "info", "projects", `created ${name}`);
    return { response: json({ ok: true, id, repoUrl: repoUrl || null }), status: 201, owner };
  }
  if (method === "PATCH" && parts[0] === "projects" && parts.length === 2) {
    const input = await body(req);
    if (input.repoUrl !== null && typeof input.repoUrl !== "string") throw new RequestError(400, "Provide a repository URL or null");
    const repoUrl = str(input.repoUrl) || null;
    if (repoUrl && !isGitUrl(repoUrl)) throw new RequestError(400, "Enter an HTTPS repository URL without embedded credentials, query, or fragment");
    tx(db, () => {
      const changed = db.prepare("UPDATE projects SET repo_url = ? WHERE owner_id = ? AND id = ?").run(repoUrl, owner, parts[1]);
      if (!changed.changes) throw new RequestError(404, "Project not found");
      publish(db, owner, "project.updated", parts[1], { id: parts[1], repoUrl });
    });
    return { response: json({ ok: true, id: parts[1], repoUrl }), status: 200, owner };
  }
  if (method === "DELETE" && parts[0] === "projects" && parts[1]) {
    const existing = db.prepare("SELECT name FROM projects WHERE owner_id = ? AND id = ?").get(owner, parts[1]) as
      | { name: string }
      | undefined;
    if (!existing) return { response: json({ error: "Project not found" }, 404), status: 404, owner };
    tx(db, () => {
      db.prepare("DELETE FROM deployments WHERE owner_id = ? AND project_id = ?").run(owner, parts[1]);
      db.prepare("DELETE FROM domains WHERE owner_id = ? AND project_id = ?").run(owner, parts[1]);
      db.prepare("DELETE FROM projects WHERE owner_id = ? AND id = ?").run(owner, parts[1]);
      publish(db, owner, "project.deleted", parts[1], { id: parts[1], name: existing.name });
    });
    log(owner, "warn", "projects", `deleted ${parts[1]}`);
    return { response: json({ ok: true }), status: 200, owner };
  }

  if (key === "POST deployments") {
    const input = await body(req);
    const project = db.prepare("SELECT id, name, repo_url AS repoUrl FROM projects WHERE owner_id = ? AND id = ?")
      .get(owner, str(input.projectId)) as { id: string; name: string; repoUrl: string | null } | undefined;
    if (!project) return { response: json({ error: "Project not found" }, 404), status: 404, owner };

    const override = str(input.repoUrl);
    if (override && !isGitUrl(override)) {
      return { response: json({ error: "Enter an HTTPS repository URL without embedded credentials, query, or fragment" }, 400), status: 400, owner };
    }
    if (override && override !== project.repoUrl) {
      tx(db, () => {
        db.prepare("UPDATE projects SET repo_url = ? WHERE owner_id = ? AND id = ?").run(override, owner, project.id);
        publish(db, owner, "project.updated", project.id, { id: project.id, name: project.name, repoUrl: override });
      });
    }
    const repoUrl = override || project.repoUrl || "";

    if (!repoUrl) {
      recordDeployment(db, owner, project, "blocked", NO_REPO_NOTE);
      log(owner, "warn", "builder", `${project.name}: ${NO_REPO_NOTE}`);
      notify(db, owner, "deployment.blocked", "Deployment not built", `${project.name}: ${NO_REPO_NOTE}`);
      return { response: json({ ok: true, status: "blocked", note: NO_REPO_NOTE }), status: 201, owner };
    }

    recordDeployment(db, owner, project, "blocked", BUILDER_DISABLED);
    log(owner, "warn", "builder", `${project.name}: ${BUILDER_DISABLED}`);
    return { response: json({ ok: true, status: "blocked", note: BUILDER_DISABLED }), status: 201, owner };
  }

  if (method === "POST" && parts[0] === "deployments" && parts[2] === "rollback") {
    return { response: json({ ok: false, status: "blocked", note: BUILDER_DISABLED }), status: 503, owner };
  }

  if (key === "GET builder") {
    return { response: json({ enabled: false, baseUrl: "", reachable: false, detail: BUILDER_DISABLED }), status: 200, owner };
  }
  if (method === "GET" && parts[0] === "builder" && parts[1] === "deployments" && parts[2]) {
    throw new RequestError(503, BUILDER_DISABLED);
  }

  if (key === "POST domains") {
    const input = await body(req);
    const host = str(input.host).toLowerCase();
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) return { response: json({ error: "Enter a hostname like app.example.com" }, 400), status: 400, owner };
    const project = db.prepare("SELECT id FROM projects WHERE owner_id = ? AND name = ?").get(owner, str(input.project)) as { id: string } | undefined;
    if (!project) return { response: json({ error: "Project not found" }, 404), status: 404, owner };
    const detail = "Saved locally. No DNS provider is configured, so no records were published.";
    const id = newId();
    tx(db, () => {
      db.prepare(
        "INSERT INTO domains (id, owner_id, project_id, host, status, detail, created_at) VALUES (?, ?, ?, ?, 'recorded', ?, ?)",
      ).run(id, owner, project.id, host, detail, Date.now());
      publish(db, owner, "configuration.updated", id, { resource: "domain", id, host, projectId: project.id, status: "recorded" });
    });
    log(owner, "info", "domains", `recorded ${host}`);
    return { response: json({ ok: true }), status: 201, owner };
  }
  if (method === "DELETE" && parts[0] === "domains" && parts[1]) {
    const existing = db.prepare("SELECT host FROM domains WHERE owner_id = ? AND id = ?").get(owner, parts[1]) as
      | { host: string }
      | undefined;
    if (!existing) return { response: json({ error: "Domain not found" }, 404), status: 404, owner };
    tx(db, () => {
      db.prepare("DELETE FROM domains WHERE owner_id = ? AND id = ?").run(owner, parts[1]);
      publish(db, owner, "configuration.updated", parts[1], { resource: "domain", id: parts[1], host: existing.host, deleted: true });
    });
    return { response: json({ ok: true }), status: 200, owner };
  }

  if (key === "POST databases") {
    const name = safeSlug(str((await body(req)).name), "Database name");
    const dir = join(dataRoot(), "databases", owner);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${name}.sqlite`);
    writeFileSync(file, "", { flag: "wx" });
    const id = newId();
    tx(db, () => {
      db.prepare("INSERT INTO db_files (id, owner_id, name, path, created_at) VALUES (?, ?, ?, ?, ?)").run(id, owner, name, file, Date.now());
      publish(db, owner, "configuration.updated", id, { resource: "database", id, name });
    });
    log(owner, "info", "databases", `created ${name}.sqlite`);
    return { response: json({ ok: true, bytes: statSync(file).size }), status: 201, owner };
  }

  if (key === "POST functions") {
    const input = await body(req);
    const name = safeSlug(str(input.name), "Function name");
    const routePath = str(input.route);
    if (!routePath.startsWith("/")) return { response: json({ error: "Route must start with /" }, 400), status: 400, owner };
    const id = newId();
    tx(db, () => {
      db.prepare(
        "INSERT INTO functions (id, owner_id, name, route, invocations, created_at) VALUES (?, ?, ?, ?, 0, ?)",
      ).run(id, owner, name, routePath, Date.now());
      publish(db, owner, "configuration.updated", id, { resource: "function", id, name, route: routePath });
    });
    log(owner, "info", "functions", `registered ${name} with no handler source`);
    return { response: json({ ok: true }), status: 201, owner };
  }
  if (method === "POST" && parts[0] === "functions" && parts[2] === "invoke") {
    const row = db.prepare("SELECT id, name FROM functions WHERE owner_id = ? AND id = ?").get(owner, parts[1]) as { id: string; name: string } | undefined;
    if (!row) return { response: json({ error: "Function not found" }, 404), status: 404, owner };
    log(owner, "error", "functions", `${row.name} was not invoked: no handler source is stored`);
    return { response: json({ error: "No handler source is stored for this function, so it was not executed." }, 409), status: 409, owner };
  }

  if (key === "POST storage") {
    const input = await body(req, 1_350_000);
    const bucket = safeSlug(str(input.bucket), "Bucket");
    const keyName = str(input.key);
    if (keyName.length > 240 || !keyName.split("/").every((part) => /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,79}$/.test(part))) {
      throw new RequestError(400, "Object key is invalid");
    }
    const content = str(input.contentBase64);
    if (!content || content.length > 1_333_336) throw new RequestError(400, "Provide base64 content up to 1 MB");
    const bytes = Buffer.from(content, "base64");
    if (bytes.length > 1_000_000 || bytes.toString("base64") !== content) throw new RequestError(400, "Provide base64 content up to 1 MB");
    const id = newId();
    const dir = join(dataRoot(), "objects", owner, "opaque");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${id}.blob`);
    const temporary = join(dir, `${id}.tmp`);
    let staged = false;
    let promoted = false;
    try {
      tx(db, () => {
        if (db.prepare("SELECT 1 FROM objects WHERE owner_id = ? AND bucket = ? AND key = ? LIMIT 1").get(owner, bucket, keyName)) {
          throw new RequestError(409, "An object with this key already exists");
        }
        const usage = db.prepare("SELECT COALESCE(SUM(bytes), 0) AS bytes FROM objects WHERE owner_id = ?").get(owner) as { bytes: number };
        if (usage.bytes + bytes.length > 100_000_000) throw new RequestError(413, "Account object storage limit reached");
        writeFileSync(temporary, bytes, { flag: "wx" });
        staged = true;
        renameSync(temporary, file);
        promoted = true;
        db.prepare("INSERT INTO objects (id, owner_id, bucket, key, path, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run(id, owner, bucket, keyName, file, bytes.length, Date.now());
        publish(db, owner, "configuration.updated", id, { resource: "object", id, bucket, key: keyName, bytes: bytes.length });
      });
    } catch (error) {
      if (staged) try { rmSync(promoted ? file : temporary, { force: true }); } catch { /* Leave orphan for maintenance. */ }
      throw error;
    }
    log(owner, "info", "storage", `wrote ${bucket}/${keyName} (${bytes.length} bytes)`);
    return { response: json({ ok: true, bytes: bytes.length }), status: 201, owner };
  }

  if (key === "POST team") {
    const input = await body(req);
    const email = str(input.email).toLowerCase();
    const name = str(input.name);
    if (!email.includes("@") || !name) return { response: json({ error: "Name and email are required" }, 400), status: 400, owner };
    const id = newId();
    tx(db, () => {
      db.prepare(
        "INSERT INTO invites (id, owner_id, email, name, role, email_sent, created_at) VALUES (?, ?, ?, ?, 'member', 0, ?)",
      ).run(id, owner, email, name, Date.now());
      publish(db, owner, "configuration.updated", id, { resource: "invite", id, email, name });
    });
    log(owner, "info", "team", `saved invite for ${email}. SMTP is not configured, so no email was sent.`);
    return { response: json({ ok: true, emailSent: false }), status: 201, owner };
  }

  if (key === "POST settings") {
    const input = await body(req);
    if (typeof input.recordPageViews !== "boolean") return { response: json({ error: "recordPageViews must be boolean" }, 400), status: 400, owner };
    tx(db, () => {
      db.prepare(
        "INSERT INTO settings (owner_id, key, value) VALUES (?, 'recordPageViews', ?) ON CONFLICT(owner_id, key) DO UPDATE SET value = excluded.value",
      ).run(owner, input.recordPageViews ? "1" : "0");
      publish(db, owner, "configuration.updated", owner, { resource: "settings", recordPageViews: input.recordPageViews });
    });
    return { response: json({ ok: true }), status: 200, owner };
  }

  if (method === "DELETE" && parts[0] === "sessions" && parts[1]) {
    const current = readCookie(req) ? tokenHash(readCookie(req) as string) : "";
    const target = db.prepare("SELECT id, token_hash AS tokenHash FROM sessions WHERE user_id = ? AND (id = ? OR token_hash = ?)").get(owner, parts[1], parts[1]) as
      | { id: string | null; tokenHash: string }
      | undefined;
    if (!target || target.tokenHash === current) {
      return { response: json({ error: "Session not found, or it is the current browser session. Use sign out for this one." }, 404), status: 404, owner };
    }
    tx(db, () => {
      db.prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash = ?").run(owner, target.tokenHash);
      publish(db, owner, "session.revoked", target.id ?? target.tokenHash, { sessionId: target.id ?? target.tokenHash, reason: "revoked_by_user" });
    });
    return { response: json({ ok: true }), status: 200, owner };
  }

  if (key === "POST tokens") {
    const input = await body(req);
    const name = str(input.name);
    const days = Number(input.days ?? 30);
    if (!name) return { response: json({ error: "Name is required" }, 400), status: 400, owner };
    if (![7, 30, 90].includes(days)) return { response: json({ error: "Expiry must be 7, 30, or 90 days" }, 400), status: 400, owner };
    const issued = tx(db, () => {
      const credential = createToken(db, owner, name, days);
      publish(db, owner, "configuration.updated", credential.id, { resource: "token", id: credential.id, name: name.slice(0, 60) });
      return { token: credential.token, expiresAt: credential.expiresAt };
    });
    return { response: json(issued), status: 201, owner };
  }

  if (method === "DELETE" && parts[0] === "tokens" && parts[1]) {
    const existing = db.prepare("SELECT name FROM access_tokens WHERE owner_id = ? AND id = ?").get(owner, parts[1]) as
      | { name: string }
      | undefined;
    if (!existing) return { response: json({ error: "Token not found" }, 404), status: 404, owner };
    tx(db, () => {
      db.prepare("DELETE FROM access_tokens WHERE owner_id = ? AND id = ?").run(owner, parts[1]);
      publish(db, owner, "configuration.updated", parts[1], { resource: "token", id: parts[1], name: existing.name, deleted: true });
    });
    return { response: json({ ok: true }), status: 200, owner };
  }

  if (key === "POST device/approve") {
    const code = str((await body(req)).userCode);
    throttle("device-approve", owner);
    tx(db, () => {
      if (!approveDevice(db, owner, code)) throw new RequestError(404, "Code is unknown, expired, or already used");
      publish(db, owner, "configuration.updated", null, { resource: "device", approved: true });
      notify(db, owner, "auth.device", "Device approved", "Approved a device code");
    });
    return { response: json({ ok: true }), status: 200, owner };
  }

  // ---- QR device pairing: the signed-in browser's half -------------------

  // Starts a pairing session and returns the rendered QR. Any session this
  // account already had open is superseded, so a screenshot of an old code can
  // never be reused.
  if (key === "POST device/pairing") {
    throttle("pairing-create", owner);
    const input = await body(req, 4096);
    const origin = originOf(req);
    const { created, row } = tx(db, () => {
      const created = createPairing(db, owner, {
        name: str(input.name) || undefined,
        platform: str(input.platform) || undefined,
        userAgent: req.headers.get("user-agent") ?? undefined,
      });
      const row = readPairing(db, created.id);
      if (!row) throw new Error("Pairing insert not found");
      publish(db, owner, "device.pairing.created", created.id, publicPairing(row));
      return { created, row };
    });
    const payload = encodePairingTicket({ api: origin, id: created.id, secret: created.secret, code: created.verificationCode });
    const qr = await renderPairingQr(payload);
    log(owner, "info", "device", "started a QR pairing session");
    // The secret and the PNG are returned once, to the browser that asked for
    // them. It is the only moment the secret exists outside the QR image.
    return { response: json({ pairing: publicPairing(row), payload, qr_data_url: qr }), status: 201, owner };
  }

  // The browser polls this while the QR is on screen.
  if (method === "GET" && parts[0] === "device" && parts[1] === "pairing" && parts[2]) {
    const row = tx(db, () => {
      for (const stale of expireStale(db, owner)) {
        publish(db, owner, "device.pairing.expired", stale.id, { pairing_id: stale.id, status: "EXPIRED" });
      }
      return readPairing(db, parts[2]);
    });
    if (!row || row.owner_id !== owner) return { response: json({ error: "Pairing session not found" }, 404), status: 404, owner };
    return { response: json({ pairing: publicPairing(row) }), status: 200, owner };
  }

  // Approve a scanned device. Only the session's own account can approve, and
  // only after a device has actually scanned the code.
  if (method === "POST" && parts[0] === "device" && parts[1] === "pairing" && parts[2] && parts[3] === "approve") {
    const row = readPairing(db, parts[2]);
    if (!row || row.owner_id !== owner) return { response: json({ error: "Pairing session not found" }, 404), status: 404, owner };
    const approved = tx(db, () => {
      if (!approveFromBrowser(db, parts[2], owner)) return null;
      const updated = readPairing(db, parts[2]) ?? row;
      publish(db, owner, "device.pairing.approved", parts[2], publicPairing(updated));
      notify(db, owner, "auth.device", "Device approved", `Approved ${updated.scan_device_name ?? "a device"} over QR`);
      return updated;
    });
    if (!approved) return { response: json({ error: pairingError("not_approved"), reason: "not_approved" }, 409), status: 409, owner };
    log(owner, "info", "device", `approved QR pairing for ${approved.scan_device_name ?? "a device"}`);
    return { response: json({ pairing: publicPairing(approved) }), status: 200, owner };
  }

  // Cancel (or deny) an open pairing, from any non-terminal state.
  if (method === "DELETE" && parts[0] === "device" && parts[1] === "pairing" && parts[2]) {
    const row = readPairing(db, parts[2]);
    if (!row || row.owner_id !== owner) return { response: json({ error: "Pairing session not found" }, 404), status: 404, owner };
    tx(db, () => {
      if (closePairing(db, parts[2], "cancelled")) {
        publish(db, owner, "device.pairing.revoked", parts[2], { pairing_id: parts[2], reason: "cancelled" });
      }
    });
    return { response: json({ ok: true }), status: 200, owner };
  }

  if (key === "GET devices") {
    return { response: json({ devices: listDevices(db, owner) }), status: 200, owner };
  }

  if (method === "PATCH" && parts[0] === "devices" && parts[1]) {
    const name = str((await body(req)).name);
    if (!name) return { response: json({ error: "A device name is required" }, 400), status: 400, owner };
    tx(db, () => {
      if (!renameDevice(db, owner, parts[1], name)) throw new RequestError(404, "Device not found");
      publish(db, owner, "device.updated", parts[1], { device_id: parts[1], name: name.slice(0, 60) });
    });
    return { response: json({ ok: true }), status: 200, owner };
  }

  if (method === "DELETE" && parts[0] === "devices" && parts[1]) {
    const revoked = tx(db, () => {
      const changed = revokeDevice(db, owner, parts[1]);
      if (!changed.ok) throw new RequestError(404, "Device not found");
      publish(db, owner, "device.disconnected", parts[1], { device_id: parts[1], name: changed.device?.name ?? null, reason: "revoked" });
      return changed;
    });
    log(owner, "info", "device", `revoked ${revoked.device?.name ?? "a device"}`);
    return { response: json({ ok: true }), status: 200, owner };
  }

  if (key === "POST protection") {
    const input = await body(req, 4096);
    const password = typeof input.password === "string" ? input.password : "";
    if (password.length < 8 || password.length > 256) throw new RequestError(400, "Password must be 8–256 characters");
    const gate = tx(db, () => {
      if (!protectionStatus(db, owner, readGate(req)).unlocked) throw new RequestError(403, "Unlock screen privacy before changing its password");
      const token = setProtection(db, owner, password);
      publish(db, owner, "configuration.updated", owner, { resource: "protection", required: true });
      return token;
    });
    const headers = new Headers();
    headers.append("set-cookie", gateCookie(gate, WEEK / 1000, secureCookie(req)));
    return { response: json({ ok: true }, 200, headers), status: 200, owner };
  }

  if (key === "POST protection/unlock") {
    throttle("protection", owner);
    const input = await body(req, 4096);
    const password = typeof input.password === "string" ? input.password : "";
    const gate = password.length <= 256 ? unlockProtection(db, owner, password) : null;
    if (!gate) return { response: json({ error: "Password does not match" }, 401), status: 401, owner };
    const headers = new Headers();
    headers.append("set-cookie", gateCookie(gate, WEEK / 1000, secureCookie(req)));
    return { response: json({ ok: true }, 200, headers), status: 200, owner };
  }

  if (key === "DELETE protection") {
    tx(db, () => {
      if (!protectionStatus(db, owner, readGate(req)).unlocked) throw new RequestError(403, "Unlock screen privacy before removing its password");
      clearProtection(db, owner);
      publish(db, owner, "configuration.updated", owner, { resource: "protection", required: false });
    });
    const headers = new Headers();
    headers.append("set-cookie", gateCookie("", 0, secureCookie(req)));
    return { response: json({ ok: true }, 200, headers), status: 200, owner };
  }

  if (key === "POST webhooks") {
    const input = await body(req);
    const url = str(input.url);
    try {
      const target = new URL(url);
      if (url.length > 2048 || target.protocol !== "https:" || target.username || target.password || target.hash || target.search) throw new Error();
    } catch {
      throw new RequestError(400, "Enter an HTTPS webhook URL without credentials, query, or fragment");
    }
    const secret = randomBytes(16).toString("hex");
    const id = newId();
    tx(db, () => {
      db.prepare("INSERT INTO webhooks (id, owner_id, url, secret, events, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
        id, owner, url, secret, "deployment.blocked,firewall.denied,auth.session,auth.device", Date.now(),
      );
      publish(db, owner, "configuration.updated", id, { resource: "webhook", id, url });
    });
    return { response: json({ secret, deliveryEnabled: false }, 201), status: 201, owner };
  }

  if (method === "DELETE" && parts[0] === "webhooks" && parts[1]) {
    const existing = db.prepare("SELECT url FROM webhooks WHERE owner_id = ? AND id = ?").get(owner, parts[1]) as
      | { url: string }
      | undefined;
    if (!existing) return { response: json({ error: "Webhook not found" }, 404), status: 404, owner };
    tx(db, () => {
      db.prepare("DELETE FROM webhooks WHERE owner_id = ? AND id = ?").run(owner, parts[1]);
      publish(db, owner, "configuration.updated", parts[1], { resource: "webhook", id: parts[1], url: existing.url, deleted: true });
    });
    return { response: json({ ok: true }), status: 200, owner };
  }

  if (method === "PATCH" && parts[0] === "notifications" && parts[1]) {
    tx(db, () => {
      const result = db.prepare("UPDATE notifications SET read = 1 WHERE owner_id = ? AND id = ?").run(owner, parts[1]);
      if (!result.changes) throw new RequestError(404, "Notification not found");
      publish(db, owner, "notification.read", parts[1], { id: parts[1], read: true });
    });
    return { response: json({ ok: true }), status: 200, owner };
  }

  if (key === "POST billing") {
    const plan = str((await body(req)).plan);
    if (!["community", "mesh", "hardware"].includes(plan)) return { response: json({ error: "Unknown plan" }, 400), status: 400, owner };
    tx(db, () => {
      db.prepare("UPDATE users SET plan = ? WHERE id = ?").run(plan, owner);
      publish(db, owner, "account.updated", owner, { id: owner, plan });
    });
    log(owner, "info", "billing", `plan preference set to ${plan}. No payment provider is configured, so nothing was charged.`);
    return { response: json({ ok: true, charged: false }), status: 200, owner };
  }

  if (key === "POST profile") {
    const name = str((await body(req)).name);
    if (name.length < 1 || name.length > 80) return { response: json({ error: "Name is required" }, 400), status: 400, owner };
    tx(db, () => {
      db.prepare("UPDATE users SET name = ? WHERE id = ?").run(name, owner);
      publish(db, owner, "account.updated", owner, { id: owner, name });
    });
    return { response: json({ ok: true }), status: 200, owner };
  }

  if (key === "POST vitals") {
    const input = await body(req);
    const metric = str(input.metric);
    const value = Number(input.value);
    const page = str(input.path).slice(0, 120) || "/";
    if (!["LCP", "INP", "CLS", "FCP", "TTFB"].includes(metric) || !Number.isFinite(value) || value < 0) {
      return { response: json({ error: "Vital metric or value is invalid" }, 400), status: 400, owner };
    }
    db.prepare("INSERT INTO vitals (id, owner_id, metric, value, path, at) VALUES (?, ?, ?, ?, ?, ?)").run(newId(), owner, metric, value, page, Date.now());
    return { response: json({ ok: true }), status: 201, owner };
  }

  if (key === "POST firewall") {
    const input = await body(req);
    const name = str(input.name).slice(0, 80);
    const action = str(input.action);
    const matchKey = str(input.matchKey);
    const matchOp = str(input.matchOp);
    const matchValue = str(input.matchValue).slice(0, 200);
    if (!name || !matchValue) return { response: json({ error: "Name and match value are required" }, 400), status: 400, owner };
    if (!["deny", "log", "rate_limit"].includes(action)) return { response: json({ error: "Unknown action" }, 400), status: 400, owner };
    if (!["path", "ip", "header", "ja4", "user_agent", "host"].includes(matchKey) || !["equals", "starts_with", "contains"].includes(matchOp)) {
      return { response: json({ error: "Unknown match" }, 400), status: 400, owner };
    }
    const limitCount = action === "rate_limit" ? Math.min(10000, Math.max(1, Number(input.limitCount) || 60)) : null;
    const windowSec = action === "rate_limit" ? Math.min(86400, Math.max(1, Number(input.windowSec) || 60)) : null;
    const id = newId();
    tx(db, () => {
      db.prepare(
        "INSERT INTO firewall_rules (id, owner_id, name, action, match_key, match_op, match_value, header_name, limit_count, window_sec, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)",
      ).run(id, owner, name, action, matchKey, matchOp, matchValue, str(input.headerName) || null, limitCount, windowSec, Date.now());
      publish(db, owner, "configuration.updated", id, { resource: "firewall_rule", id, name, action, matchKey, matchOp, matchValue });
    });
    log(owner, "info", "firewall", `saved rule ${name}`);
    return { response: json({ ok: true }), status: 201, owner };
  }
  if (method === "DELETE" && parts[0] === "firewall" && parts[1]) {
    const existing = db.prepare("SELECT name FROM firewall_rules WHERE owner_id = ? AND id = ?").get(owner, parts[1]) as
      | { name: string }
      | undefined;
    if (!existing) return { response: json({ error: "Rule not found" }, 404), status: 404, owner };
    tx(db, () => {
      db.prepare("DELETE FROM firewall_rules WHERE owner_id = ? AND id = ?").run(owner, parts[1]);
      publish(db, owner, "configuration.updated", parts[1], { resource: "firewall_rule", id: parts[1], name: existing.name, deleted: true });
    });
    return { response: json({ ok: true }), status: 200, owner };
  }

  if (key === "POST builds") {
    const input = await body(req);
    const target = str(input.target);
    if (!["android", "web"].includes(target)) return { response: json({ error: "Target must be android or web" }, 400), status: 400, owner };
    const project = db.prepare("SELECT id, name, repo_url AS repoUrl FROM projects WHERE owner_id = ? AND id = ?")
      .get(owner, str(input.projectId)) as { id: string; name: string; repoUrl: string | null } | undefined;
    if (!project) return { response: json({ error: "Project not found" }, 404), status: 404, owner };

    if (target === "android") {
      const note = "No bare-metal ARM64 runner, Gradle snapshot, or Android SDK is configured. The build was not started.";
      recordBuild(db, owner, project, target, "blocked", note);
      log(owner, "warn", "builds", `${project.name} ${target}: ${note}`);
      return { response: json({ ok: true, status: "blocked", note }), status: 201, owner };
    }

    const note = project.repoUrl ? BUILDER_DISABLED : NO_REPO_NOTE;
    recordBuild(db, owner, project, target, "blocked", note);
    log(owner, "warn", "builds", `${project.name} ${target}: ${note}`);
    return { response: json({ ok: true, status: "blocked", note }), status: 201, owner };
  }

  if (key === "POST workflows") {
    const name = safeSlug(str((await body(req)).name), "Workflow name");
    const id = newId();
    tx(db, () => {
      db.prepare("INSERT INTO workflows (id, owner_id, name, created_at) VALUES (?, ?, ?, ?)").run(id, owner, name, Date.now());
      publish(db, owner, "configuration.updated", id, { resource: "workflow", id, name });
    });
    return { response: json({ ok: true }), status: 201, owner };
  }
  if (method === "POST" && parts[0] === "workflows" && parts[2] === "run") {
    const row = db.prepare("SELECT id, name FROM workflows WHERE owner_id = ? AND id = ?").get(owner, parts[1]) as { id: string; name: string } | undefined;
    if (!row) return { response: json({ error: "Workflow not found" }, 404), status: 404, owner };
    const note = "Saved a run record. No workflow worker is configured, so no step was executed.";
    const id = newId();
    tx(db, () => {
      db.prepare(
        "INSERT INTO workflow_runs (id, owner_id, workflow_id, status, note, at) VALUES (?, ?, ?, 'not_executed', ?, ?)",
      ).run(id, owner, row.id, note, Date.now());
      publish(db, owner, "configuration.updated", row.id, { resource: "workflow_run", id, workflowId: row.id, workflow: row.name, status: "not_executed", note });
    });
    log(owner, "warn", "workflows", `${row.name}: ${note}`);
    return { response: json({ ok: true, status: "not_executed", note }), status: 202, owner };
  }

  if (key === "POST drives") {
    const name = safeSlug(str((await body(req)).name), "Drive name");
    const dir = join(dataRoot(), "drives", owner, name);
    mkdirSync(dir, { recursive: true });
    const id = newId();
    tx(db, () => {
      db.prepare("INSERT INTO drives (id, owner_id, name, path, created_at) VALUES (?, ?, ?, ?, ?)").run(id, owner, name, dir, Date.now());
      publish(db, owner, "configuration.updated", id, { resource: "drive", id, name });
    });
    log(owner, "info", "drives", `created local directory ${name}`);
    return { response: json({ ok: true }), status: 201, owner };
  }

  if (key === "POST shell") {
    const command = str((await body(req)).command);
    const [bin, arg] = command.split(/\s+/);
    let output = "";
    if (bin === "help") output = "help, whoami, projects, deployments, metrics";
    else if (bin === "whoami") output = `${user.name} <${user.email}> ${user.role}`;
    else if (bin === "projects") {
      const rows = listProjects(owner);
      output = rows.length ? rows.map((p) => p.name).join("\n") : "no projects";
    } else if (bin === "deployments") {
      const rows = listDeployments(owner);
      output = rows.length ? rows.map((d) => `${d.project} ${d.status}`).join("\n") : "no deployments";
    } else if (bin === "metrics") {
      const m = collectMetrics(db, owner, operatorMetrics);
      output = `uptime ${m.processUptimeSec}s\nmemory ${m.memoryUsedPct ?? "n/a"}%\nresponse ${m.responseAvgMs ?? "n/a"} ms (${m.responseSamples} samples)`;
    } else if (bin === "deploy" && arg) {
      output = "refused: deploy from the shell is not wired to a build runner";
    } else output = `unknown command: ${bin || "(empty)"}`;
    log(owner, "info", "shell", `$ ${command || "(empty)"}`);
    return { response: json({ output }), status: 200, owner };
  }

  return { response: json({ error: "Not found" }, 404), status: 404, owner };
}

/** Caller holds the transaction for credential issuance and its outbox rows. */
function startSession(db: DatabaseSync, userId: string, req: Request, deviceId: string | null = null): Headers {
  const token = randomBytes(32).toString("hex");
  const csrf = randomBytes(32).toString("hex");
  const agent = (req.headers.get("user-agent") ?? "unknown").slice(0, 180);
  const sessionId = newId();
  const now = Date.now();
  db.prepare(
    "INSERT INTO sessions (id, token_hash, user_id, expires_at, user_agent, created_at, csrf, device_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(sessionId, tokenHash(token), userId, now + WEEK, agent, now, csrf, deviceId);
  publish(db, userId, "session.created", sessionId, { sessionId, userAgent: agent });
  notify(db, userId, "auth.session", "New session", agent);
  const headers = new Headers();
  headers.append("set-cookie", cookieHeader(req, token, WEEK / 1000));
  headers.append("set-cookie", csrfCookieHeader(req, csrf, WEEK / 1000));
  return headers;
}

function issueSession(db: DatabaseSync, userId: string, req: Request) {
  const headers = tx(db, () => startSession(db, userId, req));
  const user = db.prepare("SELECT id, email, name, role, plan FROM users WHERE id = ?").get(userId);
  return { response: json({ user }, 200, headers), status: 200, owner: userId };
}

function listProjects(owner: string) {
  return openDb().prepare(
    "SELECT id, name, framework, target, repo_url AS repoUrl, created_at AS createdAt FROM projects WHERE owner_id = ? ORDER BY created_at DESC",
  ).all(owner);
}

function listDeployments(owner: string) {
  return openDb().prepare(
    `SELECT d.id, d.project_id AS projectId, p.name AS project, d.status, d.note, d.created_at AS createdAt
     FROM deployments d JOIN projects p ON p.id = d.project_id
     WHERE d.owner_id = ? ORDER BY d.created_at DESC LIMIT 100`,
  ).all(owner);
}

function listDomains(owner: string) {
  return openDb().prepare(
    `SELECT d.id, d.host, p.name AS project, d.status, d.detail
     FROM domains d JOIN projects p ON p.id = d.project_id
     WHERE d.owner_id = ? ORDER BY d.created_at DESC`,
  ).all(owner);
}

function listDatabases(owner: string) {
  const rows = openDb().prepare("SELECT id, name, path, created_at AS createdAt FROM db_files WHERE owner_id = ?").all(owner) as { id: string; name: string; path: string; createdAt: number }[];
  return rows.map((row) => {
    let bytes: number | null = null;
    try {
      bytes = statSync(row.path).size;
    } catch {
      bytes = null;
    }
    return { id: row.id, name: row.name, engine: "sqlite" as const, path: row.path, bytes };
  });
}

function listFunctions(owner: string) {
  return openDb().prepare(
    "SELECT id, name, route, invocations, 0 AS hasSource FROM functions WHERE owner_id = ? ORDER BY created_at DESC",
  ).all(owner).map((row) => {
    const item = row as { id: string; name: string; route: string; invocations: number; hasSource: number };
    return { ...item, hasSource: false };
  });
}

function listObjects(owner: string) {
  return openDb().prepare(
    "SELECT id, bucket, key, bytes FROM objects WHERE owner_id = ? ORDER BY created_at DESC",
  ).all(owner);
}

function listLogs(owner: string) {
  return openDb().prepare(
    "SELECT id, level, source, message, at FROM logs WHERE owner_id = ? ORDER BY at DESC LIMIT 100",
  ).all(owner);
}

function listTeam(owner: string) {
  const self = openDb().prepare("SELECT id, name, email, role FROM users WHERE id = ?").get(owner) as { id: string; name: string; email: string; role: string };
  const invites = openDb().prepare(
    "SELECT id, name, email, role, email_sent AS emailSent FROM invites WHERE owner_id = ? ORDER BY created_at DESC",
  ).all(owner) as { id: string; name: string; email: string; role: string; emailSent: number }[];
  return [
    { ...self, emailSent: true },
    ...invites.map((row) => ({ ...row, emailSent: row.emailSent === 1 })),
  ];
}

function listSettings(owner: string) {
  const row = openDb().prepare("SELECT value FROM settings WHERE owner_id = ? AND key = 'recordPageViews'").get(owner) as { value: string } | undefined;
  return { recordPageViews: row ? row.value === "1" : true };
}

function billing(user: User) {
  return {
    plan: user.plan,
    provider: null,
    charged: false,
    detail: "No payment provider is configured. Changing the plan only stores a preference and does not bill a card.",
  };
}
