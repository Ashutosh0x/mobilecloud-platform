#!/usr/bin/env node
/**
 * MobileCloud realtime gateway.
 *
 * A small, dependency-free RFC 6455 WebSocket server that tails the durable
 * event outbox written by the Next.js API and pushes authorized events to
 * signed-in clients (web dashboard + Android app).
 *
 * Why a separate process: Next.js route handlers cannot answer an HTTP
 * `upgrade`, so `next dev` / `next start` owns :3210 and this gateway owns its
 * own port. Both read the *same* SQLite file (WAL mode allows concurrent
 * readers/writers across processes), so there is exactly one source of truth.
 *
 * Protocol (JSON text frames)
 *   client -> server : hello / subscribe / unsubscribe / ping / ack
 *   server -> client : welcome / event / delivered / replay_start /
 *                      replay_incomplete / pong / error / server.status
 *
 * Authentication reuses the existing account system: the `mc_session` cookie
 * (same cookie the dashboard uses) or a personal access token
 * (`Authorization: Bearer mc_…` / `?token=mc_…`). A connection only ever
 * receives rows whose `owner_id` matches the authenticated account, so a
 * cross-account subscription is impossible rather than merely forbidden.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const PORT = Number(process.env.MOBILECLOUD_REALTIME_PORT ?? 3211);
const HOST = process.env.MOBILECLOUD_REALTIME_HOST ?? "0.0.0.0";
const POLL_MS = clamp(Number(process.env.MOBILECLOUD_REALTIME_POLL_MS ?? 200), 50, 5000);
const DB_PATH = process.env.MOBILECLOUD_DB ?? join(process.cwd(), "data", "mobilecloud.db");
const SCHEMA_VERSION = 1;
const HEARTBEAT_MS = 20_000;
const CLIENT_TIMEOUT_MS = 75_000;
const MAX_FRAME = 256 * 1024;
const MAX_CLIENTS_PER_ACCOUNT = 12;
const MAX_CLIENTS_TOTAL = 500;
const MAX_MSGS_PER_WINDOW = 240;
const MSG_WINDOW_MS = 10_000;
const REPLAY_LIMIT = 500;

const EVENT_TYPES = new Set([
  "account.updated", "session.created", "session.revoked",
  "project.created", "project.updated", "project.deleted",
  "deployment.started", "deployment.updated", "deployment.completed", "deployment.failed",
  "build.started", "build.updated", "build.completed", "build.failed",
  "configuration.updated", "notification.created", "notification.read",
  "server.status_changed",
  "device.pairing.created", "device.pairing.scanned",
  "device.pairing.approval_requested", "device.pairing.approved",
  "device.pairing.connected", "device.pairing.expired",
  "device.pairing.revoked",
  "device.connected", "device.disconnected", "device.updated",
]);

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function log(level, message, extra) {
  const line = { at: new Date().toISOString(), level, service: "realtime", message, ...(extra ?? {}) };
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

// ---------------------------------------------------------------- database ---
mkdirSync(dirname(DB_PATH), { recursive: true });
let db = null;
function openDatabase() {
  if (db) return db;
  if (!existsSync(DB_PATH)) return null;
  const handle = new DatabaseSync(DB_PATH);
  handle.exec("PRAGMA journal_mode = WAL;");
  handle.exec("PRAGMA busy_timeout = 4000;");
  const hasEvents = handle.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='events'").get();
  if (!hasEvents) {
    log("warn", "outbox table not present yet; waiting for the API to migrate the database", { db: DB_PATH });
    return null;
  }
  db = handle;
  return db;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** Resolves a connection's identity from a cookie, bearer token, or query token. */
