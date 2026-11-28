import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { handle } from "./api.ts";
import { hashPassword, newId, openDb, tokenHash } from "./db.ts";

const root = mkdtempSync(join(tmpdir(), "mc-api-"));
process.env.MOBILECLOUD_DB = join(root, "t.db");
process.env.MOBILECLOUD_DATA_ROOT = root;
process.env.MOBILECLOUD_BOOTSTRAP_EMAIL = "operator@example.test";
process.env.MOBILECLOUD_BOOTSTRAP_PASSWORD = "test-operator-password";
process.env.MOBILECLOUD_PUBLIC_ORIGIN = "https://console.example.test";

const origin = process.env.MOBILECLOUD_PUBLIC_ORIGIN;
const credentials = { email: process.env.MOBILECLOUD_BOOTSTRAP_EMAIL, password: process.env.MOBILECLOUD_BOOTSTRAP_PASSWORD };

function request(path: string, method = "GET", body?: object, headers?: HeadersInit) {
  const all = new Headers(headers);
  if (body) all.set("content-type", "application/json");
  return handle(new Request(`${origin}/api/${path}`, { method, headers: all, body: body && JSON.stringify(body) }), path.split("/"));
}

async function login() {
  const response = await request("auth/login", "POST", credentials, { origin });
  assert.equal(response.status, 200);
  const cookies = response.headers.getSetCookie();
  assert.equal(cookies.length, 2);
  assert.ok(cookies.every((cookie) => cookie.includes("; Secure")));
  const cookie = cookies.find((value) => value.startsWith("mc_session="))!.split(";")[0];
  // Native flow can send the token from auth/me even without a CSRF cookie.
  const me = await request("auth/me", "GET", undefined, { cookie });
  const { user, csrfToken } = await me.json();
  assert.ok(user);
  assert.match(csrfToken, /^[a-f0-9]{64}$/);
  return { cookie, "x-mc-csrf": csrfToken as string, userId: user.id as string };
}

async function loginAs(email: string, password: string) {
  const response = await request("auth/login", "POST", { email, password }, { origin });
  assert.equal(response.status, 200);
  const cookie = response.headers.getSetCookie().find((value) => value.startsWith("mc_session="))!.split(";")[0];
  const { user, csrfToken } = await (await request("auth/me", "GET", undefined, { cookie })).json();
  return { cookie, "x-mc-csrf": csrfToken as string, userId: user.id as string, role: user.role as string };
}

test("public signup is disabled while operator provisioning and HTTPS discovery work", async () => {
  const blocked = await request("auth/signup", "POST", { email: "new@example.test", password: "test-only-example" });
  assert.equal(blocked.status, 403);
  const { userId } = await login();
  assert.ok(userId);
  const count = openDb().prepare("SELECT COUNT(*) AS n FROM users").get();
  assert.equal(count?.n, 1);
  const { realtime } = await (await request("health")).json();
  assert.equal(realtime.path, "/api/realtime");
  assert.equal(realtime.url, "wss://console.example.test/api/realtime");
  assert.ok(realtime.port > 0);
});

test("only the actual credential authorizes writes, and logout clears CSRF and revokes the session", async () => {
  const { userId, ...auth } = await login();
  const input = { name: "New name" };
  assert.equal((await request("profile", "POST", input, { cookie: auth.cookie })).status, 403);
  assert.equal((await request("profile", "POST", input, { ...auth, origin: "https://other.example.test" })).status, 403);
  assert.equal((await request("profile", "POST", input, { ...auth, authorization: "Bearer invalid" })).status, 401);
  assert.equal((await request("profile", "POST", input, auth)).status, 200);
  assert.equal((await request("auth/logout", "POST", undefined, { cookie: auth.cookie })).status, 403);
  const logout = await request("auth/logout", "POST", undefined, auth);
  assert.equal(logout.status, 200);
  for (const name of ["mc_session", "mc_csrf"]) assert.ok(logout.headers.getSetCookie().some((cookie) => cookie.startsWith(`${name}=`) && cookie.includes("Max-Age=0")));
  assert.equal((await request("overview", "GET", undefined, auth)).status, 401);
});

test("cross-origin login and non-JSON login do not establish sessions", async () => {
  const crossOrigin = await request("auth/login", "POST", credentials, { origin: "https://other.example.test" });
  assert.equal(crossOrigin.status, 403);
  assert.equal(crossOrigin.headers.getSetCookie().length, 0);
  const wrongType = await handle(new Request(`${origin}/api/auth/login`, { method: "POST", body: "test", headers: { origin } }), ["auth", "login"]);
  assert.equal(wrongType.status, 415);
});

