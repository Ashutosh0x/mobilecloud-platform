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
import { assessLoginRisk, geoFor, listAuthEvents, logAuthEvent } from "./audit.ts";
import { approveDeviceCode, checkScope, createAuthorizationCode, denyDeviceCode, findClient, findDeviceCode, OAuthError, redeemAuthorizationCode, redeemDeviceCode, refreshTokens, startDeviceGrant } from "./oauth.ts";
import { beginAuthentication, beginRegistration, finishAuthentication, finishRegistration, PasskeyError, verifyAssertion } from "./passkey.ts";
import { approveQrLogin, consumeQrLogin, createQrLogin, denyQrLogin, QrLoginError, qrLoginStatus, scanQrLogin } from "./qrlogin.ts";
import { createSession, listAccountSessions, type ClientType } from "./sessions.ts";
import { EVENT_TYPES, changesSince, latestSeq, publish, snapshot, tx } from "./events.ts";
import { collectUsage, record as recordUsage } from "./metering.ts";
import { FunctionError, validateSource, runFunction } from "./runtime.ts";
import { deliverableHost, listDeliveries } from "./webhook.ts";
import { parseSteps, runWorkflow } from "./workflows.ts";
import { insertAttestation, porState, validateAttestation } from "./por.ts";
import { approveFromBrowser, approvePairing, closePairing, createPairing, expireStale, listDevices, markAwaitingApproval, publicPairing, readPairing, renameDevice, revokeDevice, scanPairing, scanProofMatches, secretMatches } from "./pairing.ts";
import { encodePairingTicket, renderPairingQr } from "./qr.ts";
import { renderLoginQr } from "./qr.ts";

const COOKIE = "mc_session";
const WEEK = 7 * 24 * 3600 * 1000;
const attempts = new Map<string, { n: number; reset: number }>();

/** Port the realtime gateway listens on; advertised through `GET /api/health`. */
function realtimePort(): number {
  const raw = Number(process.env.MOBILECLOUD_REALTIME_PORT ?? 3211);
  return Number.isFinite(raw) && raw > 0 ? raw : 3211;
}

type Authentication =
  | {
      user: User;
      via: "bearer";
      tokenId: string;
      deviceId: string | null;
      token: { id: string; name: string; scope: string; client_type: string; expires_at: number };
    }
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

/**
 * Answers a consent decision.
 *
 * A browser form submits a normal navigation and wants the 302; the console's
 * own consent page calls this endpoint with `accept: application/json` and
 * navigates itself, which keeps the authorization code out of a fetch response
 * the page cannot read across origins.
 */
function consentRedirect(req: Request, target: string) {
  if ((req.headers.get("accept") ?? "").toLowerCase().includes("application/json")) {
    return json({ redirect: target }, 200);
  }
  return new Response(null, { status: 302, headers: { location: target } });
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
  // A bearer credential is presented on every request, so there is no older
  // cookie session to re-confirm. Its scope is checked by bearerMayWrite.
  if (auth.via === "bearer") return;
  if (auth.deviceId || !auth.createdAt || Date.now() - auth.createdAt > 15 * 60_000) {
    throw new RequestError(403, "Sign in again with your password to perform this action");
  }
}

/**
 * The mutations a CLI bearer token may perform.
 *
 * Bearer tokens stay read-only by default: a leaked API token should not be
 * able to change the account. A token issued with the `cli:full` scope is
 * different — it is the credential `mobilecloud login` just created, and the
 * CLI is expected to manage the very sessions and devices it belongs to. Only
 * that narrow set of routes is writable; everything else still requires a
 * cookie session with CSRF.
 */