function authenticate(req) {
  const handle = openDatabase();
  if (!handle) return null;
  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);

  const bearer = req.headers.authorization;
  const queryToken = url.searchParams.get("token");
  const raw = bearer?.startsWith("Bearer ") ? bearer.slice(7) : queryToken;
  if (raw?.startsWith("mc_")) {
    const row = handle.prepare(
      `SELECT u.id, u.email, u.name, u.role, u.plan, t.id AS tokenId
       FROM access_tokens t JOIN users u ON u.id = t.owner_id
       WHERE t.token_hash = ? AND (t.expires_at IS NULL OR t.expires_at > ?)`,
    ).get(sha256(raw), Date.now());
    if (!row) return null;
    handle.prepare("UPDATE access_tokens SET last_used = ? WHERE id = ?").run(Date.now(), row.tokenId);
    return { userId: row.id, name: row.name, email: row.email, sessionId: null, via: "token" };
  }

  const cookie = req.headers.cookie ?? "";
  const hit = cookie.split(";").map((p) => p.trim()).find((p) => p.startsWith("mc_session="));
  if (!hit) return null;
  const sessionToken = decodeURIComponent(hit.slice("mc_session=".length));
  const session = handle.prepare(
    `SELECT s.id AS sessionId, s.expires_at AS expiresAt, u.id, u.email, u.name, u.role, u.plan
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ?`,
  ).get(sha256(sessionToken));
  if (!session || Number(session.expiresAt) < Date.now()) return null;
  return { userId: session.id, sessionId: session.sessionId, name: session.name, email: session.email, via: "cookie" };
}

// -------------------------------------------------------------- ws framing ---
/** RFC 6455 §4.2.2 accept token. */
function acceptToken(key) {
  return createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
}

function encodeFrame(opcode, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload ?? ""), "utf8");
  const len = body.length;
  let header;
  if (len < 126) {
    header = Buffer.allocUnsafe(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.allocUnsafe(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, body]);
}

const OP_CONT = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

class Connection {
  constructor(socket, identity) {
    this.socket = socket;
    this.identity = identity;
    this.ownerId = identity.userId;
    this.sessionId = identity.sessionId;
    this.alive = Date.now();
    this.closed = false;
    this.buffer = Buffer.alloc(0);
    this.fragmentOpcode = null;
    this.fragments = [];
    this.subscriptions = null; // null = every type
    this.ackedSeq = 0;
    this.delivered = 0;
    this.window = { n: 0, reset: Date.now() + MSG_WINDOW_MS };
    this.connectedAt = Date.now();

    socket.setNoDelay(true);
    socket.setTimeout(0);
    socket.on("data", (chunk) => this.onData(chunk));
    socket.on("error", () => this.terminate());
    socket.on("close", () => this.terminate());
    socket.on("end", () => this.terminate());
  }

  onData(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    try {
      while (this.readFrame()) {
        /* keep draining */
      }
    } catch (error) {
      log("warn", "dropping connection after frame error", { error: String(error), account: this.ownerId });
      this.close(1002, "protocol error");
    }
  }

