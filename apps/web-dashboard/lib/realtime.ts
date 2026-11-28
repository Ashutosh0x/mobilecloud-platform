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

/** Every event type the domain lifecycle can emit (see the spec §11.2). */
export const DOMAIN_EVENT_TYPES = [
  "domain.created",
  "domain.dns_pending",
  "domain.dns_verified",
  "domain.dns_failed",
  "domain.ssl_provisioning",
  "domain.ssl_active",
  "domain.ssl_failed",
  "domain.ssl_renewing",
  "domain.ssl_renewed",
  "domain.health_changed",
  "domain.deleted",
  "domain.suspended",
] as const;

export type DomainEventType = (typeof DOMAIN_EVENT_TYPES)[number];

/**
 * The domain payloads carried inside the standard envelope. Ordering,
 * de-duplication (by `event_id`) and gap recovery (by `sequence`) are handled
 * by the client below — this union only describes what a domain event means.
 */
export type DomainEvent =
  | { type: "domain.created"; domainId: string; host: string; project: string }
  | { type: "domain.dns_pending"; domainId: string }
  | { type: "domain.dns_verified"; domainId: string; verifiedAt: number }
  | { type: "domain.dns_failed"; domainId: string; error: string }
  | { type: "domain.ssl_provisioning"; domainId: string }
  | { type: "domain.ssl_active"; domainId: string; expiresAt: number }
  | { type: "domain.ssl_failed"; domainId: string; error: string }
  | { type: "domain.ssl_renewing"; domainId: string }
  | { type: "domain.ssl_renewed"; domainId: string; expiresAt: number }
  | { type: "domain.health_changed"; domainId: string; healthy: boolean }
  | { type: "domain.deleted"; domainId: string }
  | { type: "domain.suspended"; domainId: string; reason: string };

const DOMAIN_TYPES: readonly string[] = DOMAIN_EVENT_TYPES;

/** Narrows any envelope to a domain envelope without trusting the payload shape. */
export function isDomainEvent(event: RealtimeEvent): event is RealtimeEvent & { event_type: DomainEventType } {
  return DOMAIN_TYPES.includes(event.event_type);
}

