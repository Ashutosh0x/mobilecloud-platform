import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { handle } from "./api.ts";
import { openDb, tokenHash } from "./db.ts";

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

test("configured engine remains disabled for builds, deployments and management", async (t) => {
  const original = process.env.MOBILECLOUD_BUILDER_URL;
  process.env.MOBILECLOUD_BUILDER_URL = "http://127.0.0.1:1";
  t.after(() => { if (original === undefined) delete process.env.MOBILECLOUD_BUILDER_URL; else process.env.MOBILECLOUD_BUILDER_URL = original; });
  const { userId, ...auth } = await login();
  const created = await request("projects", "POST", { name: "ledger", framework: "Next.js", repoUrl: "https://github.com/acme/ledger.git" }, auth);
  assert.equal(created.status, 201);
  const { id } = await created.json();
  for (const path of ["builds", "deployments"]) {
    const result = await request(path, "POST", { projectId: id, target: "web" }, auth);
    assert.equal(result.status, 201);
    assert.equal((await result.json()).status, "blocked");
  }
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