function bearerMayWrite(auth: Authentication, method: string, parts: string[]): boolean {
  if (auth.via !== "bearer") return true;
  if (!auth.token.scope.split(/\s+/).includes("cli:full")) return false;
  if (method === "POST" && parts[0] === "auth" && parts[1] === "logout") return true;
  if (method === "POST" && parts[0] === "auth" && parts[1] === "refresh") return true;
  if (method === "DELETE" && parts[0] === "devices" && parts[1] !== undefined) return true;
  return method === "DELETE" && parts[0] === "auth" && parts[1] === "sessions" && parts[2] !== undefined;
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

/** Event types a new webhook receives until the owner narrows them. */
const DEFAULT_WEBHOOK_EVENTS = "deployment.*,build.*,notification.created,account.updated";

/** Validates an event subscription (comma-separated string or array). `foo.*` is a family match. */
function subscription(raw: unknown): string {
  const tokens = (Array.isArray(raw) ? raw.map(str) : str(raw).split(",")).map((token) => token.trim()).filter(Boolean);
  if (!tokens.length) return DEFAULT_WEBHOOK_EVENTS;
  if (tokens.length > 16) throw new RequestError(400, "A webhook may subscribe to at most 16 event types");
  for (const token of tokens) {
    if (token === "*") continue;
    if (token.endsWith(".*")) {
      const prefix = token.slice(0, -1);
      if (!(EVENT_TYPES as readonly string[]).some((type) => type.startsWith(prefix))) {
        throw new RequestError(400, `${token} does not match any event family`);
      }
      continue;
    }
    if (!(EVENT_TYPES as readonly string[]).includes(token)) throw new RequestError(400, `${token} is not an event type`);
  }
  return tokens.join(",");
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
    const known = error instanceof RequestError || error instanceof FunctionError;
    status = known ? (error as RequestError).status : 500;
    if (status === 500) console.warn("Unexpected control-plane request failure");
    return json({ error: known ? (error as Error).message : "Request failed" }, status);
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
    const row = db.prepare("SELECT id, password_hash, locked_until FROM users WHERE email = ?").get(email) as
      { id: string; password_hash: string; locked_until: number | null } | undefined;
    // Run the same costly verifier for missing and reset-required accounts.
    const stored = row?.password_hash.includes(":") ? row.password_hash : `${"0".repeat(32)}:${"0".repeat(64)}`;
    if (!verifyPassword(password, stored) || !row || isRetiredPassword(password)) {
      logAuthEvent(db, {
        userId: row?.id ?? null,
        eventType: "auth.login.failed",
        clientType: "web",
        credentialType: "password",
        ipAddress: requestIp(req),
        userAgent: req.headers.get("user-agent")?.slice(0, 180) ?? null,
        geo: geoFor(requestIp(req)),
        outcome: "failure",
        failureReason: "invalid_credentials",
      });
      if (row) lockIfRepeatedFailures(db, row.id);
      throw new RequestError(401, "Email or password is wrong");
    }
    if (row.locked_until && row.locked_until > Date.now()) {
      throw new RequestError(429, "Too many failed attempts. Try again later.");
    }
    const risk = assessLoginRisk(db, {
      userId: row.id,
      ipAddress: requestIp(req),
      userAgent: req.headers.get("user-agent")?.slice(0, 180) ?? null,
      geo: geoFor(requestIp(req)),
      credentialType: "password",
      timezone: userTimezone(db, row.id),
    });
    if (risk.action === "block") {
      logAuthEvent(db, {
        userId: row.id,
        eventType: "auth.login.failed",
        clientType: "web",
        credentialType: "password",
        ipAddress: requestIp(req),
        geo: geoFor(requestIp(req)),
        outcome: "suspicious",
        failureReason: "risk_blocked",
        riskScore: risk.riskScore,
        metadata: { factors: risk.factors },
      });
      throw new RequestError(403, "This sign-in was blocked because it did not look like your usual sign-in.");
    }
    db.prepare("UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = ?").run(row.id);
    log(row.id, "info", "auth", "signed in");
    logAuthEvent(db, {
      userId: row.id,
      eventType: "auth.login.password",
      clientType: "web",
      credentialType: "password",
      ipAddress: requestIp(req),
      userAgent: req.headers.get("user-agent")?.slice(0, 180) ?? null,
      geo: geoFor(requestIp(req)),
      outcome: risk.action === "allow_with_notification" ? "suspicious" : "success",
      riskScore: risk.riskScore,
      metadata: { factors: risk.factors },
    });
    if (risk.action === "allow_with_notification") {
      notify(db, row.id, "auth.suspicious", "New sign-in", "A sign-in happened from a place you have not used before.");
    }
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
        // A refresh token outliving its access token would let a signed-out
        // client mint a fresh one, so the whole chain is retired here.
        db.prepare("UPDATE refresh_tokens SET revoked = 1 WHERE access_token_id = ?").run(auth.tokenId);
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
    return { response: json({ user: auth?.user ?? null, csrfToken, token: auth?.via === "bearer" ? auth.token : null }, 200, headers), status: 200, owner: auth?.user.id ?? null };
  }

  // ---- Unified authentication ---------------------------------------------
  // Passkey ceremonies, phone approved web login, and the OAuth grants the
  // CLI uses. Everything below runs before the "sign in required" gate, because
  // these endpoints are how a client signs in.

  if (method === "POST" && parts[0] === "auth" && parts[1] === "passkey" && parts[2] === "register" && parts[3] === "begin") {
    const input = await body(req, 16 * 1024);
    const deviceName = str(input.deviceName) || null;
    const devicePlatform = str(input.devicePlatform) || "android";
    const session = authenticate(req, db);
    if (session) requireCsrf(req, session);
    let userId: string;
    let email: string;
    let displayName: string;
    if (session) {
      userId = session.user.id;
      email = session.user.email;
      displayName = session.user.name;
    } else {
      // A passkey never bootstraps an account. Without a session the caller
      // proves the account with its password, once.
      const emailInput = str(input.email).toLowerCase();
      const password = str(input.password);
      if (!emailInput || !password) throw new RequestError(401, "Sign in, or prove the account with its password, to add a passkey.");
      throttle("passkey-register", emailInput, 6);
      const row = db.prepare("SELECT id, email, name, password_hash FROM users WHERE email = ?").get(emailInput) as
        { id: string; email: string; name: string; password_hash: string } | undefined;
      const stored = row?.password_hash.includes(":") ? row.password_hash : `${"0".repeat(32)}:${"0".repeat(64)}`;
      if (!row || !verifyPassword(password, stored) || isRetiredPassword(password)) {
        logAuthEvent(db, {
          eventType: "auth.login.failed",
          clientType: "android",
          credentialType: "password",
          ipAddress: requestIp(req),
          userAgent: req.headers.get("user-agent")?.slice(0, 180) ?? null,
          outcome: "failure",
          failureReason: "invalid_credentials",
        });
        throw new RequestError(401, "Email or password is wrong");
      }
      userId = row.id;
      email = row.email;
      displayName = row.name;
    }
    const options = beginRegistration(db, passkeyConfig(req), { userId, email, displayName, deviceName, devicePlatform });
    return { response: json(options), status: 200, owner: userId };
  }

  if (method === "POST" && parts[0] === "auth" && parts[1] === "passkey" && parts[2] === "register" && parts[3] === "finish") {
    const input = await body(req, 256 * 1024);
    throttle("passkey-register-finish");
    let registered;
    try {
      registered = finishRegistration(db, passkeyConfig(req), { challengeId: str(input.challengeId), credential: input.credential });
    } catch (error) {
      if (error instanceof PasskeyError) throw new RequestError(error.status, error.message);
      throw error;
    }
    const deviceName = str(input.deviceName) || "Android device";
    const devicePlatform = str(input.devicePlatform) || "android";
    const deviceId = linkPasskeyDevice(db, registered.userId, deviceName, devicePlatform, registered.credentialId);
    const headers = startSession(db, registered.userId, req, deviceId, "android", registered.credentialId);
    const user = db.prepare("SELECT id, email, name, role, plan FROM users WHERE id = ?").get(registered.userId);
    logAuthEvent(db, {
      userId: registered.userId,
      eventType: "auth.credential.created",
      clientType: "android",
      credentialType: "passkey",
      deviceId,
      ipAddress: requestIp(req),
      userAgent: req.headers.get("user-agent")?.slice(0, 180) ?? null,
      geo: geoFor(requestIp(req)),
      outcome: "success",
    });
    return { response: json({ user, credential_id: registered.credentialId, device_id: deviceId }, 200, headers), status: 200, owner: registered.userId };
  }

  if (method === "POST" && parts[0] === "auth" && parts[1] === "passkey" && parts[2] === "login" && parts[3] === "begin") {
    const input = await body(req, 8 * 1024);
    const email = str(input.email).toLowerCase() || null;
    const options = beginAuthentication(db, passkeyConfig(req), {
      email,
      deviceName: str(input.deviceName) || null,
      devicePlatform: str(input.devicePlatform) || "android",
    });
    return { response: json(options), status: 200, owner: null };
  }

  if (method === "POST" && parts[0] === "auth" && parts[1] === "passkey" && parts[2] === "login" && parts[3] === "finish") {
    const input = await body(req, 256 * 1024);
    throttle("passkey-login");
    let signed;
    try {
      signed = finishAuthentication(db, passkeyConfig(req), { challengeId: str(input.challengeId), credential: input.credential });
    } catch (error) {
      if (error instanceof PasskeyError) {
        logAuthEvent(db, {
          eventType: "auth.login.failed",
          clientType: str(input.devicePlatform) || "android",
          credentialType: "passkey",
          ipAddress: requestIp(req),
          userAgent: req.headers.get("user-agent")?.slice(0, 180) ?? null,
          outcome: "failure",
          failureReason: "invalid_assertion",
        });
        throw new RequestError(error.status, error.message);
      }
      throw error;
    }
    const ip = requestIp(req);
    const geo = geoFor(ip);
    const risk = assessLoginRisk(db, {
      userId: signed.userId,
      ipAddress: ip,
      userAgent: req.headers.get("user-agent")?.slice(0, 180) ?? null,
      geo,
      credentialType: "passkey",
      timezone: userTimezone(db, signed.userId),
    });
    if (risk.action === "block") {
      logAuthEvent(db, {
        userId: signed.userId,
        eventType: "auth.login.failed",
        clientType: str(input.devicePlatform) || "android",
        credentialType: "passkey",
        ipAddress: ip,
        geo,
        outcome: "suspicious",
        failureReason: "risk_blocked",
        riskScore: risk.riskScore,
        metadata: { factors: risk.factors },
      });
      throw new RequestError(403, "This sign-in was blocked because it did not look like your usual sign-in.");
    }
    const deviceName = str(input.deviceName) || "Android device";
    const devicePlatform = str(input.devicePlatform) || "android";
    const deviceId = linkPasskeyDevice(db, signed.userId, deviceName, devicePlatform, signed.credentialId);
    const headers = startSession(db, signed.userId, req, deviceId, "android", signed.credentialId);
    const user = db.prepare("SELECT id, email, name, role, plan FROM users WHERE id = ?").get(signed.userId);
    logAuthEvent(db, {
      userId: signed.userId,
      eventType: "auth.login.passkey",
      clientType: devicePlatform,
      credentialType: "passkey",
      deviceId,
      ipAddress: ip,
      userAgent: req.headers.get("user-agent")?.slice(0, 180) ?? null,
      geo,
      outcome: risk.action === "allow_with_notification" ? "suspicious" : "success",
      riskScore: risk.riskScore,
      metadata: { factors: risk.factors },
    });
    if (risk.action === "allow_with_notification") {
      notify(db, signed.userId, "auth.suspicious", "New sign-in", "A sign-in happened from a place you have not used before.");
    }
    return { response: json({ user, device_id: deviceId }, 200, headers), status: 200, owner: signed.userId };
  }

  if (method === "POST" && parts[0] === "auth" && parts[1] === "qr-login" && parts[2] === "init") {
    const input = await body(req, 8 * 1024);
    throttle("qr-login-init");
    const browser = str(input.browser).slice(0, 180) || null;
    const created = createQrLogin(db, passkeyConfig(req), { browserInfo: browser, ipAddress: requestIp(req) });
    const qrDataUrl = await renderLoginQr(created.qrPayload);
    logAuthEvent(db, {
      eventType: "auth.login.qr_requested",
      clientType: "web",
      credentialType: "qr",
      ipAddress: requestIp(req),
      userAgent: req.headers.get("user-agent")?.slice(0, 180) ?? null,
      outcome: "success",
    });
    return {
      response: json({
        challenge_id: created.challengeId,
        verification_code: created.verificationCode,
        qr_data_url: qrDataUrl,
        // The payload is the same string the QR encodes. Returning it lets the
        // console offer "open in app" and lets tests exercise the phone half.
        qr_payload: created.qrPayload,
        poll_secret: created.pollSecret,
        expires_in_ms: created.expiresInMs,
      }),
      status: 200,
      owner: null,
    };
  }

  if (method === "POST" && parts[0] === "auth" && parts[1] === "qr-login" && parts[2] && parts[3] === "scan") {
    const input = await body(req, 8 * 1024);
    try {
      scanQrLogin(db, parts[2], { deviceName: str(input.deviceName) || null, devicePlatform: str(input.devicePlatform) || null });
    } catch (error) {
      if (error instanceof QrLoginError) throw new RequestError(error.status, error.message);
      throw error;
    }
    return { response: json({ ok: true }), status: 200, owner: null };
  }

  if (method === "POST" && parts[0] === "auth" && parts[1] === "qr-login" && parts[2] && parts[3] === "approve") {
    const input = await body(req, 256 * 1024);
    throttle("qr-login-approve");
    const challenge = str(input.challenge);
    const verificationCode = str(input.verification_code) || str(input.verificationCode);
    let userId: string;
    let credentialId: string | null = null;
    let deviceId: string | null = null;
    if (input.credential) {
      // The phone proved itself with a passkey over the browser's challenge.
      let asserted;
      try {
        asserted = verifyAssertion(db, passkeyConfig(req), { credential: input.credential, expectedChallengeHex: challenge });
      } catch (error) {
        if (error instanceof PasskeyError) throw new RequestError(error.status, error.message);
        throw error;
      }
      userId = asserted.userId;
      credentialId = asserted.credentialId;
    } else {
      // Without a passkey the phone's own signed in session stands in.
      const session = authenticate(req, db);
      if (!session) throw new RequestError(401, "Sign in on the phone before approving this request.");
      requireCsrf(req, session);
      userId = session.user.id;
      deviceId = session.deviceId;
    }
    try {
      approveQrLogin(db, { challengeId: parts[2], challenge, verificationCode, userId, credentialId, deviceId });
    } catch (error) {
      if (error instanceof QrLoginError) throw new RequestError(error.status, error.message);
      throw error;
    }
    logAuthEvent(db, {
      userId,
      eventType: "auth.login.qr_approved",
      clientType: "web",
      credentialType: credentialId ? "passkey" : "token",
      deviceId,
      ipAddress: requestIp(req),
      userAgent: req.headers.get("user-agent")?.slice(0, 180) ?? null,
      outcome: "success",
    });
    notify(db, userId, "auth.session", "Web sign-in approved", "A browser signed in to your account from your phone.");
    return { response: json({ ok: true }), status: 200, owner: userId };
  }

  if (method === "POST" && parts[0] === "auth" && parts[1] === "qr-login" && parts[2] && parts[3] === "deny") {
    try {
      denyQrLogin(db, parts[2]);
    } catch (error) {
      if (error instanceof QrLoginError) throw new RequestError(error.status, error.message);
      throw error;
    }
    return { response: json({ ok: true }), status: 200, owner: null };
  }

  if (method === "GET" && parts[0] === "auth" && parts[1] === "qr-login" && parts[2] && !parts[3]) {
    const pollSecret = new URL(req.url).searchParams.get("poll") ?? "";
    let state;
    try {
      state = qrLoginStatus(db, parts[2], pollSecret);
    } catch (error) {
      if (error instanceof QrLoginError) throw new RequestError(error.status, error.message);
      throw error;
    }
    if (state.status !== "approved" || !state.row) {
      return { response: json({ status: state.status.toUpperCase() }), status: 200, owner: null };
    }
    // The browser that started the flow now receives the session. Claiming the
    // challenge and issuing the session happen in one transaction, so two polls
    // racing cannot both walk away with a credential.
    const row = state.row;
    const headers = tx(db, () => {
      if (!consumeQrLogin(db, parts[2])) return null;
      return startSession(db, row.approved_by ?? "", req, row.device_id, "web", row.credential_id);
    });
    if (!headers) {
      return { response: json({ status: "CONSUMED" }), status: 200, owner: null };
    }
    logAuthEvent(db, {
      userId: row.approved_by,
      eventType: "auth.login.qr_approved",
      clientType: "web",
      credentialType: "qr",
      deviceId: row.device_id,
      ipAddress: requestIp(req),
      userAgent: req.headers.get("user-agent")?.slice(0, 180) ?? null,
      outcome: "success",
    });
    return { response: json({ status: "APPROVED" }, 200, headers), status: 200, owner: row.approved_by };
  }

  // ---- OAuth: device authorization grant and PKCE -------------------------

  if (method === "POST" && parts[0] === "oauth" && parts[1] === "device" && parts[2] === "code") {
    const input = await body(req, 8 * 1024);
    throttle("oauth-device-code");
    try {
      const grant = startDeviceGrant(db, {
        clientId: str(input.client_id) || str(input.clientId),
        scope: str(input.scope) || null,
        verificationUri: `${originOf(req)}/activate`,
      });
      return {
        response: json({
          device_code: grant.deviceCode,
          user_code: grant.userCode,
          verification_uri: grant.verificationUri,
          verification_uri_complete: grant.verificationUriComplete,
          expires_in: grant.expiresIn,
          interval: grant.interval,
        }),
        status: 200,
        owner: null,
      };
    } catch (error) {
      if (error instanceof OAuthError) throw new RequestError(error.status, error.message);
      throw error;
    }
  }

  if (method === "POST" && parts[0] === "oauth" && parts[1] === "device" && parts[2] === "verify") {
    const input = await body(req, 8 * 1024);
    const session = authenticate(req, db);
    if (!session) throw new RequestError(401, "Sign in to approve this request.");
    requireCsrf(req, session);
    const code = findDeviceCode(db, str(input.user_code) || str(input.userCode));
    if (!code || code.expires_at <= Date.now()) throw new RequestError(404, "That code is not valid.");
    if (code.approved_by) throw new RequestError(409, "That request was already approved.");
    return {
      response: json({
        id: code.id,
        user_code: code.user_code,
        client_id: code.client_id,
        scope: code.scope,
        status: code.status,
        expires_in_ms: Math.max(0, code.expires_at - Date.now()),
      }),
      status: 200,
      owner: session.user.id,
    };
  }

  if (method === "POST" && parts[0] === "oauth" && parts[1] === "device" && parts[2] && parts[3] === "approve") {
    const session = authenticate(req, db);
    if (!session) throw new RequestError(401, "Sign in to approve this request.");
    requireCsrf(req, session);
    const input = await body(req, 4096);
    try {
      approveDeviceCode(db, parts[2], session.user.id, {
        name: str(input.device_name) || str(input.deviceName) || null,
        platform: str(input.device_platform) || str(input.devicePlatform) || null,
      });
    } catch (error) {
      if (error instanceof OAuthError) throw new RequestError(error.status, error.message);
      throw error;
    }
    logAuthEvent(db, {
      userId: session.user.id,
      eventType: "auth.login.device_grant",
      clientType: "cli",
      credentialType: "device_grant",
      ipAddress: requestIp(req),
      userAgent: req.headers.get("user-agent")?.slice(0, 180) ?? null,
      outcome: "success",
    });
    notify(db, session.user.id, "auth.session", "CLI signed in", "A command line client was authorized.");
    return { response: json({ ok: true }), status: 200, owner: session.user.id };
  }

  if (method === "POST" && parts[0] === "oauth" && parts[1] === "device" && parts[2] && parts[3] === "deny") {
    const session = authenticate(req, db);
    if (!session) throw new RequestError(401, "Sign in to answer this request.");
    requireCsrf(req, session);
    try {
      denyDeviceCode(db, parts[2]);
    } catch (error) {
      if (error instanceof OAuthError) throw new RequestError(error.status, error.message);
      throw error;
    }
    return { response: json({ ok: true }), status: 200, owner: session.user.id };
  }

  if (method === "POST" && parts[0] === "oauth" && parts[1] === "token") {
    const input = await body(req, 16 * 1024);
    const grantType = str(input.grant_type) || str(input.grantType);
    throttle("oauth-token", undefined, 240);
    try {
      if (grantType === "urn:ietf:params:oauth:grant-type:device_code") {
        const pair = redeemDeviceCode(db, {
          deviceCode: str(input.device_code) || str(input.deviceCode),
          clientId: str(input.client_id) || str(input.clientId),
        });
        return {
          response: json({
            access_token: pair.accessToken,
            token_type: pair.tokenType,
            expires_in: pair.expiresIn,
            refresh_token: pair.refreshToken,
            scope: pair.scope,
          }),
          status: 200,
          owner: null,
        };
      }
      if (grantType === "refresh_token") {
        const pair = refreshTokens(db, str(input.refresh_token) || str(input.refreshToken));
        return {
          response: json({
            access_token: pair.accessToken,
            token_type: pair.tokenType,
            expires_in: pair.expiresIn,
            refresh_token: pair.refreshToken,
            scope: pair.scope,
          }),
          status: 200,
          owner: null,
        };
      }
      if (grantType === "authorization_code") {
        const pair = redeemAuthorizationCode(db, {
          code: str(input.code),
          codeVerifier: str(input.code_verifier) || str(input.codeVerifier),
          clientId: str(input.client_id) || str(input.clientId),
          redirectUri: str(input.redirect_uri) || str(input.redirectUri),
        });
        return {
          response: json({
            access_token: pair.accessToken,
            token_type: pair.tokenType,
            expires_in: pair.expiresIn,
            refresh_token: pair.refreshToken,
            scope: pair.scope,
          }),
          status: 200,
          owner: null,
        };
      }
    } catch (error) {
      if (error instanceof OAuthError) {
        return {
          response: json({ error: error.code, error_description: error.message }, error.status),
          status: error.status,
          owner: null,
        };
      }
      throw error;
    }
    throw new RequestError(400, `That grant type is not supported: ${grantType}`);
  }

  if (method === "GET" && parts[0] === "oauth" && parts[1] === "authorize") {
    const params = new URL(req.url).searchParams;
    const clientId = params.get("client_id") ?? "";
    const redirectUri = params.get("redirect_uri") ?? "";
    const challenge = params.get("code_challenge") ?? "";
    const client = findClient(clientId);
    if (!client) throw new RequestError(400, "That client is not registered.");
    if (!isLoopbackRedirect(redirectUri)) throw new RequestError(400, "That redirect address is not registered.");
    if (!challenge) throw new RequestError(400, "A code challenge is required.");
    const target = new URL("/authorize", originOf(req));
    target.search = params.toString();
    return { response: new Response(null, { status: 302, headers: { location: target.toString() } }), status: 302, owner: null };
  }

  if (method === "POST" && parts[0] === "oauth" && parts[1] === "authorize") {
    const input = await body(req, 8 * 1024);
    const session = authenticate(req, db);
    if (!session) throw new RequestError(401, "Sign in to authorize this client.");
    requireCsrf(req, session);
    const clientId = str(input.client_id) || str(input.clientId);
    const redirectUri = str(input.redirect_uri) || str(input.redirectUri);
    const challenge = str(input.code_challenge) || str(input.codeChallenge);
    const state = str(input.state);
    const client = findClient(clientId);
    if (!client) throw new RequestError(400, "That client is not registered.");
    if (!isLoopbackRedirect(redirectUri)) throw new RequestError(400, "That redirect address is not registered.");
    const scope = checkScope(client, str(input.scope) || null);
    if (str(input.decision) !== "approve") {
      const denied = new URL(redirectUri);
      denied.searchParams.set("error", "access_denied");
      if (state) denied.searchParams.set("state", state);
      const response = consentRedirect(req, denied.toString());
      return { response, status: response.status, owner: session.user.id };
    }
    const code = createAuthorizationCode(db, {
      clientId,
      userId: session.user.id,
      redirectUri,
      scope,
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
    });
    const target = new URL(redirectUri);
    target.searchParams.set("code", code);
    if (state) target.searchParams.set("state", state);
    logAuthEvent(db, {
      userId: session.user.id,
      eventType: "auth.login.device_grant",
      clientType: "cli",
      credentialType: "device_grant",
      ipAddress: requestIp(req),
      userAgent: req.headers.get("user-agent")?.slice(0, 180) ?? null,
      outcome: "success",
    });
    const response = consentRedirect(req, target.toString());
    return { response, status: response.status, owner: session.user.id };
  }

  if (method === "GET" && parts[0] === "auth" && parts[1] === "events") {
    const auth = authenticate(req, db);
    if (!auth) throw new RequestError(401, "Sign in required");
    return { response: json({ events: listAuthEvents(db, auth.user.id) }), status: 200, owner: auth.user.id };
  }

  if (method === "POST" && parts[0] === "auth" && parts[1] === "refresh") {
    const input = await body(req, 8 * 1024);
    const session = authenticate(req, db);
    if (!session) throw new RequestError(401, "Sign in required");
    requireCsrf(req, session);
    let pair;
    try {
      pair = refreshTokens(db, str(input.refresh_token) || str(input.refreshToken));
    } catch (error) {
      if (error instanceof OAuthError) throw new RequestError(error.status, error.message);
      throw error;
    }
    logAuthEvent(db, {
      userId: session.user.id,
      eventType: "auth.token.refreshed",
      clientType: "cli",
      credentialType: "token",
      ipAddress: requestIp(req),
      outcome: "success",
    });
    return {
      response: json({
        access_token: pair.accessToken,
        token_type: pair.tokenType,
        expires_in: pair.expiresIn,
        refresh_token: pair.refreshToken,
        scope: pair.scope,
      }),
      status: 200,
      owner: session.user.id,
    };
  }

  const auth = authenticate(req, db);
  if (!auth) throw new RequestError(401, "Sign in required");
  const user = auth.user;
  const owner = user.id;
  const operatorMetrics = user.role === "owner" && auth.via === "cookie" && auth.deviceId === null;
  requireCsrf(req, auth);
  if (method !== "GET" && method !== "HEAD" && !bearerMayWrite(auth, method, parts)) {
    throw new RequestError(403, "This credential may only read the account. Sign in to make changes.");
  }
  if (method !== "GET" && (parts[0] === "tokens" || parts[0] === "sessions" || parts[0] === "webhooks" || parts[0] === "devices"
    || (parts[0] === "auth" && parts[1] === "sessions")
    || key === "POST device/approve" || (parts[0] === "device" && parts[1] === "pairing")
    || key === "POST protection" || key === "DELETE protection")) {
    requireRecentLogin(auth);
  }
  // Client scoped sessions, listed and revoked by the console and by
  // `mobilecloud sessions` / `mobilecloud revoke-session`.
  if (key === "GET auth/sessions") {
    return {
      response: json({ sessions: listAccountSessions(db, owner, auth.via === "cookie" ? auth.hash : null) }),
      status: 200,
      owner,
    };
  }
  if (method === "DELETE" && parts[0] === "auth" && parts[1] === "sessions" && parts[2]) {
    const target = db.prepare(
      "SELECT id, token_hash AS tokenHash FROM sessions WHERE user_id = ? AND (id = ? OR token_hash = ?)",
    ).get(owner, parts[2], parts[2]) as { id: string | null; tokenHash: string } | undefined;
    if (!target) {
      // A CLI or API credential has no session row; `sessions` lists it as a
      // token, and revoking it retires the token and its refresh chain.
      const token = db.prepare(
        "SELECT id, client_type AS clientType FROM access_tokens WHERE owner_id = ? AND id = ? AND expires_at > ?",
      ).get(owner, parts[2], Date.now()) as { id: string; clientType: string | null } | undefined;
      if (!token) throw new RequestError(404, "Session not found");
      const now = Date.now();
      tx(db, () => {
        db.prepare("UPDATE access_tokens SET expires_at = ? WHERE id = ?").run(now, token.id);
        db.prepare("UPDATE refresh_tokens SET revoked = 1 WHERE access_token_id = ?").run(token.id);
        publish(db, owner, "session.revoked", token.id, {
          sessionId: token.id,
          reason: "revoked_by_user",
          clientType: token.clientType ?? "cli",
        });
      });
      log(owner, "info", "auth", "revoked a client token");
      return { response: json({ ok: true }), status: 200, owner };
    }
    if (auth.via === "cookie" && target.tokenHash === auth.hash) {
      throw new RequestError(400, "That is the current browser session. Sign out instead.");
    }
    tx(db, () => {
      db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(target.tokenHash);
      publish(db, owner, "session.revoked", target.id ?? target.tokenHash, {
        sessionId: target.id ?? target.tokenHash,
        reason: "revoked_by_user",
      });
    });
    log(owner, "info", "auth", "revoked a client session");
    return { response: json({ ok: true }), status: 200, owner };
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
      usage: collectUsage(db, owner, user.plan),
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
      webhookDeliveries: listDeliveries(db, owner, 25),
      por: porState(db, owner),
      protection: protectionStatus(db, owner, readGate(req)),
      identity: identityProviders(),
    }));
    return { response: json(result), status: 200, owner };
  }

  if (key === "GET metrics") return { response: json(collectMetrics(db, owner, operatorMetrics)), status: 200, owner };
  if (key === "GET host") return { response: json(collectHost(operatorMetrics)), status: 200, owner };
  if (key === "GET usage") return { response: json(collectUsage(db, owner, user.plan)), status: 200, owner };
  if (key === "GET por") return { response: json(porState(db, owner)), status: 200, owner };
  if (key === "POST por") {
    // Ingestion for the (external) attestor: it publishes the por-kernel output
    // verbatim. The control plane never computes a reserve ratio itself.
    const validated = validateAttestation(await body(req));
    if (!validated.ok) return { response: json({ error: validated.error }, 400), status: 400, owner };
    const attestation = tx(db, () => {
      const row = insertAttestation(db, owner, validated.value);
      publish(db, owner, "por.attested", row.id, { status: row.status, reserveRatioBps: row.reserveRatioBps });
      return row;
    });
    return { response: json({ ok: true, attestation }, 201), status: 201, owner };
  }
  if (key === "GET webhook-deliveries") {
    return { response: json({ deliveries: listDeliveries(db, owner, 100) }), status: 200, owner };
  }
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
    const source = validateSource(input.source);
    const id = newId();
    tx(db, () => {
      db.prepare(
        "INSERT INTO functions (id, owner_id, name, route, source, invocations, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)",
      ).run(id, owner, name, routePath, source, Date.now());
      publish(db, owner, "configuration.updated", id, { resource: "function", id, name, route: routePath });
    });
    log(owner, "info", "functions", `registered ${name} with ${Buffer.byteLength(source, "utf8")} bytes of handler source`);
    return { response: json({ ok: true, hasSource: true }), status: 201, owner };
  }
  if (method === "POST" && parts[0] === "functions" && parts[2] === "invoke") {
    const row = db.prepare("SELECT id, name, route, source FROM functions WHERE owner_id = ? AND id = ?")
      .get(owner, parts[1]) as { id: string; name: string; route: string; source: string | null } | undefined;
    if (!row) return { response: json({ error: "Function not found" }, 404), status: 404, owner };
    if (!row.source) {
      log(owner, "error", "functions", `${row.name} was not invoked: no handler source is stored`);
      return { response: json({ error: "No handler source is stored for this function, so it was not executed." }, 409), status: 409, owner };
    }
    const input = await body(req);
    const url = new URL(req.url);
    const result = runFunction(row.source, {
      method: "POST",
      path: row.route,
      query: Object.fromEntries(url.searchParams),
      headers: { "content-type": "application/json" },
      body: input,
    });
    tx(db, () => {
      db.prepare("UPDATE functions SET invocations = invocations + 1 WHERE owner_id = ? AND id = ?").run(owner, row.id);
      recordUsage(db, owner, "function_invocations", 1, row.id);
      publish(db, owner, "configuration.updated", row.id, { resource: "function_invocation", id: row.id, name: row.name, status: result.status, durationMs: result.durationMs });
    });
    log(owner, "info", "functions", `${row.name} returned ${result.status} in ${result.durationMs} ms`);
    return { response: json(result, result.status), status: result.status, owner };
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
    const events = subscription(input.events);
    const secret = randomBytes(16).toString("hex");
    const id = newId();
    tx(db, () => {
      db.prepare("INSERT INTO webhooks (id, owner_id, url, secret, events, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
        id, owner, url, secret, events, Date.now(),
      );
      publish(db, owner, "configuration.updated", id, { resource: "webhook", id, url });
    });
    log(owner, "info", "webhooks", `registered ${new URL(url).host} for ${events}`);
    return { response: json({ secret, deliveryEnabled: true, events, deliverable: deliverableHost(url) }, 201), status: 201, owner };
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
    const input = await body(req);
    const name = safeSlug(str(input.name), "Workflow name");
    const steps = parseSteps(input.steps);
    const id = newId();
    tx(db, () => {
      db.prepare("INSERT INTO workflows (id, owner_id, name, steps, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(id, owner, name, JSON.stringify(steps), Date.now());
      publish(db, owner, "configuration.updated", id, { resource: "workflow", id, name, steps: steps.length });
    });
    log(owner, "info", "workflows", `saved ${name} with ${steps.length} step${steps.length === 1 ? "" : "s"}`);
    return { response: json({ ok: true, steps: steps.length }), status: 201, owner };
  }
  if (method === "POST" && parts[0] === "workflows" && parts[2] === "run") {
    const row = db.prepare("SELECT id, name, steps FROM workflows WHERE owner_id = ? AND id = ?")
      .get(owner, parts[1]) as { id: string; name: string; steps: string | null } | undefined;
    if (!row) return { response: json({ error: "Workflow not found" }, 404), status: 404, owner };
    const outcome = runWorkflow(db, owner, row);
    const id = newId();
    tx(db, () => {
      db.prepare(
        "INSERT INTO workflow_runs (id, owner_id, workflow_id, status, note, at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(id, owner, row.id, outcome.status, outcome.note, Date.now());
      recordUsage(db, owner, "workflow_runs", 1, row.id);
      publish(db, owner, "configuration.updated", row.id, { resource: "workflow_run", id, workflowId: row.id, workflow: row.name, status: outcome.status, note: outcome.note });
    });
    log(owner, outcome.status === "succeeded" ? "info" : "warn", "workflows", `${row.name}: ${outcome.note}`);
    return { response: json({ ok: outcome.status === "succeeded", status: outcome.status, note: outcome.note, steps: outcome.steps }), status: 200, owner };
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

/**
 * The relying party a passkey ceremony is bound to.
 *
 * The relying party id is the host of the console, and the origin is the
 * console's public address. Both come from the server's own configuration
 * when there is one, so a request cannot talk the server into accepting a
 * passkey for somebody else's site.
 */
function passkeyConfig(req: Request): { rpId: string; rpName: string; origin: string } {
  const origin = publicOrigin() ?? originOf(req);
  const url = new URL(origin);
  return { rpId: url.hostname, rpName: "MobileCloud", origin };
}

/** The address a request came from, when the deployment can be trusted for it. */
function requestIp(req: Request): string | null {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first && first.length <= 64) return first;
  }
  return req.headers.get("x-real-ip")?.slice(0, 64) ?? null;
}

/**
 * Locks an account after a run of failed password attempts.
 *
 * Ten failures inside fifteen minutes close the account for fifteen minutes.
 * The account, not the address, is what gets locked, so a shared address
 * cannot lock an account out and a distributed attempt cannot spread over it.
 */
function lockIfRepeatedFailures(db: DatabaseSync, userId: string): void {
  const failures = db.prepare(
    "SELECT COUNT(*) AS n FROM auth_events WHERE user_id = ? AND event_type = 'auth.login.failed' AND created_at > ?",
  ).get(userId, Date.now() - 15 * 60_000) as { n: number };
  if (Number(failures?.n ?? 0) < 10) return;
  db.prepare("UPDATE users SET failed_attempts = failed_attempts + 1, locked_until = ? WHERE id = ?").run(Date.now() + 15 * 60_000, userId);
  logAuthEvent(db, {
    userId,
    eventType: "auth.suspicious.brute_force",
    clientType: "web",
    credentialType: "password",
    outcome: "suspicious",
    riskScore: "critical",
    failureReason: "account_locked",
  });
  notify(db, userId, "auth.suspicious", "Account locked", "Too many failed sign-in attempts. The account was locked for 15 minutes.");
}

/** The timezone an account records, used by the unusual hour risk factor. */
function userTimezone(db: DatabaseSync, userId: string): string | null {
  const row = db.prepare("SELECT timezone FROM users WHERE id = ?").get(userId) as { timezone: string | null } | undefined;
  return row?.timezone ?? null;
}

/**
 * Records the device a passkey belongs to.
 *
 * A phone that registers a passkey becomes a linked device with its own
 * durable credential, so it can be listed and revoked like any other device.
 */
function linkPasskeyDevice(db: DatabaseSync, userId: string, name: string, platform: string, credentialId: string): string {
  const existing = db.prepare(
    "SELECT id FROM connected_devices WHERE owner_id = ? AND platform = ? AND revoked = 0 AND method = 'passkey' ORDER BY created_at DESC LIMIT 1",
  ).get(userId, platform) as { id: string } | undefined;
  const now = Date.now();
  if (existing) {
    db.prepare("UPDATE connected_devices SET name = ?, last_active = ? WHERE id = ?").run(name.slice(0, 60), now, existing.id);
    return existing.id;
  }
  const issued = createToken(db, userId, `device: ${name}`.slice(0, 60), 30);
  const deviceId = newId();
  db.prepare(
    `INSERT INTO connected_devices (id, owner_id, token_id, name, platform, method, created_at, paired_at, last_active, revoked)
     VALUES (?, ?, ?, ?, ?, 'passkey', ?, ?, ?, 0)`,
  ).run(deviceId, userId, issued.id, name.slice(0, 60), platform, now, now, now);
  db.prepare("UPDATE credentials SET device_name = ? WHERE id = ? AND user_id = ?").run(name.slice(0, 60), credentialId, userId);
  return deviceId;
}

/**
 * Accepts a loopback redirect for the PKCE flow.
 *
 * RFC 8252 lets a native client use any port on the loopback address, so the
 * port is checked for range but not for an exact match. Nothing else is
 * accepted: a redirect to a remote host would leak the authorization code.
 */
function isLoopbackRedirect(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "http:") return false;
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost" && url.hostname !== "[::1]") return false;
  if (url.username || url.password) return false;
  return url.pathname.length > 0 && url.pathname.length <= 64;
}

