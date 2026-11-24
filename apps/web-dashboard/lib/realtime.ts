"use client";

/**
 * Shared real-time client for the web dashboard.
 *
 * One singleton [WebSocket] for the whole app — components subscribe to this
 * module instead of opening their own sockets. It mirrors the Android
 * `RealtimeClient`: same protocol, same reconnect/backoff/heartbeat semantics,
 * same durable-cursor recovery through `GET /api/sync/changes?cursor=`.
 *
 * The socket is only trusted once the gateway answers `welcome`, which it does
 * only after it has authenticated the `mc_session` cookie. Until then the
 * status is CONNECTING/RECONNECTING — never a false CONNECTED.
 */

export type RealtimeStatus =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "offline"
  | "syncing"
  | "sync_error";

export type RealtimeEvent = {
  event_id: string;
  event_type: string;
  schema_version: number;
  account_id: string;
  resource_id: string | null;
  sequence: number;
  occurred_at: string;
  payload: Record<string, unknown>;
};

export type RealtimeState = {
  status: RealtimeStatus;
  accountId: string | null;
  accountName: string | null;
  cursor: number;
  lastSyncAt: number | null;
  lastError: string | null;
  /** Events received since the last acknowledged sync. */
  pending: number;
  attempts: number;
  transport: "websocket" | "poll" | null;
  serverStatus: "online" | "offline" | "unknown";
};

type Listener = (state: RealtimeState) => void;
type EventHandler = (event: RealtimeEvent) => void;

const HEARTBEAT_MS = 25_000;
/** No traffic for this long means the socket is dead even if it never closed. */
const DEAD_MS = 75_000;
const CONNECT_TIMEOUT_MS = 12_000;
const MAX_BACKOFF_MS = 30_000;
/** How many distinct event ids we remember for duplicate suppression. */
const SEEN_LIMIT = 2_000;
const RECOVERY_PAGE = 500;
const POLL_MS = 5_000;
/** Consecutive socket failures before falling back to bounded polling. */
const POLL_FALLBACK_AFTER = 4;
const CURSOR_KEY = "mobilecloud.realtime.cursor";

function emptyState(): RealtimeState {
  return {
    status: "connecting",
    accountId: null,
    accountName: null,
    cursor: 0,
    lastSyncAt: null,
    lastError: null,
    pending: 0,
    attempts: 0,
    transport: null,
    serverStatus: "unknown",
  };
}

function backoff(attempts: number): number {
  const base = Math.min(MAX_BACKOFF_MS, 500 * 2 ** attempts);
  // Full jitter, bounded below at half the window so we never hammer.
  return Math.round(base * (0.5 + Math.random() * 0.5));
}

class RealtimeClient {
  private state: RealtimeState = emptyState();
  private listeners = new Set<Listener>();
  private handlers = new Set<EventHandler>();
  private socket: WebSocket | null = null;
  private endpoint: string | null = null;
  private started = false;
  private stopped = true;
  private syncing = false;
  private failing = 0;
  private seen = new Set<string>();
  private seenOrder: string[] = [];
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private lastMessageAt = 0;
  private bound = false;