test("only development permits default loopback browser origins", async (t) => {
  const env: Record<string, string | undefined> = process.env;
  const keys = ["NODE_ENV", "MOBILECLOUD_PUBLIC_ORIGIN", "PORT"];
  const previous = keys.map((key) => env[key]);
  t.after(() => keys.forEach((key, index) => {
    if (previous[index] === undefined) delete env[key]; else env[key] = previous[index];
  }));
  const loginFrom = (origin?: string, site?: string) => {
    const headers = new Headers({ "content-type": "application/json" });
    if (origin) headers.set("origin", origin);
    if (site) headers.set("sec-fetch-site", site);
    return handle(new Request("http://127.0.0.1:3210/api/auth/login", {
      method: "POST", headers, body: JSON.stringify(credentials),
    }), ["auth", "login"]);
  };
  delete env.MOBILECLOUD_PUBLIC_ORIGIN;
  env.PORT = "3210";
  env.NODE_ENV = "development";
  assert.equal((await loginFrom("http://localhost:3210")).status, 200);
  assert.equal((await loginFrom("http://localhost:3210", "cross-site")).status, 403);
  assert.equal((await loginFrom("http://localhost:3211")).status, 403);
  env.MOBILECLOUD_PUBLIC_ORIGIN = "not-an-origin";
  assert.equal((await loginFrom("http://localhost:3210")).status, 403);
  delete env.MOBILECLOUD_PUBLIC_ORIGIN;
  env.NODE_ENV = "production";
  assert.equal((await loginFrom("http://127.0.0.1:3210")).status, 403);
  const native = await loginFrom();
  assert.equal(native.status, 200);
  const cookies = native.headers.getSetCookie();
  assert.equal(cookies.length, 2);
  assert.ok(cookies.every((cookie) => cookie.includes("; Secure")));
});

test("a configured engine is never used: builds run locally, deployments stay blocked", async (t) => {
  const original = process.env.MOBILECLOUD_BUILDER_URL;
  process.env.MOBILECLOUD_BUILDER_URL = "http://127.0.0.1:1";
  t.after(() => { if (original === undefined) delete process.env.MOBILECLOUD_BUILDER_URL; else process.env.MOBILECLOUD_BUILDER_URL = original; });
  const { userId, ...auth } = await login();
  const created = await request("projects", "POST", { name: "ledger", framework: "Next.js", repoUrl: "https://github.com/acme/ledger.git" }, auth);
  assert.equal(created.status, 201);
  const { id } = await created.json();
  // A build is accepted and runs on the console host's own trusted targets; the
  // engine is not contacted, so a configured engine URL changes nothing here.
  const build = await request("builds", "POST", { projectId: id, target: "web" }, auth);
  assert.equal(build.status, 202);
  assert.ok((await build.json()).buildId);
  // Deployment dispatch stays blocked until isolated workers and authorized
  // management exist.
  const deploy = await request("deployments", "POST", { projectId: id, target: "web" }, auth);
  assert.equal(deploy.status, 403);
  assert.equal((await deploy.json()).status, "blocked");
  const info = await (await request("builder", "GET", undefined, auth)).json();
  assert.equal(info.enabled, false);
  assert.equal(info.reachable, false);
  assert.equal((await request(`builder/deployments/${id}`, "GET", undefined, auth)).status, 503);
  assert.equal((await request(`deployments/${id}/rollback`, "POST", { deployId: "old" }, auth)).status, 503);
});

test("access tokens are hashed, time limited and read-only; device codes redeem once", async () => {
  const { userId, ...auth } = await login();
  assert.equal((await request("tokens", "POST", { name: "old", days: 0 }, auth)).status, 400);
  const created = await request("tokens", "POST", { name: "ci", days: 7 }, auth);
  assert.equal(created.status, 201);
  const { token } = await created.json();
  assert.match(token, /^mc_/);
  const stored = openDb().prepare("SELECT token_hash FROM access_tokens WHERE token_hash = ?").get(tokenHash(token));
  assert.equal(stored?.token_hash, tokenHash(token));
  const bearer = { authorization: `Bearer ${token}` };
  assert.equal((await (await request("auth/me", "GET", undefined, bearer)).json()).user.id, userId);
  assert.equal((await request("profile", "POST", { name: "No" }, bearer)).status, 403);

  const codes = await (await request("auth/device/code", "POST")).json();
  const redeem = () => request("auth/device/token", "POST", { deviceCode: codes.deviceCode });
  assert.equal((await redeem()).status, 202);
  assert.equal((await request("device/approve", "POST", { userCode: codes.userCode }, auth)).status, 200);
  const results = await Promise.all([redeem(), redeem()]);
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 400]);
});

