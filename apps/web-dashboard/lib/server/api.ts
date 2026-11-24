import { randomBytes } from "node:crypto";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RangeKey, User } from "../types.ts";
import { dataRoot, hashPassword, newId, openDb, tokenHash, verifyPassword } from "./db.ts";
import { collectAnalytics, collectHost, collectMetrics } from "./metrics.ts";
import { capabilities, collectObservability, inspectRequest, listBuilds, listDrives, listFirewallEvents, listRules, listWorkflows, observedJa4, summarizeVitals, trafficSummary } from "./platform.ts";
import { approveDevice, clearProtection, createToken, gateCookie, identityProviders, listNotifications, listSessions, listTokens, listWebhooks, notify, pollDevice, protectionStatus, readGate, setProtection, startDevice, unlockProtection, userFromBearer } from "./identity.ts";
import { changesSince, publish, tx } from "./events.ts";

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
    const id = newId();
    tx(db, () => {
      db.prepare(
        "INSERT INTO projects (id, owner_id, name, framework, target, created_at) VALUES (?, ?, ?, ?, 'production', ?)",
      ).run(id, owner, name, framework, Date.now());
      publish(db, owner, "project.created", id, { id, name, framework, target: "production" });
    });
    log(owner, "info", "projects", `created ${name}`);
    return { response: json({ ok: true, id }), status: 201, owner };
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
    const project = db.prepare("SELECT id, name FROM projects WHERE owner_id = ? AND id = ?").get(owner, str(input.projectId)) as { id: string; name: string } | undefined;
    if (!project) return { response: json({ error: "Project not found" }, 404), status: 404, owner };
    const builder = process.env.MOBILECLOUD_BUILDER_URL;
    const note = builder
      ? "A builder URL is set, but this server does not dispatch builds yet."
      : "No build runner is configured. Set MOBILECLOUD_BUILDER_URL to a reachable builder.";
    const id = newId();
    tx(db, () => {
      db.prepare(
        "INSERT INTO deployments (id, owner_id, project_id, status, note, created_at) VALUES (?, ?, ?, 'blocked', ?, ?)",
      ).run(id, owner, project.id, note, Date.now());
      publish(db, owner, "deployment.updated", id, {
        id, projectId: project.id, project: project.name, status: "blocked", note,
      });
    });
    log(owner, "warn", "builder", `${project.name}: ${note}`);
    notify(db, owner, "deployment.blocked", "Deployment not built", `${project.name}: ${note}`);
    return { response: json({ ok: true, status: "blocked", note }), status: 201, owner };
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
    const project = db.prepare("SELECT id, name FROM projects WHERE owner_id = ? AND id = ?").get(owner, str(input.projectId)) as { id: string; name: string } | undefined;
    if (!project) return { response: json({ error: "Project not found" }, 404), status: 404, owner };
    const note = target === "android"
      ? "No bare-metal ARM64 runner, Gradle snapshot, or Android SDK is configured. The build was not started."
      : "No web build runner is configured. The build was not started.";
    const id = newId();
    tx(db, () => {
      db.prepare(
        "INSERT INTO builds (id, owner_id, project_id, target, status, note, created_at) VALUES (?, ?, ?, ?, 'blocked', ?, ?)",
      ).run(id, owner, project.id, target, note, Date.now());
      publish(db, owner, "build.updated", id, { id, projectId: project.id, project: project.name, target, status: "blocked", note });
    });
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

function issueSession(userId: string, req: Request) {
  const token = randomBytes(32).toString("hex");
  const agent = (req.headers.get("user-agent") ?? "unknown").slice(0, 180);
  const sessionId = newId();
  const db = openDb();
  tx(db, () => {
    db.prepare(
      "INSERT INTO sessions (id, token_hash, user_id, expires_at, user_agent, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(sessionId, tokenHash(token), userId, Date.now() + WEEK, agent, Date.now());
    // Other signed-in devices learn about the new session in real time.
    publish(db, userId, "session.created", sessionId, { sessionId, userAgent: agent });
  });
  notify(db, userId, "auth.session", "New session", agent);
  const headers = new Headers();
  headers.append("set-cookie", cookieHeader(token, WEEK / 1000));
  const user = db.prepare("SELECT id, email, name, role, plan FROM users WHERE id = ?").get(userId);
  return { response: json({ user }, 200, headers), status: 200, owner: userId };
}

function listProjects(owner: string) {
  return openDb().prepare(
    "SELECT id, name, framework, target, created_at AS createdAt FROM projects WHERE owner_id = ? ORDER BY created_at DESC",
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
