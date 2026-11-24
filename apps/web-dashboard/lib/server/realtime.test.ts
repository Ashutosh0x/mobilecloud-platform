import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * End-to-end realtime test.
 *
 * Boots the real gateway process against a throwaway database, then drives the
 * *real* API handlers in-process. This exercises the whole chain:
 *
 *   API mutation -> transactional outbox row -> gateway tailer -> WebSocket
 *
 * plus authentication (token / no token / other account) and cursor catch-up.
 * Nothing here is simulated: the gateway is the same `server/realtime.mjs` that
 * serves the dashboard and the Android app.
 */

const DB = join(mkdtempSync(join(tmpdir(), "mc-rt-")), "t.db");
const PORT = 3400 + Math.floor(Math.random() * 400);
const GATEWAY = fileURLToPath(new URL("../../server/realtime.mjs", import.meta.url));

let child: ReturnType<typeof spawn> | null = null;

type Envelope = {
  event_id: string;
  event_type: string;
  account_id: string;
  resource_id: string | null;
  sequence: number;
  payload: Record<string, unknown>;
};

async function waitFor(probe: () => Promise<boolean>, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await probe()) return;
    if (Date.now() > deadline) throw new Error("gateway did not become ready");
    await new Promise((r) => setTimeout(r, 100));
  }
}

function recorder(ws: WebSocket) {
  const messages: { type?: string; event?: Envelope }[] = [];
  const waiters: { predicate: (m: { type?: string; event?: Envelope }) => boolean; resolve: (m: never) => void; timer: NodeJS.Timeout }[] = [];
  ws.addEventListener("message", (event) => {
    let parsed: { type?: string; event?: Envelope };
    try {
      parsed = JSON.parse(String(event.data));
    } catch {
      return;
    }
    messages.push(parsed);
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      if (waiters[i].predicate(parsed)) {
        const waiter = waiters.splice(i, 1)[0];
        clearTimeout(waiter.timer);
        waiter.resolve(parsed as never);
      }
    }
  });
  return {
    messages,
    waitFor<T = { type?: string; event?: Envelope }>(predicate: (m: { type?: string; event?: Envelope }) => boolean, timeoutMs = 8_000): Promise<T> {
      const found = messages.find(predicate);
      if (found) return Promise.resolve(found as T);
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timed out waiting for a realtime message")), timeoutMs);
        waiters.push({ predicate, resolve: resolve as (m: never) => void, timer });
      });
    },
  };
}

function open(url: string, headers: Record<string, string> = {}): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    // Node WebSocket (Undici) accepts headers; the DOM declaration does not model them.
    const NodeSocket = WebSocket as unknown as new (url: string, options: { headers: Record<string, string> }) => WebSocket;
    const ws = new NodeSocket(url, { headers });
    const timer = setTimeout(() => reject(new Error("websocket did not open")), 8_000);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("websocket error"));
    });
  });
}

const WS = `ws://127.0.0.1:${PORT}/api/realtime`;
const WEB_ORIGIN = "https://console.example.test";

function csrf(cookie: string) {
  return /mc_csrf=([a-f0-9]{64})/.exec(cookie)?.[1] ?? "";
}

async function signup(email: string, name: string): Promise<{ cookie: string; token: string; id: string }> {
  const { handle } = await import("./api.ts");
  const { openDb, newId, hashPassword } = await import("./db.ts");
  const id = newId();
  openDb().prepare("INSERT INTO users (id,email,name,password_hash,role,created_at) VALUES (?,?,?,?,'member',?)")
    .run(id, email, name, hashPassword("correct-horse"), Date.now());
  const res = await handle(
    new Request("http://local/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "correct-horse" }),
    }),
    ["auth", "login"],
  );
  assert.equal(res.status, 200);
  const cookie = res.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");

  const tokenRes = await handle(
    new Request("http://local/api/tokens", {
      method: "POST",
      headers: { "content-type": "application/json", cookie, "x-mc-csrf": csrf(cookie) },
      body: JSON.stringify({ name: "realtime-test", days: 7 }),
    }),
    ["tokens"],
  );
  assert.equal(tokenRes.status, 201);
  const { token } = (await tokenRes.json()) as { token: string };
  return { cookie, token, id };
}

async function createProject(cookie: string, name: string) {
  const { handle } = await import("./api.ts");
  const res = await handle(
    new Request("http://local/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json", cookie, "x-mc-csrf": csrf(cookie) },
      body: JSON.stringify({ name, framework: "Next.js" }),
    }),
    ["projects"],
  );
  assert.equal(res.status, 201);
  return (await res.json()) as { id: string };
}

