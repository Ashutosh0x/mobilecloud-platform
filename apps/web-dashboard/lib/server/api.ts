import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { CSRF_COOKIE, CSRF_HEADER } from "../csrf.ts";
import type { RangeKey, User } from "../types.ts";
import { builderEnabled, dispatchDeploy, dispatchRollback, fetchEngineDeployments, probeBuilder } from "./builder.ts";
import { dataRoot, hashPassword, newId, openDb, tokenHash, verifyPassword } from "./db.ts";
import { collectAnalytics, collectHost, collectMetrics } from "./metrics.ts";
import { capabilities, collectObservability, inspectRequest, listBuilds, listDrives, listFirewallEvents, listRules, listWorkflows, observedJa4, summarizeVitals, trafficSummary } from "./platform.ts";
import { approveDevice, clearProtection, createToken, gateCookie, identityProviders, listNotifications, listSessions, listTokens, listWebhooks, notify, pollDevice, protectionStatus, readGate, setProtection, startDevice, unlockProtection, userFromBearer } from "./identity.ts";
import { changesSince, publish, tx } from "./events.ts";
import { approveFromBrowser, approvePairing, closePairing, createPairing, expireStale, listDevices, markAwaitingApproval, publicPairing, readPairing, renameDevice, revokeDevice, scanPairing, secretMatches } from "./pairing.ts";
import { encodePairingTicket, renderPairingQr } from "./qr.ts";

const COOKIE = "mc_session";
const WEEK = 7 * 24 * 3600 * 1000;
const attempts = new Map<string, { n: number; reset: number }>();

/** Port the realtime gateway listens on; advertised through `GET /api/health`. */
function realtimePort(): number {
  const raw = Number(process.env.MOBILECLOUD_REALTIME_PORT ?? 3211);
  return Number.isFinite(raw) && raw > 0 ? raw : 3211;
}

type SessionUser = User & { password_hash?: string };

function json(body: unknown, status = 200, headers?: Headers) {
  const h = headers ?? new Headers();
  h.set("content-type", "application/json");
  h.set("cache-control", "no-store");
  return new Response(JSON.stringify(body), { status, headers: h });
}

function cookieHeader(token: string, maxAge: number) {
  return `${COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}`;
}

function readCookie(req: Request): string | null {
  const raw = req.headers.get("cookie") ?? "";
  const hit = raw.split(";").map((p) => p.trim()).find((p) => p.startsWith(`${COOKIE}=`));
  return hit ? decodeURIComponent(hit.slice(COOKIE.length + 1)) : null;
}

/** Sets the non-httpOnly CSRF cookie so browser JavaScript can echo it back. */
function csrfCookieHeader(token: string, maxAge: number) {
  return `${CSRF_COOKIE}=${token}; Path=/; SameSite=Lax; Max-Age=${maxAge}`;
}

/** Reads the CSRF token from the raw cookie header, mirroring `readCookie`. */
function csrfCookie(req: Request): string | null {
  const raw = req.headers.get("cookie") ?? "";
  const hit = raw.split(";").map((p) => p.trim()).find((p) => p.startsWith(`${CSRF_COOKIE}=`));
  return hit ? decodeURIComponent(hit.slice(CSRF_COOKIE.length + 1)) : null;
}