/** The domain id a domain event refers to (`resource_id` first, payload fallback). */
export function domainEventId(event: RealtimeEvent): string | null {
  if (event.resource_id) return event.resource_id;
  const value = event.payload?.domainId;
  return typeof value === "string" ? value : null;
}

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
  private recovery: AbortController | null = null;
  private connectionAttempt = 0;
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

  start(accountId: string) {
    if (typeof window === "undefined") return;
    if (this.started && this.state.accountId === accountId) return;
    if (this.state.accountId !== accountId) this.reset();
    this.started = true;
    this.stopped = false;
    this.attachNetworkListeners();
    this.state.accountId = accountId;
    this.state.cursor = this.readCursor();
    void this.connect();
  }

  stop() {
    this.stopped = true;
    this.started = false;
    this.connectionAttempt += 1;
    this.recovery?.abort();
    this.recovery = null;
    this.clearTimers();
    this.closeSocket();
  }

  reset() {
    this.stop();
    this.endpoint = null;
    this.failing = 0;
    this.seen.clear();
    this.seenOrder = [];
    this.state = emptyState();
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

  private async connect(probe = false) {
    if (this.stopped || this.socket) return;
    const attempt = ++this.connectionAttempt;
    this.set({
      status: this.state.attempts > 0 ? "reconnecting" : "connecting",
    });

    if (!probe && this.shouldPoll()) {
      this.startPolling();
      return;
    }

    const url = await this.resolveEndpoint();
    if (this.stopped || this.connectionAttempt !== attempt || this.socket) return;
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
      if (this.socket === socket) {
        this.closeSocket();
        this.fail("The realtime handshake timed out.");
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
        if (message.account_id !== this.state.accountId || !Number.isSafeInteger(serverCursor) || serverCursor < 0) {
          this.closeSocket();
          this.fail("The realtime server returned an unexpected account or cursor.");
          return;
        }
        this.stopPolling();
        this.failing = 0;
        this.set({
          status: "connected",
          accountName: typeof message.account_name === "string" ? message.account_name : null,
          attempts: 0,
          lastError: null,
          lastSyncAt: Date.now(),
          serverStatus: "online",
        });
        // No `types` means "every event type" (the gateway default).
        this.send({ type: "subscribe" });
        this.startHeartbeat();
        if (this.state.cursor > 0 && serverCursor > this.state.cursor) void this.recover();
        else if (this.state.cursor === 0) {
          this.set({ cursor: serverCursor });
          this.writeCursor();
        }
        break;
      }
      case "event": {
        const envelope = (message.event ?? message.payload) as RealtimeEvent | undefined;
        if (envelope && typeof envelope.event_id === "string") {
          if (envelope.event_type === "server.status_changed") {
            this.set({ serverStatus: envelope.payload.status === "online" ? "online" : "offline" });
          } else {
            this.apply(envelope);
          }
        }
        break;
      }
      case "replay_start":
        this.set({ status: "syncing" });
        break;
      case "replay_complete": {
        const cursor = Number(message.cursor);
        if (!this.recovery && Number.isSafeInteger(cursor) && cursor >= this.state.cursor) {
          this.set({ status: "connected", cursor, lastSyncAt: Date.now() });
          this.writeCursor();
        }
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
    if (envelope.account_id !== this.state.accountId || this.seen.has(envelope.event_id)) return;
    this.seen.add(envelope.event_id);
    this.seenOrder.push(envelope.event_id);
    if (this.seenOrder.length > SEEN_LIMIT) {
      const dropped = this.seenOrder.splice(0, this.seenOrder.length - SEEN_LIMIT);
      for (const id of dropped) this.seen.delete(id);
    }

    const sequence = Number(envelope.sequence ?? 0);
    if (!this.recovery && Number.isSafeInteger(sequence) && sequence > this.state.cursor) {
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

  private async recover() {
    if (this.recovery || this.stopped) return;
    const controller = new AbortController();
    this.recovery = controller;
    let cursor = this.state.cursor;
    if (this.state.transport !== "poll" || this.state.lastSyncAt === null) this.set({ status: "syncing" });
    try {
      for (let guard = 0; guard < 40; guard += 1) {
        const res = await fetch(`/api/sync/changes?cursor=${cursor}&limit=${RECOVERY_PAGE}`, {
          credentials: "include",
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        if (res.status === 401) {
          this.stop();
          this.set({ status: "sync_error", lastError: "Your session expired. Sign in again." });
          return;
        }
        if (!res.ok) throw new Error(`Sync failed (${res.status})`);
        const page = (await res.json()) as { events: RealtimeEvent[]; cursor: number; more: boolean; latest: number };
        if (controller.signal.aborted) return;
        if (!Number.isSafeInteger(page.cursor) || page.cursor < cursor || (page.more && page.cursor === cursor)) throw new Error("Invalid replay cursor.");
        for (const event of page.events) this.apply(event);
        cursor = page.cursor;
        this.set({ cursor });
        this.writeCursor();
        if (!page.more) {
          this.set({ status: "connected", lastError: null, lastSyncAt: Date.now(), pending: 0 });
          return;
        }
      }
      throw new Error("A replay backlog remains; retrying from the last page.");
    } catch (error) {
      if (!controller.signal.aborted) this.set({
        status: "sync_error",
        lastError: error instanceof Error ? error.message : "Could not synchronise missed changes.",
      });
    } finally {
      if (this.recovery === controller) this.recovery = null;
    }
  }

  // ---- fallback: bounded polling ----------------------------------------

  private shouldPoll(): boolean {
    return this.failing >= POLL_FALLBACK_AFTER || typeof WebSocket === "undefined";
  }

  private startPolling() {
    if (this.pollTimer) return;
    this.set({ transport: "poll", status: "syncing" });
    let nextProbeAt = Date.now() + POLL_MS * 6;
    const tick = () => {
      if (this.stopped) return;
      void this.recover();
      if (!this.socket && typeof WebSocket !== "undefined" && Date.now() >= nextProbeAt) {
        nextProbeAt = Date.now() + POLL_MS * 6;
        void this.connect(true);
      }
    };
    this.pollTimer = setInterval(tick, POLL_MS);
    tick();
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
      const endpoint = new URL(window.location.origin);
      endpoint.pathname = data.realtime?.path ?? "/api/realtime";
      const secure = endpoint.protocol === "https:";
      endpoint.protocol = secure ? "wss:" : "ws:";
      const port = Number(data.realtime?.port ?? 0);
      if (!secure && Number.isInteger(port) && port > 0 && port <= 65535) endpoint.port = String(port);
      const url = endpoint.toString();
      this.endpoint = url;
      return url;
    } catch {
      return null;
    }
  }

  private readCursor(): number {
    try {
      const value = Number(window.localStorage.getItem(`${CURSOR_KEY}.${this.state.accountId}`) ?? 0);
      return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
    } catch {
      return 0;
    }
  }

  private writeCursor() {
    try {
      if (this.state.accountId) window.localStorage.setItem(`${CURSOR_KEY}.${this.state.accountId}`, String(this.state.cursor));
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