  readFrame() {
    const buf = this.buffer;
    if (buf.length < 2) return false;
    const fin = (buf[0] & 0x80) !== 0;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (buf.length < 4) return false;
      len = buf.readUInt16BE(2);
      offset = 4;
    } else if (len === 127) {
      if (buf.length < 10) return false;
      const big = buf.readBigUInt64BE(2);
      if (big > BigInt(MAX_FRAME)) throw new Error("frame exceeds size limit");
      len = Number(big);
      offset = 10;
    }
    if (len > MAX_FRAME) throw new Error("frame exceeds size limit");
    const maskLen = masked ? 4 : 0;
    if (buf.length < offset + maskLen + len) return false;
    if (!masked) throw new Error("client frames must be masked");
    const mask = buf.subarray(offset, offset + 4);
    const payload = Buffer.from(buf.subarray(offset + 4, offset + 4 + len));
    for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i & 3];
    this.buffer = buf.subarray(offset + 4 + len);
    this.handleFrame(fin, opcode, payload);
    return true;
  }

  handleFrame(fin, opcode, payload) {
    this.alive = Date.now();
    if (opcode === OP_CLOSE) {
      this.close(1000, "bye");
      return;
    }
    if (opcode === OP_PING) {
      this.sendRaw(encodeFrame(OP_PONG, payload));
      return;
    }
    if (opcode === OP_PONG) return;
    if (opcode === OP_BINARY) {
      this.close(1003, "binary frames are not supported");
      return;
    }
    if (opcode === OP_CONT) {
      if (this.fragmentOpcode === null) throw new Error("unexpected continuation frame");
      this.fragments.push(payload);
      if (fin) this.finishMessage();
      return;
    }
    if (opcode !== OP_TEXT) throw new Error(`unsupported opcode ${opcode}`);
    if (fin) {
      this.onMessage(payload.toString("utf8"));
      return;
    }
    this.fragmentOpcode = OP_TEXT;
    this.fragments = [payload];
  }

  finishMessage() {
    const text = Buffer.concat(this.fragments).toString("utf8");
    this.fragmentOpcode = null;
    this.fragments = [];
    this.onMessage(text);
  }

  onMessage(text) {
    const now = Date.now();
    if (now > this.window.reset) this.window = { n: 0, reset: now + MSG_WINDOW_MS };
    this.window.n += 1;
    if (this.window.n > MAX_MSGS_PER_WINDOW) {
      this.close(1008, "rate limit exceeded");
      return;
    }
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      this.send({ type: "error", code: "bad_json", message: "Messages must be JSON objects" });
      return;
    }
    if (!message || typeof message !== "object") return;
    switch (message.type) {
      case "hello":
        this.subscriptions = normalizeTypes(message.subscriptions);
        if (this.subscriptions === undefined) return this.badTypes();
        this.send({ type: "subscribed", subscriptions: this.subscriptions ? [...this.subscriptions] : "all" });
        this.replay(Number.isFinite(Number(message.cursor)) ? Math.max(0, Math.floor(Number(message.cursor))) : 0);
        break;
      case "subscribe":
        this.subscriptions = normalizeTypes(message.types);
        if (this.subscriptions === undefined) return this.badTypes();
        this.send({ type: "subscribed", subscriptions: this.subscriptions ?? "all" });
        break;
      case "unsubscribe":
        this.subscriptions = normalizeTypes(message.types);
        if (this.subscriptions === undefined) return this.badTypes();
        this.send({ type: "unsubscribed", subscriptions: this.subscriptions ?? "all" });
        break;
      case "ping":
        this.send({ type: "pong", id: message.id ?? null, at: Date.now() });
        break;
      case "ack": {
        const raw = message.sequence ?? message.cursor;
        if (Number.isFinite(Number(raw))) this.ackedSeq = Math.floor(Number(raw));
        break;
      }
      case "sync":
        this.replay(Number.isFinite(Number(message.cursor)) ? Math.max(0, Math.floor(Number(message.cursor))) : 0);
        break;
      default:
        this.send({ type: "error", code: "unknown_type", message: `Unknown message type: ${message.type}` });
    }
  }

  badTypes() {
    this.send({ type: "error", code: "unknown_event_type", message: "One or more subscription types are not recognized" });
  }

  /** Authorized catch-up for this account only, then live. */
  replay(cursor) {
    const handle = openDatabase();
    if (!handle) return;
    const rows = handle.prepare(
      `SELECT seq, id, owner_id, type, resource_id, schema_version, payload, at
       FROM events WHERE owner_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`,
    ).all(this.ownerId, cursor, REPLAY_LIMIT + 1);
    const more = rows.length > REPLAY_LIMIT;
    const page = more ? rows.slice(0, REPLAY_LIMIT) : rows;
    const last = page.length ? Number(page[page.length - 1].seq) : cursor;
    this.send({ type: "replay_start", from: cursor, to: last });
    for (const row of page) this.deliver(row);
    if (more) this.send({ type: "replay_incomplete", cursor: last });
    else this.send({ type: "replay_complete", cursor: last });
  }

  matches(type) {
    if (!this.subscriptions) return true;
    return this.subscriptions.has(type);
  }

  deliver(row) {
    const type = String(row.type);
    if (!this.matches(type)) return;
    const event = envelope(row);
    this.delivered += 1;
    this.send({ type: "event", event });
    if (this.delivered % 25 === 0) this.send({ type: "delivered", cursor: event.sequence, count: this.delivered });
  }

  send(payload) {
    this.sendRaw(encodeFrame(OP_TEXT, JSON.stringify(payload)));
  }

  sendRaw(frame) {
    if (this.closed) return;
    try {
      this.socket.write(frame);
    } catch {
      this.terminate();
    }
  }

  close(code, reason) {
    if (this.closed) return;
    const body = Buffer.alloc(2 + Buffer.byteLength(reason ?? ""));
    body.writeUInt16BE(code, 0);
    body.write(reason ?? "", 2);
    this.sendRaw(encodeFrame(OP_CLOSE, body));
    this.terminate();
  }

  terminate() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.socket.destroy();
    } catch {
      /* already gone */
    }
    connections.delete(this);
    const list = byAccount.get(this.ownerId);
    if (list) {
      list.delete(this);
      if (!list.size) byAccount.delete(this.ownerId);
    }
    log("info", "client disconnected", {
      account: this.ownerId,
      via: this.identity.via,
      delivered: this.delivered,
      acked: this.ackedSeq,
      seconds: Math.round((Date.now() - this.connectedAt) / 1000),
    });
  }
}

