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
 * (with an approved browser Origin), or an explicit native Authorization
 * header (`Session` or `Bearer`). A connection only ever
 * receives rows whose `owner_id` matches the authenticated account, so a
 * cross-account subscription is impossible rather than merely forbidden.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const PORT = Number(process.env.MOBILECLOUD_REALTIME_PORT ?? 3211);
const HOST = process.env.MOBILECLOUD_REALTIME_HOST ?? "127.0.0.1";
const POLL_MS = clamp(Number(process.env.MOBILECLOUD_REALTIME_POLL_MS ?? 200), 50, 5000);
const DB_PATH = process.env.MOBILECLOUD_DB ?? join(process.env.MOBILECLOUD_DATA_ROOT ?? join(process.cwd(), "data"), "mobilecloud.db");
const WEB_PORT = Number(process.env.PORT ?? 3210);
const PROTOCOL_PATH = "/api/realtime";
const MAX_OUTBOUND = 512 * 1024;
const PROD = process.env.NODE_ENV === "production";
const origins = new Set();
try {
  const url = new URL(process.env.MOBILECLOUD_PUBLIC_ORIGIN ?? "");
  if ((url.protocol === "https:" || (!PROD && url.protocol === "http:")) && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash) {
    origins.add(url.origin);
  }
} catch { /* Invalid or absent config never creates a production allowlist. */ }
if (!PROD && !process.env.MOBILECLOUD_PUBLIC_ORIGIN && Number.isInteger(WEB_PORT) && WEB_PORT > 0 && WEB_PORT <= 65535) {
  for (const host of ["localhost", "127.0.0.1", "[::1]"]) origins.add(new URL(`http://${host}:${WEB_PORT}`).origin);
}
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
let sessionLookup;
let tokenLookup;
function openDatabase() {
  if (db) return db;
  if (!existsSync(DB_PATH)) return null;
  const handle = new DatabaseSync(DB_PATH);
  try {
    handle.exec("PRAGMA busy_timeout = 250;");
    if (!handle.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'control_plane_migrations'").get()
      || !handle.prepare("SELECT 1 FROM control_plane_migrations WHERE version = 1").get()) return null;
    sessionLookup = handle.prepare(`
      SELECT u.id AS userId, u.name, s.id AS sessionId
      FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ? AND s.csrf IS NOT NULL
        AND (s.device_id IS NULL OR EXISTS (
          SELECT 1 FROM connected_devices d JOIN access_tokens t ON t.id = d.token_id AND t.owner_id = d.owner_id
          WHERE d.id = s.device_id AND d.owner_id = s.user_id AND d.revoked = 0 AND t.expires_at > ?
        ))`);
    tokenLookup = handle.prepare(`
      SELECT u.id AS userId, u.name, NULL AS sessionId
      FROM access_tokens t JOIN users u ON u.id = t.owner_id
      LEFT JOIN connected_devices d ON d.token_id = t.id AND d.owner_id = u.id
      WHERE t.token_hash = ? AND t.expires_at > ? AND (d.id IS NULL OR d.revoked = 0)`);
    db = handle;
    return db;
  } finally {
    if (db !== handle) handle.close();
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function lookup(via, hash) {
  if (!openDatabase()) return null;
  const now = Date.now();
  return via === "token" ? tokenLookup.get(hash, now) : sessionLookup.get(hash, now, now);
}

function authenticate(req) {
  const authorization = req.headers.authorization;
  const origin = req.headers.origin;
  let raw;
  let via;
  if (authorization !== undefined) {
    const bearer = /^Bearer (mc_[a-f0-9]{48})$/i.exec(authorization);
    const nativeSession = origin === undefined ? /^Session ([a-f0-9]{64})$/i.exec(authorization) : null;
    if (!bearer && !nativeSession) return null;
    via = bearer ? "token" : "cookie";
    raw = (bearer ?? nativeSession)[1];
  } else {
    if (!origins.has(origin)) return null;
    const hits = (req.headers.cookie ?? "").split(";").map((p) => p.trim()).filter((p) => p.startsWith("mc_session="));
    if (hits.length !== 1 || !/^mc_session=[a-f0-9]{64}$/.test(hits[0])) return null;
    via = "cookie";
    raw = hits[0].slice("mc_session=".length);
  }
  const hash = sha256(raw);
  const identity = lookup(via, hash);
  return identity ? { ...identity, via, hash } : null;
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
    this.fragmentBytes = 0;
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

  authorized() {
    if (this.closed) return false;
    try {
      const { via, hash } = this.identity;
      if (lookup(via, hash)?.userId === this.ownerId) return true;
      this.close(1008, "authentication expired or revoked");
    } catch {
      this.close(1011, "authentication unavailable");
    }
    return false;
  }

  onData(chunk) {
    if (!this.authorized()) return;
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    try {
      while (!this.closed && this.readFrame()) {
        /* keep draining */
      }
    } catch {
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
    if ((buf[0] & 0x70) !== 0 || (opcode >= OP_CLOSE && (!fin || len > 125))) throw new Error("invalid frame flags");
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
      this.fragmentBytes += payload.length;
      if (this.fragmentBytes > MAX_FRAME || this.fragments.length >= 256) throw new Error("message exceeds size limit");
      this.fragments.push(payload);
      if (fin) this.finishMessage();
      return;
    }
    if (opcode !== OP_TEXT || this.fragmentOpcode !== null) throw new Error("unexpected data frame");
    if (fin) {
      this.onMessage(payload.toString("utf8"));
      return;
    }
    this.fragmentOpcode = OP_TEXT;
    this.fragments = [payload];
    this.fragmentBytes = payload.length;
  }

  finishMessage() {
    const text = Buffer.concat(this.fragments, this.fragmentBytes).toString("utf8");
    this.fragmentOpcode = null;
    this.fragments = [];
    this.fragmentBytes = 0;
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
    if (!this.authorized()) return;
    const rows = handle.prepare(
      `SELECT e.seq, e.id, e.owner_id, e.type, e.resource_id, e.schema_version, e.payload, e.at,
         COALESCE((SELECT MAX(p.seq) FROM events p WHERE p.owner_id = e.owner_id AND p.seq < e.seq), 0) AS previous_seq
       FROM events e WHERE e.owner_id = ? AND e.seq > ? ORDER BY e.seq ASC LIMIT ?`,
    ).iterate(this.ownerId, cursor, REPLAY_LIMIT + 1);
    const page = [];
    let more = false;
    let bytes = 0;
    for (const row of rows) {
      bytes += Math.min(Buffer.byteLength(row.payload), MAX_FRAME / 2) + 512;
      if (page.length >= REPLAY_LIMIT || (page.length > 0 && bytes > MAX_OUTBOUND / 2)) { more = true; break; }
      page.push(row);
    }
    const last = page.length ? Number(page[page.length - 1].seq) : cursor;
    this.send({ type: "replay_start", from: cursor, to: last, cursor: last });
    for (const row of page) this.deliver(row);
    this.send({ type: more ? "replay_incomplete" : "replay_complete", cursor: last, to: last, sequence: last });
  }

  matches(type) {
    if (!this.subscriptions) return true;
    return this.subscriptions.has(type);
  }

  deliver(row) {
    const type = String(row.type);
    if (!this.matches(type) || !this.authorized()) return;
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
    if (this.socket.writableLength + frame.length > MAX_OUTBOUND) return this.terminate();
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
    if (this.socket.writableLength) return this.terminate();
    try {
      this.socket.end(encodeFrame(OP_CLOSE, body));
      const timer = setTimeout(() => this.socket.destroy(), 1000);
      timer.unref();
      this.socket.once("close", () => clearTimeout(timer));
      this.terminate(false);
    } catch {
      this.terminate();
    }
  }

  terminate(destroy = true) {
    if (destroy) this.socket.destroy();
    if (this.closed) return;
    this.closed = true;
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
    previous_sequence: Number(row.previous_seq ?? 0),
    occurred_at: new Date(Number(row.at)).toISOString(),
    payload,
    ...(truncated ? { truncated: true } : {}),
  };
}

// ------------------------------------------------------------ connections ---
const connections = new Set();
const byAccount = new Map();

// ----------------------------------------------------------------- server ---
const server = createServer({ maxHeaderSize: 8192, headersTimeout: 5000, requestTimeout: 10_000 }, (req, res) => {
  if (req.url === "/api/ready") {
    let ready = false;
    try { ready = Boolean(openDatabase()) && tailSeq >= 0 && Date.now() - lastSuccessfulTail < Math.max(1000, POLL_MS * 3) && (!PROD || origins.size > 0); }
    catch { /* Not ready; keep the identity endpoint independent. */ }
    res.writeHead(ready ? 200 : 503, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ ready }));
    return;
  }
  if (req.url === "/api/health") {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({
      service: "MobileCloud",
      component: "realtime",
      schemaVersion: SCHEMA_VERSION,
      time: new Date().toISOString(),
    }));
    return;
  }
  res.writeHead(426, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "This endpoint speaks WebSocket on /api/realtime" }));
});