/** Caller holds the transaction for credential issuance and its outbox rows. */
function startSession(
  db: DatabaseSync,
  userId: string,
  req: Request,
  deviceId: string | null = null,
  clientType: ClientType = "web",
  credentialId: string | null = null,
): Headers {
  const build = () => {
    const created = createSession(db, {
      userId,
      clientType,
      userAgent: req.headers.get("user-agent") ?? "unknown",
      deviceId,
      credentialId,
      ipAddress: requestIp(req),
    });
    const maxAge = Math.max(1, Math.floor((created.expiresAt - Date.now()) / 1000));
    notify(db, userId, "auth.session", "New session", req.headers.get("user-agent") ?? "unknown");
    const headers = new Headers();
    headers.append("set-cookie", cookieHeader(req, created.token, maxAge));
    headers.append("set-cookie", csrfCookieHeader(req, created.csrf, maxAge));
    return headers;
  };
  // The session row and the event that announces it belong together.
  return db.isTransaction ? build() : tx(db, build);
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
    "SELECT id, name, route, invocations, source IS NOT NULL AS hasSource FROM functions WHERE owner_id = ? ORDER BY created_at DESC",
  ).all(owner).map((row) => {
    const item = row as { id: string; name: string; route: string; invocations: number; hasSource: number };
    return { ...item, hasSource: item.hasSource === 1 };
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