function normalizeTypes(input) {
  if (input === undefined || input === null) return null;
  if (!Array.isArray(input)) return undefined;
  const out = new Set();
  for (const raw of input) {
    const type = String(raw);
    if (type === "*" || type === "") continue;
    if (type.endsWith(".*")) {
      const prefix = type.slice(0, -1);
      let matched = false;
      for (const known of EVENT_TYPES) {
        if (known.startsWith(prefix)) {
          out.add(known);
          matched = true;
        }
      }
      if (!matched) return undefined;
      continue;
    }
    if (!EVENT_TYPES.has(type)) return undefined;
    out.add(type);
  }
  return out;
}

/** Builds the shared event envelope every client understands. */
function envelope(row) {
  let payload = {};
  try {
    const parsed = JSON.parse(String(row.payload ?? "{}"));
    if (parsed && typeof parsed === "object") payload = parsed;
  } catch {
    payload = {};
  }
  let truncated = false;
  if (JSON.stringify(payload).length > MAX_FRAME / 2) {
    payload = { truncated: true, note: "Payload exceeded the realtime frame limit; fetch /api/sync/changes for the full record." };
    truncated = true;
  }
  return {
    event_id: String(row.id),
    event_type: String(row.type),
    schema_version: Number(row.schema_version ?? SCHEMA_VERSION),
    account_id: String(row.owner_id),
    resource_id: row.resource_id == null ? null : String(row.resource_id),
    sequence: Number(row.seq),
    occurred_at: new Date(Number(row.at)).toISOString(),
    payload,
    ...(truncated ? { truncated: true } : {}),
  };
}

// ------------------------------------------------------------ connections ---
const connections = new Set();
const byAccount = new Map();

// ----------------------------------------------------------------- server ---
const server = createServer((req, res) => {
  if (req.url?.startsWith("/api/health")) {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({
      service: "MobileCloud",
      component: "realtime",
      schemaVersion: SCHEMA_VERSION,
      clients: connections.size,
      accounts: byAccount.size,
      time: new Date().toISOString(),
    }));
    return;
  }
  res.writeHead(426, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "This endpoint speaks WebSocket on /api/realtime" }));
});