test("JA4 rules match only well-formed input", async () => {
  const { userId, ...auth } = await login();
  const digest = "t13d1516h2_8daaf6152771_02713d6af862";
  const rule = await request("firewall", "POST", { name: "ja4", action: "deny", matchKey: "ja4", matchOp: "equals", matchValue: digest }, auth);
  assert.equal(rule.status, 201);
  const probe = (ja4: string) => request("team", "POST", { name: "", email: "" }, { ...auth, "x-ja4-fingerprint": ja4 });
  assert.equal((await probe(digest)).status, 403);
  assert.equal((await probe("not-a-digest")).status, 400);
});

test("storage keeps distinct object keys in distinct opaque files", async () => {
  const { userId, ...auth } = await login();
  const upload = (key: string, content: string) => request("storage", "POST", { bucket: "test", key, contentBase64: Buffer.from(content).toString("base64") }, auth);
  assert.equal((await upload("a/b", "first")).status, 201);
  assert.equal((await upload("a__b", "second")).status, 201);
  assert.equal((await upload("a/b", "replacement")).status, 409);
  const paths = openDb().prepare("SELECT path FROM objects WHERE owner_id = ? ORDER BY key").all(userId);
  assert.deepEqual(paths.map((row) => readFileSync(String(row.path), "utf8")), ["first", "second"]);
});

test("the role matrix keeps viewers read-only and reserves team management for owners", async () => {
  const db = openDb();
  const viewerPassword = "viewer-password-example";
  db.prepare("INSERT INTO users (id, email, name, password_hash, role, plan, created_at) VALUES (?, ?, ?, ?, 'viewer', 'community', ?)")
    .run(newId(), "viewer@example.test", "Viewer", hashPassword(viewerPassword), Date.now());
  const viewer = await loginAs("viewer@example.test", viewerPassword);
  assert.equal(viewer.role, "viewer");
  // A viewer reads and may still edit its own profile.
  assert.equal((await request("overview", "GET", undefined, viewer)).status, 200);
  assert.equal((await request("profile", "POST", { name: "Renamed viewer" }, viewer)).status, 200);
  // Account resources and admin surfaces are refused.
  assert.equal((await request("projects", "POST", { name: "nope", framework: "Next.js" }, viewer)).status, 403);
  assert.equal((await request("team", "POST", { name: "x", email: "x@example.test" }, viewer)).status, 403);
  assert.equal((await request("admin/apps", "POST", { name: "x" }, viewer)).status, 403);

  // Only an owner manages team roles.
  const owner = await login();
  assert.equal((await request("team", "POST", { name: "Owner invite", email: "o@example.test", role: "owner" }, owner)).status, 400);
  assert.equal((await request("team", "POST", { name: "Bad role", email: "b@example.test", role: "root" }, owner)).status, 400);
  const invite = await request("team", "POST", { name: "Dev", email: "dev@example.test", role: "viewer" }, owner);
  assert.equal(invite.status, 201);
  assert.equal((await invite.json()).role, "viewer");
  const inviteId = String((db.prepare("SELECT id FROM invites WHERE owner_id = ?").get(owner.userId) as { id: string }).id);
  assert.equal((await request(`team/${inviteId}`, "PATCH", { role: "member" }, owner)).status, 200);
  assert.equal((await request(`team/${inviteId}`, "PATCH", { role: "owner" }, owner)).status, 400);
  // The last owner cannot be demoted or removed.
  assert.equal((await request(`team/${owner.userId}`, "PATCH", { role: "viewer" }, owner)).status, 400);
  assert.equal((await request(`team/${owner.userId}`, "DELETE", undefined, owner)).status, 400);
  assert.equal((await request(`team/${inviteId}`, "DELETE", undefined, owner)).status, 200);
});