before(async () => {
  process.env.MOBILECLOUD_DB = DB;
  const { resetDb, openDb } = await import("./db.ts");
  resetDb();
  openDb(); // create the schema (including the outbox) before the gateway starts

  child = spawn(process.execPath, [GATEWAY], {
    env: {
      ...process.env,
      MOBILECLOUD_DB: DB,
      MOBILECLOUD_REALTIME_PORT: String(PORT),
      MOBILECLOUD_REALTIME_HOST: "127.0.0.1",
      MOBILECLOUD_PUBLIC_ORIGIN: WEB_ORIGIN,
      MOBILECLOUD_REALTIME_POLL_MS: "80",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr?.on("data", (chunk) => process.stderr.write(`[gateway] ${chunk}`));

  await waitFor(async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/health`);
      return res.ok;
    } catch {
      return false;
    }
  });
});

after(() => {
  child?.kill("SIGTERM");
});

test("a mutation on the API reaches a connected WebSocket client in real time", async () => {
  const { resetDb } = await import("./db.ts");
  resetDb();
  const alice = await signup("rt-alice@example.com", "Alice");

  const ws = await open(WS, { authorization: `Bearer ${alice.token}` });
  const rx = recorder(ws);
  const welcome = await rx.waitFor((m) => m.type === "welcome");
  assert.equal((welcome as { account_id: string }).account_id, alice.id);

  const project = await createProject(alice.cookie, "realtime-app");
  const delivered = await rx.waitFor((m) => m.type === "event" && m.event?.event_type === "project.created");
  const envelope = (delivered as { event: Envelope }).event;
  assert.equal(envelope.account_id, alice.id);
  assert.equal(envelope.resource_id, project.id);
  assert.equal(envelope.payload.name, "realtime-app");

  ws.close();
});

test("a client only receives events for its own account", async () => {
  const { resetDb } = await import("./db.ts");
  resetDb();
  const alice = await signup("rt-a2@example.com", "Alice");
  const bob = await signup("rt-b2@example.com", "Bob");

  const ws = await open(WS, { authorization: `Bearer ${bob.token}` });
  const rx = recorder(ws);
  await rx.waitFor((m) => m.type === "welcome");

  await createProject(alice.cookie, "alice-realtime");

  // Bob must not see Alice's project. Prove the socket is alive at all by
  // giving Bob his own project afterwards.
  await assert.rejects(
    () => rx.waitFor((m) => m.type === "event" && m.event?.event_type === "project.created", 1_200),
    /timed out/,
  );

  await createProject(bob.cookie, "bob-realtime");
  const own = await rx.waitFor((m) => m.type === "event" && m.event?.event_type === "project.created");
  assert.equal((own as { event: Envelope }).event.account_id, bob.id);

  ws.close();
});

test("an unauthenticated upgrade is rejected with 401 rather than silently accepted", async () => {
  await assert.rejects(() => open(WS), /websocket error|did not open/);
  const client = await signup("rt-origin@example.test", "Origin fixture");
  await assert.rejects(() => open(WS, { cookie: client.cookie, origin: "https://other.example.test" }), /websocket error/);
  await assert.rejects(() => open(WS, { cookie: client.cookie }), /websocket error/);
  const approved = await open(WS, { cookie: client.cookie, origin: WEB_ORIGIN });
  approved.close();
});

test("a reconnecting client replays the changes it missed while offline", async () => {
  const { resetDb } = await import("./db.ts");
  resetDb();
  const carol = await signup("rt-carol@example.com", "Carol");

  // First connection: note where we are, then disconnect (simulated outage).
  const first = await open(WS, { authorization: `Bearer ${carol.token}` });
  const firstRx = recorder(first);
  const welcome = (await firstRx.waitFor((m) => m.type === "welcome")) as { cursor: number };
  const cursor = welcome.cursor;
  first.close();

  // While "offline" the account keeps changing.
  await createProject(carol.cookie, "offline-one");
  await createProject(carol.cookie, "offline-two");

  // Reconnect and replay from the stored cursor — exactly what a client does
  // with GET /api/sync/changes or a `hello`/`sync` frame.
  const second = await open(WS, { authorization: `Bearer ${carol.token}` });
  const secondRx = recorder(second);
  await secondRx.waitFor((m) => m.type === "welcome");
  second.send(JSON.stringify({ type: "sync", cursor }));

  const replayed: string[] = [];
  const deadline = Date.now() + 8_000;
  while (replayed.length < 2 && Date.now() < deadline) {
    const message = await secondRx.waitFor(
      (m) => m.type === "replay_complete" || (m.type === "event" && m.event?.event_type === "project.created" && !replayed.includes(m.event.event_id)),
    );
    if ((message as { type?: string }).type === "event") replayed.push((message as { event: Envelope }).event.event_id);
    else break;
  }
  assert.equal(replayed.length, 2);

  second.close();
});

function awaitClose(ws: WebSocket) {
  return new Promise<CloseEvent>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("socket stayed open")), 3000);
    ws.addEventListener("close", (event) => { clearTimeout(timer); resolve(event); }, { once: true });
  });
}

test("logout terminates an active native session socket; expiry terminates a bearer socket", async () => {
  const { handle } = await import("./api.ts");
  const { openDb, tokenHash } = await import("./db.ts");
  const account = await signup("rt-expiry@example.test", "Expiry fixture");
  const session = /mc_session=([a-f0-9]{64})/.exec(account.cookie)?.[1];
  assert.ok(session);
  const native = { authorization: `Session ${session}` };
  const nativeSocket = await open(WS, native);
  const closed = awaitClose(nativeSocket);
  const logout = await handle(new Request("http://local/api/auth/logout", {
    method: "POST", headers: { cookie: account.cookie, "x-mc-csrf": csrf(account.cookie) },
  }), ["auth", "logout"]);
  assert.equal(logout.status, 200);
  assert.equal((await closed).code, 1008);
  await assert.rejects(() => open(WS, native), /websocket error/);

  const bearer = { authorization: `Bearer ${account.token}` };
  const bearerSocket = await open(WS, bearer);
  const expired = awaitClose(bearerSocket);
  openDb().prepare("UPDATE access_tokens SET expires_at = ? WHERE token_hash = ?").run(Date.now() - 1, tokenHash(account.token));
  assert.equal((await expired).code, 1008);
  await assert.rejects(() => open(WS, bearer), /websocket error/);
});

test("device revocation closes both credential forms and denies subsequent HTTP and sockets", async () => {
  const { handle } = await import("./api.ts");
  const owner = await signup("rt-device@example.test", "Device fixture");
  const api = (path: string[], method: string, input?: object, headers?: HeadersInit) => {
    const all = new Headers(headers);
    if (input) all.set("content-type", "application/json");
    return handle(new Request(`http://local/api/${path.join("/")}`, { method, headers: all, body: input && JSON.stringify(input) }), path);
  };
  const ownerHeaders = { cookie: owner.cookie, "x-mc-csrf": csrf(owner.cookie) };
  const pairing = ["device", "pairing"];
  const created = await api(pairing, "POST", { name: "Dashboard" }, ownerHeaders);
  assert.equal(created.status, 201);
  const payload = new URL((await created.json()).payload);
  const ticket = [...pairing, payload.searchParams.get("id")!];
  const input = { secret: payload.searchParams.get("secret"), name: "Phone" };
  const scan = await api([...ticket, "scan"], "POST", input);
  assert.equal(scan.status, 200);
  const scanCookie = scan.headers.getSetCookie()[0].split(";")[0];
  assert.equal((await api([...ticket, "approve"], "POST", undefined, ownerHeaders)).status, 200);
  const claim = await api([...ticket, "claim"], "POST", input, { cookie: scanCookie });
  assert.equal(claim.status, 200);
  const { credential, device } = await claim.json();
  const cookie = claim.headers.getSetCookie().find((c) => c.startsWith("mc_session=") && c.includes("Path=/;"))!.split(";")[0];
  const deviceSession = { cookie, origin: WEB_ORIGIN };
  const bearer = { authorization: `Bearer ${credential}` };
  const sockets = await Promise.all([open(WS, deviceSession), open(WS, bearer)]);
  const closed = sockets.map(awaitClose);
  assert.equal((await api(["devices", device.id], "DELETE", undefined, ownerHeaders)).status, 200);
  assert.deepEqual((await Promise.all(closed)).map((event) => event.code), [1008, 1008]);
  for (const headers of [deviceSession, bearer]) {
    assert.equal((await api(["overview"], "GET", undefined, headers)).status, 401);
    await assert.rejects(() => open(WS, headers), /websocket error/);
  }
});