server.on("upgrade", (req, socket) => {
  // A rejected or half-closed upgrade must never take the gateway down: the
  // raw socket emits `error` as soon as a client resets mid-handshake.
  socket.on("error", () => socket.destroy());
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const key = req.headers["sec-websocket-key"];
  const wants = (req.headers.upgrade ?? "").toLowerCase() === "websocket";

  if (!wants || url.pathname !== "/api/realtime" || !key) {
    socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  if (connections.size >= MAX_CLIENTS_TOTAL) {
    socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }

  const identity = authenticate(req);
  if (!identity) {
    // 401 tells the client "authenticate", which is different from "unreachable".
    socket.write("HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n");
    socket.end(JSON.stringify({ error: "Sign in required" }));
    return;
  }
  const existing = byAccount.get(identity.userId);
  if (existing && existing.size >= MAX_CLIENTS_PER_ACCOUNT) {
    socket.write("HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }

  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
    "Upgrade: websocket\r\n" +
    "Connection: Upgrade\r\n" +
    `Sec-WebSocket-Accept: ${acceptToken(String(key))}\r\n\r\n`,
  );

  const conn = new Connection(socket, identity);
  connections.add(conn);
  const list = byAccount.get(identity.userId) ?? new Set();
  list.add(conn);
  byAccount.set(identity.userId, list);

  const latest = currentSeq();
  conn.send({
    type: "welcome",
    account_id: identity.userId,
    account_name: identity.name,
    via: identity.via,
    cursor: latest,
    heartbeat_ms: HEARTBEAT_MS,
    schema_version: SCHEMA_VERSION,
    server_time: Date.now(),
    server_status: "online",
    subscriptions: "all",
  });
  log("info", "client connected", { account: identity.userId, via: identity.via, clients: connections.size });
});

function currentSeq() {
  const handle = openDatabase();
  if (!handle) return 0;
  const row = handle.prepare("SELECT COALESCE(MAX(seq), 0) AS s FROM events").get();
  return Number(row?.s ?? 0);
}

// ------------------------------------------------------------------ tailer ---
let tailSeq = -1;

function tail() {
  const handle = openDatabase();
  if (!handle) return;
  if (tailSeq < 0) {
    // Only stream new events; each client replays its own backlog from its cursor.
    tailSeq = currentSeq();
    handle.prepare(
      "INSERT INTO event_cursors (consumer, seq, at) VALUES ('realtime-gateway', ?, ?) ON CONFLICT(consumer) DO UPDATE SET seq = excluded.seq, at = excluded.at",
    ).run(tailSeq, Date.now());
    log("info", "tailing event outbox", { db: DB_PATH, from: tailSeq, pollMs: POLL_MS });
    return;
  }
  const rows = handle.prepare(
    `SELECT seq, id, owner_id, type, resource_id, schema_version, payload, at
     FROM events WHERE seq > ? ORDER BY seq ASC LIMIT 500`,
  ).all(tailSeq);
  if (!rows.length) return;
  for (const row of rows) {
    tailSeq = Number(row.seq);
    const listeners = byAccount.get(String(row.owner_id));
    if (!listeners) continue;
    for (const conn of listeners) conn.deliver(row);
  }
  handle.prepare(
    "INSERT INTO event_cursors (consumer, seq, at) VALUES ('realtime-gateway', ?, ?) ON CONFLICT(consumer) DO UPDATE SET seq = excluded.seq, at = excluded.at",
  ).run(tailSeq, Date.now());
}

function broadcastServerStatus(status) {
  const payload = {
    event_id: `server-${status}-${Date.now()}`,
    event_type: "server.status_changed",
    schema_version: SCHEMA_VERSION,
    account_id: "*",
    resource_id: "realtime",
    sequence: currentSeq(),
    occurred_at: new Date().toISOString(),
    payload: { component: "realtime", status },
    ephemeral: true,
  };
  for (const conn of connections) conn.send({ type: "event", event: { ...payload, account_id: conn.ownerId } });
}

function heartbeat() {
  const now = Date.now();
  for (const conn of connections) {
    if (now - conn.alive > CLIENT_TIMEOUT_MS) {
      conn.close(1001, "heartbeat timeout");
      continue;
    }
    conn.send({ type: "ping", at: now });
  }
}

setInterval(tail, POLL_MS).unref?.();
setInterval(heartbeat, HEARTBEAT_MS).unref?.();

server.listen(PORT, HOST, () => {
  openDatabase();
  log("info", "realtime gateway listening", { host: HOST, port: PORT, db: DB_PATH });
  broadcastServerStatus("online");
});

function shutdown(signal) {
  log("info", "shutting down realtime gateway", { signal });
  broadcastServerStatus("offline");
  for (const conn of connections) conn.close(1001, "server shutting down");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref?.();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