test("a fully configured engine receives the dispatch with its bearer token", async (t) => {
  const engineRequests: { url?: string; auth?: string; body: Record<string, unknown> }[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      if (req.url === "/healthz") { res.writeHead(200); res.end("ok"); return; }
      const body = JSON.parse(raw || "{}") as Record<string, unknown>;
      engineRequests.push({ url: req.url, auth: req.headers.authorization, body });
      // The engine is the authority and refuses projects it was not configured for.
      if (body.project === "engine-demo") { res.writeHead(202, { "content-type": "application/json" }); res.end(JSON.stringify({ status: "queued" })); return; }
      res.writeHead(403, { "content-type": "text/plain" }); res.end("unknown preview project");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const previous = { url: process.env.MOBILECLOUD_BUILDER_URL, token: process.env.MOBILECLOUD_BUILDER_TOKEN };
  process.env.MOBILECLOUD_BUILDER_URL = `http://127.0.0.1:${port}`;
  process.env.MOBILECLOUD_BUILDER_TOKEN = "engine-shared-secret";
  t.after(() => {
    server.close();
    if (previous.url === undefined) delete process.env.MOBILECLOUD_BUILDER_URL; else process.env.MOBILECLOUD_BUILDER_URL = previous.url;
    if (previous.token === undefined) delete process.env.MOBILECLOUD_BUILDER_TOKEN; else process.env.MOBILECLOUD_BUILDER_TOKEN = previous.token;
  });

  const { userId, ...auth } = await login();
  const info = await (await request("builder", "GET", undefined, auth)).json();
  assert.equal(info.enabled, true);
  assert.equal(info.reachable, true);
  assert.equal(info.baseUrl, `http://127.0.0.1:${port}`);

  const ok = await request("projects", "POST", { name: "engine-demo", framework: "Next.js", repoUrl: "https://github.com/acme/demo.git" }, auth);
  assert.equal(ok.status, 201);
  const demo = await ok.json();
  const queued = await request("deployments", "POST", { projectId: demo.id }, auth);
  assert.equal(queued.status, 202);
  assert.equal((await queued.json()).status, "queued");

  const refused = await request("projects", "POST", { name: "engine-refused", framework: "Next.js", repoUrl: "https://github.com/acme/other.git" }, auth);
  const other = await refused.json();
  const failed = await request("deployments", "POST", { projectId: other.id }, auth);
  assert.equal(failed.status, 502);
  assert.equal((await failed.json()).status, "failed");

  assert.equal(engineRequests.length, 2);
  assert.equal(engineRequests[0].url, "/api/v1/deploy/agent");
  assert.equal(engineRequests[0].auth, "Bearer engine-shared-secret");
  assert.deepEqual(engineRequests[0].body, { project: "engine-demo", clone_url: "https://github.com/acme/demo.git", branch: "main", agent_id: "dashboard" });
  const recorded = openDb().prepare("SELECT status FROM deployments WHERE owner_id = ? AND project_id IN (?, ?)").all(userId, demo.id, other.id) as { status: string }[];
  assert.deepEqual(recorded.map((row) => row.status).sort(), ["failed", "queued"]);
});

test("the domain lifecycle keeps its three signals honest until DNS actually verifies", async () => {
  const { userId, ...auth } = await login();
  assert.ok(userId);
  const project = await request("projects", "POST", { name: "furlpay-web", framework: "Next.js", repoUrl: "https://github.com/acme/furlpay.git" }, auth);
  assert.equal(project.status, 201);

  // A reserved hostname is refused with a message, before anything is stored.
  const bad = await request("domains", "POST", { host: "localhost", project: "furlpay-web" }, auth);
  assert.equal(bad.status, 400);

  const added = await request("domains", "POST", { host: "app.furlpay-example.com", project: "furlpay-web" }, auth);
  assert.equal(added.status, 201);
  const { domain } = await added.json();
  assert.equal(domain.status, "pending_dns");
  assert.equal(domain.dnsStatus, "pending");
  assert.equal(domain.sslStatus, "none");
  assert.equal(domain.healthStatus, "unknown");
  assert.equal(domain.verificationMethod, "cname");
  assert.equal(domain.sslExpiresAt, null);

  const list = await (await request("domains", "GET", undefined, auth)).json();
  assert.ok(list.domains.some((row: { id: string }) => row.id === domain.id));

  // With no published tunnel target the CNAME check cannot verify anything, so
  // the status must stay pending — never upgraded on a signal that did not pass.
  const verified = await request(`domains/${domain.id}/verify`, "POST", undefined, auth);
  assert.equal(verified.status, 200);
  const afterVerify = (await verified.json()).domain;
  assert.equal(afterVerify.dnsStatus, "pending");
  assert.equal(afterVerify.status, "pending_dns");

  const updated = await request(`domains/${domain.id}`, "PUT", { verificationMethod: "txt" }, auth);
  assert.equal(updated.status, 200);
  assert.equal((await updated.json()).domain.verificationMethod, "txt");

  assert.equal((await request(`domains/${domain.id}`, "DELETE", undefined, auth)).status, 200);
  const remaining = await (await request("domains", "GET", undefined, auth)).json();
  assert.ok(!remaining.domains.some((row: { id: string }) => row.id === domain.id));
});