/** Constant-time string comparison over equal-length byte arrays. */
function timingSafeEq(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Origin-gated double-submit CSRF check. A cookie-authenticated state-changing
 * request that carries an `Origin` header came from a browser and must echo a
 * token matching both the `mc_csrf` cookie and the value stored on its session
 * row. Native clients (no `Origin`) and bearer-authenticated requests are exempt.
 */
function requireCsrf(req: Request, db: DatabaseSync): void {
  const method = req.method.toUpperCase();
  if (method !== "POST" && method !== "PUT" && method !== "PATCH" && method !== "DELETE") return;
  // Bearer tokens are never attached automatically by a browser: not CSRF-susceptible.
  if (req.headers.get("authorization")) return;
  // No Origin header: native clients, curl, and the test suite are exempt.
  if (!req.headers.get("origin")) return;

  const token = readCookie(req);
  const header = req.headers.get(CSRF_HEADER);
  const cookie = csrfCookie(req);
  const stored = token
    ? (db.prepare("SELECT csrf FROM sessions WHERE token_hash = ?").get(tokenHash(token)) as { csrf: string | null } | undefined)?.csrf ?? null
    : null;

  if (header && cookie && stored && timingSafeEq(header, cookie) && timingSafeEq(header, stored)) return;

  const error = new Error("Cross-site request blocked: the CSRF token is missing or invalid.");
  (error as Error & { status: number }).status = 403;
  throw error;
}

function userFromRequest(req: Request): User | null {
  const bearer = userFromBearer(openDb(), req.headers.get("authorization"));
  if (bearer) return bearer;
  const token = readCookie(req);
  if (!token) return null;
  const db = openDb();
  const row = db.prepare(
    `SELECT u.id, u.email, u.name, u.role, u.plan
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ?`,
  ).get(tokenHash(token), Date.now()) as User | undefined;
  if (row) {
    const agent = (req.headers.get("user-agent") ?? "unknown").slice(0, 180);
    db.prepare("UPDATE sessions SET user_agent = ? WHERE token_hash = ? AND (user_agent IS NULL OR user_agent = '')").run(agent, tokenHash(token));
  }
  return row ?? null;
}

function log(ownerId: string, level: "info" | "warn" | "error", source: string, message: string) {
  openDb().prepare(
    "INSERT INTO logs (id, owner_id, level, source, message, at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(newId(), ownerId, level, source, message, Date.now());
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

function clientIp(req: Request) {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
}

function limited(ip: string) {
  const now = Date.now();
  const row = attempts.get(ip);
  if (!row || row.reset < now) {
    attempts.set(ip, { n: 1, reset: now + 60_000 });
    return false;
  }
  row.n += 1;
  return row.n > 12;
}

function safeSlug(input: string, label: string) {
  const name = input.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "");
  if (!name || name.length > 48) throw new Error(`${label} must be 1-48 letters, numbers, or hyphens`);
  return name;
}

function requireUser(req: Request): User {
  const user = userFromRequest(req);
  if (!user) {
    const error = new Error("Sign in required");
    (error as Error & { status: number }).status = 401;
    throw error;
  }
  return user;
}

async function body(req: Request): Promise<Record<string, unknown>> {
  if (req.headers.get("content-length") === "0") return {};
  try {
    const value = await req.json();
    return value && typeof value === "object" ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function str(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * The control-plane origin a pairing QR code should send the phone back to.
 *
 * The browser is the only party that knows the address the phone can actually
 * reach (LAN IP, tunnel hostname, adb-reverse port), so it is taken from the
 * request the browser made rather than guessed from server configuration.
 */
function originOf(req: Request) {
  const origin = req.headers.get("origin");
  if (origin) return origin.replace(/\/+$/, "");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (host) return `${req.headers.get("x-forwarded-proto") ?? "http"}://${host}`;
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
      return "This QR code has already been used.";
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
  return /^(https:\/\/|http:\/\/|git@|ssh:\/\/)/.test(value);
}

const NO_REPO_NOTE = "Add a Git repository URL to this project before it can be built.";

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

/**
 * Sends a web deployment to the core engine and reports the honest outcome:
 * `queued` when the engine accepted it (HTTP 202), `blocked` with the engine's
 * own error text otherwise.
 */
async function runWebDeploy(
  project: { id: string; name: string },
  repoUrl: string,
): Promise<{ status: "queued" | "blocked"; note: string }> {
  const result = await dispatchDeploy({ project: project.name, cloneUrl: repoUrl, agentId: "web-dashboard" });
  if (result.ok) {
    return {
      status: "queued",
      note: `Queued on the core engine (${result.detail}); build logs stream from /logs/${project.name}.`,
    };
  }
  return { status: "blocked", note: result.detail };
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
    const statusCode = (error as { status?: number }).status ?? 400;
    status = statusCode;
    const message = error instanceof Error ? error.message : "Request failed";
    return json({ error: message }, statusCode);
  } finally {
    if (path !== "events") record(owner, `/${path}`, status, started, req);
  }
}

async function route(req: Request, parts: string[]): Promise<{ response: Response; status: number; owner: string | null }> {
  const method = req.method;
  const key = `${method} ${parts.join("/")}`;
  const db = openDb();

  if (key === "POST auth/signup" || key === "POST auth/login") {
    if (limited(clientIp(req))) return { response: json({ error: "Too many attempts" }, 429), status: 429, owner: null };
    const input = await body(req);
    const email = str(input.email).toLowerCase();
    const password = str(input.password);
    if (!email.includes("@") || password.length < 8) {
      return { response: json({ error: "Email and a password of at least 8 characters are required" }, 400), status: 400, owner: null };
    }
    if (key.endsWith("signup")) {
      const name = str(input.name);
      if (name.length < 1 || name.length > 80) return { response: json({ error: "Name is required" }, 400), status: 400, owner: null };
      const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
      if (existing) return { response: json({ error: "An account with that email already exists" }, 409), status: 409, owner: null };
      const id = newId();
      const count = db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number };
      tx(db, () => {
        db.prepare(
          "INSERT INTO users (id, email, name, password_hash, role, plan, created_at) VALUES (?, ?, ?, ?, ?, 'community', ?)",
        ).run(id, email, name, hashPassword(password), count.n === 0 ? "owner" : "member", Date.now());
        publish(db, id, "account.updated", id, { id, email, name, created: true });
      });
      log(id, "info", "auth", "account created");
      return issueSession(id, req);
    }
    const row = db.prepare("SELECT id, password_hash FROM users WHERE email = ?").get(email) as { id: string; password_hash: string } | undefined;
    if (!row || !verifyPassword(password, row.password_hash)) {
      return { response: json({ error: "Email or password is wrong" }, 401), status: 401, owner: null };
    }
    log(row.id, "info", "auth", "signed in");
    return issueSession(row.id, req);
  }

  if (key === "POST auth/device/code") {
    const started = startDevice(db);
    return { response: json(started), status: 200, owner: null };
  }
  if (key === "POST auth/device/token") {
    const result = pollDevice(db, str((await body(req)).deviceCode));
    const status = result.status === "approved" ? 200 : result.status === "expired" ? 400 : 202;
    return { response: json(result, status), status, owner: null };
  }

  // ---- QR device pairing: the scanning device's half ---------------------
  // The phone starts with no session, so these three calls are authorised by
  // possession of the 256-bit secret carried only inside the QR code. That is
  // deliberately not enough on its own to link a device: the account-scoped
  // browser approval (`POST device/pairing/{id}/approve`) is the other half,
  // and only the two together produce a credential.

  if (method === "POST" && parts[0] === "device" && parts[1] === "pairing" && parts[2] && parts[3] === "scan") {
    const input = await body(req);
    const secret = str(input.secret);
    if (!secret) return { response: json({ error: "A pairing secret is required" }, 400), status: 400, owner: null };
    const device = {
      name: str(input.name) || undefined,
      platform: str(input.platform) || undefined,
      appVersion: str(input.appVersion) || undefined,
    };
    const result = scanPairing(db, parts[2], secret, device, clientIp(req));
    if (!result.ok) {
      const status = result.reason === "unknown_session" || result.reason === "invalid_secret" ? 404 : 409;
      return { response: json({ error: pairingError(result.reason), reason: result.reason }, status), status, owner: null };
    }
    markAwaitingApproval(db, parts[2]);
    const scanned = readPairing(db, parts[2]) ?? result.row;
    // Fan out so the browser flips to the approval screen without polling.
    publish(db, scanned.owner_id, "device.pairing.scanned", scanned.id, publicPairing(scanned));
    if (scanned.status === "AWAITING_APPROVAL") {
      publish(db, scanned.owner_id, "device.pairing.approval_requested", scanned.id, publicPairing(scanned));
    }
    return { response: json({ pairing: publicPairing(scanned), duplicate: result.duplicate }), status: 200, owner: null };
  }

  if (method === "POST" && parts[0] === "device" && parts[1] === "pairing" && parts[2] && parts[3] === "status") {
    const row = readPairing(db, parts[2]);
    if (!row || !secretMatches(row, str((await body(req)).secret))) {
      return { response: json({ error: pairingError("unknown_session"), reason: "unknown_session" }, 404), status: 404, owner: null };
    }
    return { response: json({ pairing: publicPairing(row) }), status: 200, owner: null };
  }

  if (method === "POST" && parts[0] === "device" && parts[1] === "pairing" && parts[2] && parts[3] === "claim") {
    const input = await body(req);
    const row = readPairing(db, parts[2]);
    if (!row || !secretMatches(row, str(input.secret))) {
      return { response: json({ error: pairingError("unknown_session"), reason: "unknown_session" }, 404), status: 404, owner: null };
    }
    const device = {
      name: str(input.name) || undefined,
      platform: str(input.platform) || undefined,
      appVersion: str(input.appVersion) || undefined,
    };
    // One transaction: the session is consumed if and only if the device row
    // and its durable credential are both created.
    const claimed = tx(db, () => approvePairing(db, row, row.owner_id, device, clientIp(req)));
    if (!claimed.ok) {
      const status = claimed.reason === "not_approved" || claimed.reason === "race" ? 409 : 410;
      return { response: json({ error: pairingError(claimed.reason), reason: claimed.reason }, status), status, owner: null };
    }
    const pairing = publicPairing(claimed.row);
    publish(db, claimed.row.owner_id, "device.pairing.connected", claimed.row.id, pairing);
    publish(db, claimed.row.owner_id, "device.connected", claimed.device.id, {
      device_id: claimed.device.id,
      device_name: claimed.device.name,
      platform: claimed.device.platform,
      method: "qr",
    });
    log(claimed.row.owner_id, "info", "device", `linked ${claimed.device.name} (${claimed.device.platform}) with a QR code`);
    // The phone proved the 256-bit secret *and* the account owner approved it,
    // so this is now that account's device: sign it in. Issuing a session here
    // is what lets the app talk to the API and open the realtime socket
    // (which authenticates with the `mc_session` cookie) without a password
    // ever being typed on the phone. Called after the claim transaction so the
    // two transactions never nest.
    const headers = startSession(claimed.row.owner_id, req);
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
    const token = readCookie(req);
    if (token) {
      const hash = tokenHash(token);
      const row = db.prepare("SELECT id, user_id AS userId FROM sessions WHERE token_hash = ?").get(hash) as
        | { id: string | null; userId: string }
        | undefined;
      tx(db, () => {
        db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hash);
        if (row) publish(db, row.userId, "session.revoked", row.id ?? hash, { sessionId: row.id ?? hash, reason: "signed_out" });
      });
    }
    const headers = new Headers();
    headers.append("set-cookie", cookieHeader("", 0));
    return { response: json({ ok: true }, 200, headers), status: 200, owner: null };
  }

  if (key === "GET auth/me") {
    const user = userFromRequest(req);
    return { response: json({ user }), status: 200, owner: user?.id ?? null };
  }

  // Public service-identity probe. Lets a client confirm it found a MobileCloud
  // control plane before trusting the endpoint. No secrets, no auth required.
  // It also advertises where the realtime gateway lives so a client never has
  // to guess a port.
  if (key === "GET health") {
    return {
      response: json({
        service: "MobileCloud",
        apiVersion: 1,
        status: "ok",
        environment: process.env.NODE_ENV ?? "development",
        time: new Date().toISOString(),
        realtime: {
          transport: "websocket",
          path: "/api/realtime",
          port: realtimePort(),
          fallback: "/api/sync/changes",
          schemaVersion: 1,
        },
      }),
      status: 200,
      owner: null,
    };
  }

  const user = requireUser(req);
  const owner = user.id;
  requireCsrf(req, db);
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
    const cursor = Number.isFinite(rawCursor) && rawCursor > 0 ? Math.floor(rawCursor) : 0;
    const rawLimit = Number(params.get("limit") ?? 500);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(1000, Math.floor(rawLimit)) : 500;
    const page = changesSince(db, owner, cursor, limit);
    return { response: json({ ...page, account_id: owner }), status: 200, owner };
  }

  if (key === "GET overview") {
    return { response: json({
      user,
      projects: listProjects(owner),
      deployments: listDeployments(owner),
      domains: listDomains(owner),
      databases: listDatabases(owner),
      functions: listFunctions(owner),
      objects: listObjects(owner),
      logs: listLogs(owner),
      team: listTeam(owner),
      settings: listSettings(owner),
      metrics: collectMetrics(db, owner),
      host: collectHost(),
      billing: billing(user),
      firewall: { rules: listRules(db, owner), events: listFirewallEvents(db, owner), traffic: trafficSummary(db, owner) },
      observability: collectObservability(db, owner),
      vitals: summarizeVitals(db, owner),
      builds: listBuilds(db, owner),
      workflows: listWorkflows(db, owner),
      drives: listDrives(db, owner),
      capabilities: capabilities(),
      notifications: listNotifications(db, owner),
      sessions: listSessions(db, owner, readCookie(req) ? tokenHash(readCookie(req) as string) : null),
      tokens: listTokens(db, owner),
      webhooks: listWebhooks(db, owner),
      protection: protectionStatus(db, owner, readGate(req)),
      identity: identityProviders(),
    }), status: 200, owner };
  }

  if (key === "GET metrics") return { response: json(collectMetrics(db, owner)), status: 200, owner };
  if (key === "GET host") return { response: json(collectHost()), status: 200, owner };
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
      return { response: json({ error: "Repository URL must start with https://, http://, git@, or ssh://" }, 400), status: 400, owner };
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
      return { response: json({ error: "Repository URL must start with https://, http://, git@, or ssh://" }, 400), status: 400, owner };
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

    if (!builderEnabled()) {
      const note = "No build runner is configured. Set MOBILECLOUD_BUILDER_URL to a reachable builder.";
      recordDeployment(db, owner, project, "blocked", note);
      log(owner, "warn", "builder", `${project.name}: ${note}`);
      notify(db, owner, "deployment.blocked", "Deployment not built", `${project.name}: ${note}`);
      return { response: json({ ok: true, status: "blocked", note }), status: 201, owner };
    }

    const outcome = await runWebDeploy(project, repoUrl);
    recordDeployment(db, owner, project, outcome.status, outcome.note);
    log(owner, outcome.status === "queued" ? "info" : "error", "builder", `${project.name}: ${outcome.note}`);
    if (outcome.status === "blocked") notify(db, owner, "deployment.blocked", "Deployment not built", `${project.name}: ${outcome.note}`);
    return { response: json({ ok: true, status: outcome.status, note: outcome.note }), status: 201, owner };
  }

  if (method === "POST" && parts[0] === "deployments" && parts[2] === "rollback") {
    const deployment = db.prepare(
      `SELECT d.id, d.project_id AS projectId, p.name AS project
       FROM deployments d JOIN projects p ON p.id = d.project_id
       WHERE d.owner_id = ? AND d.id = ?`,
    ).get(owner, parts[1]) as { id: string; projectId: string; project: string } | undefined;
    if (!deployment) return { response: json({ error: "Deployment not found" }, 404), status: 404, owner };
    const deployId = str((await body(req)).deployId);
    if (!deployId) return { response: json({ error: "deployId is required" }, 400), status: 400, owner };

    const result = await dispatchRollback({ project: deployment.project, deployId });
    const note = result.ok ? `Rolled back to ${deployId} on the core engine.` : result.detail;
    const outcome = result.ok ? "rolled_back" : "failed";
    recordDeployment(db, owner, { id: deployment.projectId, name: deployment.project }, outcome, note);
    log(owner, result.ok ? "info" : "error", "builder", `${deployment.project}: ${note}`);
    return { response: json({ ok: result.ok, status: outcome, note }), status: result.ok ? 200 : 502, owner };
  }

  if (key === "GET builder") {
    const probe = await probeBuilder();
    return {
      response: json({ enabled: builderEnabled(), baseUrl: probe.baseUrl, reachable: probe.reachable, detail: probe.detail }),
      status: 200,
      owner,
    };
  }
  if (method === "GET" && parts[0] === "builder" && parts[1] === "deployments" && parts[2]) {
    const project = db.prepare("SELECT id, name FROM projects WHERE owner_id = ? AND (id = ? OR name = ?)")
      .get(owner, parts[2], parts[2]) as { id: string; name: string } | undefined;
    if (!project) return { response: json({ error: "Project not found" }, 404), status: 404, owner };
    const result = await fetchEngineDeployments(project.name);
    if (!result.ok) return { response: json({ error: result.detail }, 502), status: 502, owner };
    return { response: json(result.body), status: 200, owner };
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
    const input = await body(req);
    const bucket = safeSlug(str(input.bucket), "Bucket");
    const keyName = str(input.key).replace(/\\/g, "/");
    if (!keyName || keyName.includes("..") || keyName.startsWith("/")) {
      return { response: json({ error: "Object key is invalid" }, 400), status: 400, owner };
    }
    const bytes = Buffer.from(str(input.contentBase64), "base64");
    if (!str(input.contentBase64) || bytes.length > 1_000_000) {
      return { response: json({ error: "Provide base64 content up to 1 MB" }, 400), status: 400, owner };
    }
    const dir = join(dataRoot(), "objects", owner, bucket);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, keyName.replace(/\//g, "__"));
    writeFileSync(file, bytes);
    const size = statSync(file).size;
    const id = newId();
    tx(db, () => {
      db.prepare(
        "INSERT INTO objects (id, owner_id, bucket, key, path, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(id, owner, bucket, keyName, file, size, Date.now());
      publish(db, owner, "configuration.updated", id, { resource: "object", id, bucket, key: keyName, bytes: size });
    });
    log(owner, "info", "storage", `wrote ${bucket}/${keyName} (${size} bytes)`);
    return { response: json({ ok: true, bytes: size }), status: 201, owner };
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
    if (![7, 30, 90, 0].includes(days)) return { response: json({ error: "Expiry must be 7, 30, 90, or 0 for no expiry" }, 400), status: 400, owner };
    const issued = createToken(db, owner, name, days);
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
    if (!approveDevice(db, owner, code)) return { response: json({ error: "Code is unknown, expired, or already used" }, 404), status: 404, owner };
    publish(db, owner, "configuration.updated", code.toUpperCase(), { resource: "device", code: code.toUpperCase(), approved: true });
    notify(db, owner, "auth.device", "Device approved", `Approved device code ${code.toUpperCase()}`);
    return { response: json({ ok: true }), status: 200, owner };
  }

  // ---- QR device pairing: the signed-in browser's half -------------------

  // Starts a pairing session and returns the rendered QR. Any session this
  // account already had open is superseded, so a screenshot of an old code can
  // never be reused.
  if (key === "POST device/pairing") {
    const input = await body(req);
    const created = createPairing(db, owner, {
      name: str(input.name) || undefined,
      platform: str(input.platform) || undefined,
      userAgent: req.headers.get("user-agent") ?? undefined,
      ip: clientIp(req),
    });
    const row = readPairing(db, created.id);
    if (!row) return { response: json({ error: "Could not start a pairing session" }, 500), status: 500, owner };
    const payload = encodePairingTicket({
      api: originOf(req),
      id: created.id,
      secret: created.secret,
      code: created.verificationCode,
    });
    const qr = await renderPairingQr(payload);
    publish(db, owner, "device.pairing.created", created.id, publicPairing(row));
    log(owner, "info", "device", "started a QR pairing session");
    // The secret and the PNG are returned once, to the browser that asked for
    // them. It is the only moment the secret exists outside the QR image.
    return { response: json({ pairing: publicPairing(row), payload, qr_data_url: qr }), status: 201, owner };
  }

  // The browser polls this while the QR is on screen.
  if (method === "GET" && parts[0] === "device" && parts[1] === "pairing" && parts[2]) {
    for (const stale of expireStale(db)) {
      publish(db, stale.owner_id, "device.pairing.expired", stale.id, { pairing_id: stale.id, status: "EXPIRED" });
    }
    const row = readPairing(db, parts[2]);
    if (!row || row.owner_id !== owner) return { response: json({ error: "Pairing session not found" }, 404), status: 404, owner };
    return { response: json({ pairing: publicPairing(row) }), status: 200, owner };
  }

  // Approve a scanned device. Only the session's own account can approve, and
  // only after a device has actually scanned the code.
  if (method === "POST" && parts[0] === "device" && parts[1] === "pairing" && parts[2] && parts[3] === "approve") {
    const row = readPairing(db, parts[2]);
    if (!row || row.owner_id !== owner) return { response: json({ error: "Pairing session not found" }, 404), status: 404, owner };
    if (!approveFromBrowser(db, parts[2], owner)) {
      return { response: json({ error: pairingError("not_approved"), reason: "not_approved" }, 409), status: 409, owner };
    }
    const approved = readPairing(db, parts[2]) ?? row;
    publish(db, owner, "device.pairing.approved", parts[2], publicPairing(approved));
    notify(db, owner, "auth.device", "Device approved", `Approved ${approved.scan_device_name ?? "a device"} over QR`);
    log(owner, "info", "device", `approved QR pairing for ${approved.scan_device_name ?? "a device"}`);
    return { response: json({ pairing: publicPairing(approved) }), status: 200, owner };
  }

  // Cancel (or deny) an open pairing, from any non-terminal state.
  if (method === "DELETE" && parts[0] === "device" && parts[1] === "pairing" && parts[2]) {
    const row = readPairing(db, parts[2]);
    if (!row || row.owner_id !== owner) return { response: json({ error: "Pairing session not found" }, 404), status: 404, owner };
    if (closePairing(db, parts[2], "cancelled")) {
      publish(db, owner, "device.pairing.revoked", parts[2], { pairing_id: parts[2], reason: "cancelled" });
    }
    return { response: json({ ok: true }), status: 200, owner };
  }

  if (key === "GET devices") {
    return { response: json({ devices: listDevices(db, owner) }), status: 200, owner };
  }

  if (method === "PATCH" && parts[0] === "devices" && parts[1]) {
    const name = str((await body(req)).name);
    if (!name) return { response: json({ error: "A device name is required" }, 400), status: 400, owner };
    if (!renameDevice(db, owner, parts[1], name)) return { response: json({ error: "Device not found" }, 404), status: 404, owner };
    publish(db, owner, "device.updated", parts[1], { device_id: parts[1], name });
    return { response: json({ ok: true }), status: 200, owner };
  }

  if (method === "DELETE" && parts[0] === "devices" && parts[1]) {
    const revoked = revokeDevice(db, owner, parts[1]);
    if (!revoked.ok) return { response: json({ error: "Device not found" }, 404), status: 404, owner };
    publish(db, owner, "device.disconnected", parts[1], { device_id: parts[1], name: revoked.device?.name ?? null, reason: "revoked" });
    log(owner, "info", "device", `revoked ${revoked.device?.name ?? "a device"}`);
    return { response: json({ ok: true }), status: 200, owner };
  }

  if (key === "POST protection") {
    const password = String((await body(req)).password ?? "");
    if (password.length < 8) return { response: json({ error: "Password must be at least 8 characters" }, 400), status: 400, owner };
    const gate = setProtection(db, owner, password);
    publish(db, owner, "configuration.updated", owner, { resource: "protection", required: true });
    const headers = new Headers();
    headers.append("set-cookie", gateCookie(gate, WEEK / 1000));
    return { response: json({ ok: true }, 200, headers), status: 200, owner };
  }

  if (key === "POST protection/unlock") {
    const gate = unlockProtection(db, owner, String((await body(req)).password ?? ""));
    if (!gate) return { response: json({ error: "Password does not match" }, 401), status: 401, owner };
    const headers = new Headers();
    headers.append("set-cookie", gateCookie(gate, WEEK / 1000));
    return { response: json({ ok: true }, 200, headers), status: 200, owner };
  }

  if (key === "DELETE protection") {
    clearProtection(db, owner);
    publish(db, owner, "configuration.updated", owner, { resource: "protection", required: false });
    const headers = new Headers();
    headers.append("set-cookie", gateCookie("", 0));
    return { response: json({ ok: true }, 200, headers), status: 200, owner };
  }

  if (key === "POST webhooks") {
    const input = await body(req);
    const url = str(input.url);
    if (!/^https?:\/\//.test(url)) return { response: json({ error: "Enter an http or https URL" }, 400), status: 400, owner };
    const secret = randomBytes(16).toString("hex");
    const id = newId();
    tx(db, () => {
      db.prepare("INSERT INTO webhooks (id, owner_id, url, secret, events, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
        id, owner, url, secret, "deployment.blocked,firewall.denied,auth.session,auth.device", Date.now(),
      );
      publish(db, owner, "configuration.updated", id, { resource: "webhook", id, url });
    });
    return { response: json({ secret }, 201), status: 201, owner };
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
    const result = db.prepare("UPDATE notifications SET read = 1 WHERE owner_id = ? AND id = ?").run(owner, parts[1]);
    if (Number(result.changes) === 0) return { response: json({ error: "Notification not found" }, 404), status: 404, owner };
    publish(db, owner, "notification.read", parts[1], { id: parts[1], read: true });
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

    const repoUrl = project.repoUrl || "";
    if (!repoUrl || !builderEnabled()) {
      const note = repoUrl
        ? "No build runner is configured. Set MOBILECLOUD_BUILDER_URL to a reachable builder."
        : NO_REPO_NOTE;
      recordBuild(db, owner, project, target, "blocked", note);
      log(owner, "warn", "builds", `${project.name} ${target}: ${note}`);
      return { response: json({ ok: true, status: "blocked", note }), status: 201, owner };
    }

    const outcome = await runWebDeploy(project, repoUrl);
    recordBuild(db, owner, project, target, outcome.status, outcome.note);
    recordDeployment(db, owner, project, outcome.status, outcome.note);
    log(owner, outcome.status === "queued" ? "info" : "error", "builds", `${project.name} ${target}: ${outcome.note}`);
    if (outcome.status === "blocked") notify(db, owner, "deployment.blocked", "Deployment not built", `${project.name}: ${outcome.note}`);
    return { response: json({ ok: true, status: outcome.status, note: outcome.note }), status: 201, owner };
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
      const m = collectMetrics(db, owner);
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
 * Creates a session row and returns the `Set-Cookie` headers for it. Callers
 * must not already hold a write transaction: this opens its own.
 */
function startSession(userId: string, req: Request): Headers {
  const token = randomBytes(32).toString("hex");
  const csrf = randomBytes(32).toString("hex");
  const agent = (req.headers.get("user-agent") ?? "unknown").slice(0, 180);
  const sessionId = newId();
  const db = openDb();
  tx(db, () => {
    db.prepare(
      "INSERT INTO sessions (id, token_hash, user_id, expires_at, user_agent, created_at, csrf) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(sessionId, tokenHash(token), userId, Date.now() + WEEK, agent, Date.now(), csrf);
    // Other signed-in devices learn about the new session in real time.
    publish(db, userId, "session.created", sessionId, { sessionId, userAgent: agent });
  });
  notify(db, userId, "auth.session", "New session", agent);
  const headers = new Headers();
  headers.append("set-cookie", cookieHeader(token, WEEK / 1000));
  headers.append("set-cookie", csrfCookieHeader(csrf, WEEK / 1000));
  return headers;
}

function issueSession(userId: string, req: Request) {
  const headers = startSession(userId, req);
  const user = openDb().prepare("SELECT id, email, name, role, plan FROM users WHERE id = ?").get(userId);
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