function reject(socket, status) {
  socket.setTimeout(1000, () => socket.destroy());
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

const upgradeAttempts = new Map();
function tooManyUpgrades(peer) {
  const now = Date.now();
  for (const [ip, window] of upgradeAttempts) if (window.until <= now) upgradeAttempts.delete(ip);
  if (!upgradeAttempts.has(peer)) {
    if (upgradeAttempts.size >= 1024) return true;
    upgradeAttempts.set(peer, { count: 0, until: now + 10_000 });
  }
  return ++upgradeAttempts.get(peer).count > 100;
}

server.on("upgrade", (req, socket, head) => {
  socket.on("error", () => socket.destroy());
  let conn;
  try {
    // Only the canonical path is accepted. Credentials in URLs are never read.
    if (typeof req.url !== "string" || req.url.split("?", 1)[0] !== PROTOCOL_PATH) return reject(socket, "404 Not Found");
    if (req.url !== PROTOCOL_PATH) return reject(socket, "401 Unauthorized");
    const key = req.headers["sec-websocket-key"];
    const wants = (req.headers.upgrade ?? "").toLowerCase() === "websocket";
    if (req.method !== "GET" || !wants || req.headers["sec-websocket-version"] !== "13"
      || typeof key !== "string" || !/^[A-Za-z0-9+/]{22}==$/.test(key)) return reject(socket, "400 Bad Request");
    if (tooManyUpgrades(socket.remoteAddress ?? "unknown")) return reject(socket, "429 Too Many Requests");
    if (connections.size >= MAX_CLIENTS_TOTAL || !openDatabase()) return reject(socket, "503 Service Unavailable");
    const identity = authenticate(req);
    if (!identity) return reject(socket, "401 Unauthorized");
    const list = byAccount.get(identity.userId) ?? new Set();
    if (list.size >= MAX_CLIENTS_PER_ACCOUNT) return reject(socket, "429 Too Many Requests");

    initializeTail();
    const latest = currentSeq(identity.userId);
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${acceptToken(key)}\r\n\r\n`,
    );
    conn = new Connection(socket, identity);
    connections.add(conn);
    list.add(conn);
    byAccount.set(identity.userId, list);
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
    if (head.length) conn.onData(head);
    log("info", "client connected", { account: identity.userId, via: identity.via, clients: connections.size });
  } catch {
    if (conn) conn.close(1011, "upgrade unavailable");
    else reject(socket, "503 Service Unavailable");
  }
});

function currentSeq(ownerId) {
  const handle = openDatabase();
  if (!handle) return 0;
  const row = ownerId
    ? handle.prepare("SELECT COALESCE(MAX(seq), 0) AS s FROM events WHERE owner_id = ?").get(ownerId)
    : handle.prepare("SELECT COALESCE(MAX(seq), 0) AS s FROM events").get();
  return Number(row?.s ?? 0);
}

// ------------------------------------------------------------------ tailer ---
let tailSeq = -1;

function initializeTail() {
  const handle = openDatabase();
  if (!handle || tailSeq >= 0) return;
  const latest = currentSeq();
  const previous = handle.prepare("SELECT seq FROM event_cursors WHERE consumer = 'realtime-gateway'").get();
  tailSeq = previous ? Math.min(previous.seq, latest) : latest;
  persistTail(handle);
}

function persistTail(handle) {
  handle.prepare(
    "INSERT INTO event_cursors (consumer, seq, at) VALUES ('realtime-gateway', ?, ?) ON CONFLICT(consumer) DO UPDATE SET seq = excluded.seq, at = excluded.at",
  ).run(tailSeq, Date.now());
}

function tail() {
  for (const conn of connections) conn.authorized();
  const handle = openDatabase();
  if (!handle) return;
  initializeTail();
  const rows = handle.prepare(
    `SELECT e.seq, e.id, e.owner_id, e.type, e.resource_id, e.schema_version, e.payload, e.at,
       COALESCE((SELECT MAX(p.seq) FROM events p WHERE p.owner_id = e.owner_id AND p.seq < e.seq), 0) AS previous_seq
     FROM events e WHERE e.seq > ? ORDER BY e.seq ASC LIMIT 500`,
  ).all(tailSeq);
  if (!rows.length) return;
  for (const row of rows) {
    tailSeq = Number(row.seq);
    const listeners = byAccount.get(String(row.owner_id));
    if (!listeners) continue;
    for (const conn of listeners) {
      try { conn.deliver(row); }
      catch { conn.close(1011, "delivery unavailable"); }
    }
  }
  persistTail(handle);
}

function broadcastServerStatus(status) {
  const payload = {
    event_id: `server-${status}-${Date.now()}`,
    event_type: "server.status_changed",
    schema_version: SCHEMA_VERSION,
    account_id: "*",
    resource_id: "realtime",
    sequence: 0,
    occurred_at: new Date().toISOString(),
    payload: { component: "realtime", status },
    ephemeral: true,
  };
  for (const conn of connections) if (conn.authorized()) conn.send({ type: "event", event: { ...payload, account_id: conn.ownerId } });
}

function heartbeat() {
  const now = Date.now();
  for (const conn of connections) {
    if (now - conn.alive > CLIENT_TIMEOUT_MS) {
      conn.close(1001, "heartbeat timeout");
      continue;
    }
    if (conn.authorized()) {
      conn.sendRaw(encodeFrame(OP_PING, ""));
      conn.send({ type: "ping", at: now });
    }
  }
}

let lastSuccessfulTail = 0;
let lastTailWarning = 0;
setInterval(() => {
  try {
    tail();
    if (db) lastSuccessfulTail = Date.now();
  } catch {
    if (Date.now() - lastTailWarning > 10_000) {
      lastTailWarning = Date.now();
      log("warn", "outbox poll failed; retrying");
    }
  }
}, POLL_MS).unref();
setInterval(heartbeat, HEARTBEAT_MS).unref();

server.listen(PORT, HOST, () => {
  log("info", "realtime gateway listening", { host: HOST, port: PORT });
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