  // ---- public API ---------------------------------------------------------

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  onEvent(handler: EventHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  snapshot(): RealtimeState {
    return { ...this.state };
  }

  start() {
    if (typeof window === "undefined") return;
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    this.attachNetworkListeners();
    this.state.cursor = this.readCursor();
    void this.connect();
  }

  stop() {
    this.stopped = true;
    this.started = false;
    this.clearTimers();
    this.closeSocket();
  }

  /** Full reset — used on logout so the next account starts from cursor 0. */
  reset() {
    this.stop();
    this.endpoint = null;
    this.failing = 0;
    this.seen.clear();
    this.seenOrder = [];
    this.state = emptyState();
    try {
      window.localStorage.removeItem(CURSOR_KEY);
    } catch {
      /* storage unavailable */
    }
    this.emit();
  }

  /** Force an immediate reconnect (used by the "Retry" affordance). */
  retry() {
    this.state.attempts = 0;
    this.failing = 0;
    this.closeSocket();
    this.clearTimers();
    if (!this.stopped) void this.connect();
  }

  // ---- connection lifecycle ----------------------------------------------

  private async connect() {
    if (this.stopped) return;
    this.set({
      status: this.state.attempts > 0 ? "reconnecting" : "connecting",
    });

    if (typeof window !== "undefined" && this.shouldPoll()) {
      this.startPolling();
      return;
    }

    const url = await this.resolveEndpoint();
    if (this.stopped) return;
    if (!url) {
      this.fail("Realtime endpoint could not be resolved from /api/health.");
      return;
    }
    if (typeof WebSocket === "undefined") {
      this.startPolling();
      return;
    }

    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch (error) {
      this.fail(error instanceof Error ? error.message : "WebSocket could not be opened.");
      return;
    }
    this.socket = socket;
    this.lastMessageAt = Date.now();
    this.connectTimer = setTimeout(() => {
      if (this.socket === socket && this.state.status !== "connected") {
        this.fail("The realtime handshake timed out.");
        socket.close();
      }
    }, CONNECT_TIMEOUT_MS);

    socket.onopen = () => {
      // Not CONNECTED yet: the gateway still has to authenticate us.
      this.set({ transport: "websocket" });
    };

    socket.onmessage = (message) => {
      this.lastMessageAt = Date.now();
      if (typeof message.data !== "string") return;
      this.handle(message.data);
    };

    socket.onerror = () => {
      this.set({ lastError: "Realtime socket error." });
    };

    socket.onclose = () => {
      if (this.socket === socket) this.socket = null;
      this.clearConnectTimer();
      this.stopHeartbeat();
      if (this.stopped) return;
      this.fail("Realtime connection closed.");
    };
  }

  private handle(raw: string) {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    const type = String(message.type ?? "");

    switch (type) {
      case "welcome": {
        this.clearConnectTimer();
        const serverCursor = Number(message.cursor ?? 0);
        this.failing = 0;
        this.set({
          status: "connected",
          accountId: typeof message.account_id === "string" ? message.account_id : null,
          accountName: typeof message.account_name === "string" ? message.account_name : null,
          attempts: 0,
          lastError: null,
          lastSyncAt: Date.now(),
          serverStatus: "online",
        });
        // No `types` means "every event type" (the gateway default).
        this.send({ type: "subscribe" });
        this.startHeartbeat();
        // A stored cursor that is behind the server means we were away: replay
        // the gap. With no stored cursor we are starting fresh (the store has
        // just pulled a full snapshot), so we simply adopt the server cursor.
        if (this.state.cursor > 0 && serverCursor > this.state.cursor) {
          void this.recover();
        } else {
          this.set({ cursor: Math.max(this.state.cursor, serverCursor) });
          this.writeCursor();
        }
        break;
      }
      case "event": {
        const envelope = (message.event ?? message.payload) as RealtimeEvent | undefined;
        if (envelope && typeof envelope.event_id === "string") this.apply(envelope);
        break;
      }
      case "replay_start":
        this.set({ status: "syncing" });
        break;
      case "replay_complete": {
        const latest = Number(message.latest ?? this.state.cursor);
        this.set({ status: "connected", cursor: Math.max(this.state.cursor, latest), lastSyncAt: Date.now() });
        this.writeCursor();
        break;
      }
      case "replay_incomplete":
        void this.recover();
        break;
      case "pong":
        break;
      case "delivered":
        break;
      case "server.status": {
        const value = String(message.status ?? "unknown");
        this.set({ serverStatus: value === "online" ? "online" : "offline", status: value === "offline" ? "reconnecting" : this.state.status });
        break;
      }
      case "error": {
        const code = String(message.code ?? "");
        if (code === "unauthorized" || code === "unauthenticated") {
          this.set({ status: "sync_error", lastError: "The realtime session is not authorised." });
          this.stop();
        } else {
          this.set({ lastError: String(message.message ?? "Realtime error.") });
        }
        break;
      }
      default:
        break;
    }
  }

  /** Ordering + duplicate protection, then fan-out to subscribers. */
  private apply(envelope: RealtimeEvent) {
    if (this.seen.has(envelope.event_id)) return; // idempotent: duplicates are ignored
    this.seen.add(envelope.event_id);
    this.seenOrder.push(envelope.event_id);
    if (this.seenOrder.length > SEEN_LIMIT) {
      const dropped = this.seenOrder.splice(0, this.seenOrder.length - SEEN_LIMIT);
      for (const id of dropped) this.seen.delete(id);
    }

    const sequence = Number(envelope.sequence ?? 0);
    // A hole in the sequence means we missed something (e.g. the socket dropped
    // mid-stream). Recover from the durable log rather than staying wrong.
    if (this.state.cursor > 0 && sequence > this.state.cursor + 1) {
      void this.recover();
    }

    if (sequence > this.state.cursor) {
      this.set({ cursor: sequence, pending: this.state.pending + 1, lastSyncAt: Date.now() });
      this.writeCursor();
    }

    for (const handler of this.handlers) {
      try {
        handler(envelope);
      } catch {
        /* a broken subscriber must not break delivery */
      }
    }

    this.send({ type: "ack", sequence });
  }

  /** Cursor-based catch-up from the durable outbox — the offline safety net. */
  private async recover() {
    if (this.syncing || this.stopped) return;
    this.syncing = true;
    this.set({ status: "syncing" });
    try {
      for (let guard = 0; guard < 40; guard += 1) {
        const res = await fetch(`/api/sync/changes?cursor=${this.state.cursor}&limit=${RECOVERY_PAGE}`, {
          credentials: "include",
        });
        if (res.status === 401) {
          this.set({ status: "sync_error", lastError: "Your session expired. Sign in again." });
          this.stop();
          return;
        }
        if (!res.ok) throw new Error(`Sync failed (${res.status})`);
        const page = (await res.json()) as { events: RealtimeEvent[]; cursor: number; more: boolean; latest: number };
        for (const event of page.events ?? []) this.apply(event);
        this.set({ cursor: Math.max(this.state.cursor, Number(page.cursor ?? 0)) });
        this.writeCursor();
        if (!page.more) break;
      }
      this.set({ status: "connected", lastError: null, lastSyncAt: Date.now(), pending: 0 });
    } catch (error) {
      this.set({
        status: "sync_error",
        lastError: error instanceof Error ? error.message : "Could not synchronise missed changes.",
      });
    } finally {
      this.syncing = false;
    }
  }

  // ---- fallback: bounded polling ----------------------------------------

  private shouldPoll(): boolean {
    return this.failing >= POLL_FALLBACK_AFTER || typeof WebSocket === "undefined";
  }

  private startPolling() {
    if (this.pollTimer) return;
    this.set({ transport: "poll", status: "syncing" });
    const tick = async () => {
      if (this.stopped) return;
      try {
        await this.recover();
        this.set({ status: "connected", pending: 0 });
      } catch {
        /* recover() already records the error */
      }
    };
    void tick();
    // Bounded interval: fast for the first minutes, then relax.
    let slow = false;
    let ticks = 0;
    this.pollTimer = setInterval(() => {
      ticks += 1;
      if (ticks > 60 && !slow) {
        slow = true;
        if (this.pollTimer) clearInterval(this.pollTimer);
        this.pollTimer = setInterval(tick, POLL_MS * 6);
      }
      void tick();
    }, POLL_MS);
  }

  private stopPolling() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  // ---- heartbeat ---------------------------------------------------------

  private startHeartbeat() {
    this.stopHeartbeat();
    this.lastMessageAt = Date.now();
    this.heartbeat = setInterval(() => {
      if (Date.now() - this.lastMessageAt > DEAD_MS) {
        this.fail("Realtime heartbeat timed out.");
        this.closeSocket();
        return;
      }
      this.send({ type: "ping", at: Date.now() });
    }, HEARTBEAT_MS);
  }

  private stopHeartbeat() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  // ---- failure + reconnect ----------------------------------------------

  private fail(reason: string) {
    if (this.stopped) return;
    this.clearConnectTimer();
    this.stopHeartbeat();
    this.failing += 1;
    const attempts = this.state.attempts + 1;
    this.set({ status: "reconnecting", attempts, lastError: reason });
    const wait = backoff(attempts);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      if (this.stopped) return;
      if (this.shouldPoll()) this.startPolling();
      else void this.connect();
    }, wait);
  }

  private closeSocket() {
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    try {
      socket.close();
    } catch {
      /* already closing */
    }
  }

  private clearConnectTimer() {
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.connectTimer = null;
  }

  private clearTimers() {
    this.clearConnectTimer();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.stopHeartbeat();
    this.stopPolling();
  }

  // ---- network awareness -------------------------------------------------

  private attachNetworkListeners() {
    if (this.bound || typeof window === "undefined") return;
    this.bound = true;
    window.addEventListener("online", () => {
      if (this.stopped) return;
      this.state.attempts = 0;
      this.failing = 0;
      this.clearTimers();
      void this.connect();
    });
    window.addEventListener("offline", () => {
      this.set({ status: "offline" });
      this.closeSocket();
      this.clearTimers();
    });
    document.addEventListener("visibilitychange", () => {
      if (this.stopped || document.visibilityState !== "visible") return;
      if (!this.socket && !this.pollTimer) {
        this.state.attempts = 0;
        void this.connect();
      }
    });
  }

  // ---- endpoint + persistence -------------------------------------------

  private async resolveEndpoint(): Promise<string | null> {
    if (this.endpoint) return this.endpoint;
    if (typeof window === "undefined") return null;
    try {
      const res = await fetch("/api/health", { credentials: "include" });
      if (!res.ok) return null;
      const data = (await res.json()) as { realtime?: { path?: string; port?: number } };
      const path = typeof data.realtime?.path === "string" ? data.realtime.path : "/api/realtime";
      const port = Number(data.realtime?.port ?? 0);
      const secure = window.location.protocol === "https:";
      const samePort =
        !port ||
        String(port) === window.location.port ||
        (secure && port === 443) ||
        (!secure && port === 80);
      const proto = secure ? "wss:" : "ws:";
      const url = samePort ? `${proto}//${window.location.host}${path}` : `${proto}//${window.location.hostname}:${port}${path}`;
      this.endpoint = url;
      return url;
    } catch {
      return null;
    }
  }

  private readCursor(): number {
    try {
      const value = Number(window.localStorage.getItem(CURSOR_KEY) ?? 0);
      return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
    } catch {
      return 0;
    }
  }

  private writeCursor() {
    try {
      window.localStorage.setItem(CURSOR_KEY, String(this.state.cursor));
    } catch {
      /* storage unavailable */
    }
  }

  // ---- plumbing ----------------------------------------------------------

  private send(payload: Record<string, unknown>) {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    try {
      socket.send(JSON.stringify(payload));
    } catch {
      /* the close handler will reconnect */
    }
  }

  private set(partial: Partial<RealtimeState>) {
    this.state = { ...this.state, ...partial };
    this.emit();
  }

  private emit() {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        /* ignore */
      }
    }
  }
}

export const realtime = new RealtimeClient();

export function realtimeLabel(status: RealtimeStatus): string {
  switch (status) {
    case "connected":
      return "Connected";
    case "connecting":
      return "Connecting";
    case "reconnecting":
      return "Reconnecting";
    case "offline":
      return "Offline";
    case "syncing":
      return "Syncing";
    case "sync_error":
      return "Sync error";
    default:
      return "Unknown";
  }
}
