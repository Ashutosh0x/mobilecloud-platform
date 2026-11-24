/**
 * Browser ↔ phone PTY transport.
 *
 * The gateway (core-engine `terminal/ws`) speaks:
 *   inbound  : binary frames = raw keystrokes, text frames = JSON control
 *              (`{"type":"resize","cols":80,"rows":24}`)
 *   outbound : binary frames = raw PTY bytes
 *
 * Authentication is a short-lived, single-use *ticket* minted by an
 * operator-authenticated endpoint. The static operator token must never reach
 * browser JavaScript, and the gateway refuses browser handshakes that do not
 * present both an allowed `Origin` and a fresh ticket.
 */

export type ConnectionStatus =
  | 'idle'
  | 'connecting'
  | 'open'
  | 'reconnecting'
  | 'closed'
  | 'error';

export interface Endpoint {
  /** Absolute `ws://` or `wss://` URL of `/terminal/ws`. */
  gateway: string;
  /** Absolute or same-origin URL that mints a one-use ticket. */
  ticket: string;
  /** Optional sub-protocols offered during the handshake. */
  protocols: string[];
}

interface EndpointOverrides {
  gateway?: string;
  ticket?: string;
}

export interface ConnectionHandlers {
  onData: (data: Uint8Array) => void;
  onStatus: (status: ConnectionStatus, detail?: string) => void;
  onExit: (reason: string) => void;
}

const DEFAULT_PROTOCOLS = ['mobilecloud.terminal.v1'];
const MAX_ATTEMPTS = 8;

function meta(name: string): string | null {
  const element = document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`);
  return element?.content?.trim() || null;
}

function globalOverrides(): EndpointOverrides {
  const value = (globalThis as { MOBILECLOUD_TERMINAL?: EndpointOverrides })
    .MOBILECLOUD_TERMINAL;
  return value && typeof value === 'object' ? value : {};
}

function httpBase(): string {
  const protocol = location.protocol === 'https:' ? 'https:' : 'http:';
  return `${protocol}//${location.host}`;
}

function toWebSocket(raw: string): string {
  const url = new URL(raw, httpBase());
  if (url.protocol === 'http:') url.protocol = 'ws:';
  if (url.protocol === 'https:') url.protocol = 'wss:';
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new Error(`terminal gateway must be ws:// or wss://, got ${url.protocol}`);
  }
  return url.toString();
}

/**
 * Resolve the gateway/ticket endpoints from (highest priority first):
 *   1. `globalThis.MOBILECLOUD_TERMINAL`
 *   2. `<meta name="mobilecloud-terminal-gateway">` / `…-ticket`
 *   3. same-origin defaults (`/terminal/ws`, `/terminal/ticket`)
 */
export function resolveEndpoint(overrides: EndpointOverrides = {}): Endpoint {
  const configured = { ...globalOverrides(), ...overrides };
  const gateway =
    configured.gateway ??
    meta('mobilecloud-terminal-gateway') ??
    `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/terminal/ws`;
  const ticket =
    configured.ticket ??
    meta('mobilecloud-terminal-ticket') ??
    `${httpBase()}/terminal/ticket`;
  return {
    gateway: toWebSocket(gateway),
    ticket: new URL(ticket, httpBase()).toString(),
    protocols: DEFAULT_PROTOCOLS,
  };
}

async function fetchTicket(endpoint: Endpoint): Promise<string> {
  const response = await fetch(endpoint.ticket, {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`ticket endpoint returned ${response.status}`);
  }
  const payload = (await response.json()) as { ticket?: unknown };
  if (typeof payload.ticket !== 'string' || !/^[0-9a-f]{64}$/i.test(payload.ticket)) {
    throw new Error('ticket endpoint returned an invalid ticket');
  }
  return payload.ticket;
}

export class TerminalConnection {
  private socket: WebSocket | null = null;
  private endpoint: Endpoint;
  private handlers: ConnectionHandlers;
  private attempt = 0;
  private disposed = false;
  private reconnectTimer: number | null = null;
  private hasOpened = false;
  private status: ConnectionStatus = 'idle';
  private pendingResize: { cols: number; rows: number } | null = null;

  constructor(handlers: ConnectionHandlers, endpoint?: Endpoint) {
    this.handlers = handlers;
    this.endpoint = endpoint ?? resolveEndpoint();
  }

  get currentStatus(): ConnectionStatus {
    return this.status;
  }

  private emit(status: ConnectionStatus, detail?: string) {
    this.status = status;
    this.handlers.onStatus(status, detail);
  }

  async connect(): Promise<void> {
    if (this.disposed) return;
    this.emit(this.hasOpened ? 'reconnecting' : 'connecting');
    let ticket: string;
    try {
      ticket = await fetchTicket(this.endpoint);
    } catch (error) {
      this.fail(error instanceof Error ? error.message : 'could not obtain a terminal ticket');
      return;
    }
    if (this.disposed) return;

    const url = new URL(this.endpoint.gateway);
    url.searchParams.set('ticket', ticket);

    let socket: WebSocket;
    try {
      socket = new WebSocket(url.toString(), this.endpoint.protocols);
    } catch (error) {
      this.fail(error instanceof Error ? error.message : 'could not open the terminal socket');
      return;
    }
    socket.binaryType = 'arraybuffer';
    this.socket = socket;

    socket.addEventListener('open', () => {
      if (this.socket !== socket) return;
      this.attempt = 0;
      this.hasOpened = true;
      this.emit('open');
      if (this.pendingResize) {
        this.sendResize(this.pendingResize.cols, this.pendingResize.rows);
        this.pendingResize = null;
      }
    });

    socket.addEventListener('message', (event) => {
      if (this.socket !== socket) return;
      if (event.data instanceof ArrayBuffer) {
        this.handlers.onData(new Uint8Array(event.data));
      } else if (typeof event.data === 'string') {
        // Server-side notices (for example "terminal unavailable").
        this.handlers.onData(new TextEncoder().encode(event.data));
      }
    });

    socket.addEventListener('error', () => {
      // `close` always follows and carries the policy decision, so the status
      // transition is handled there.
    });

    socket.addEventListener('close', (event) => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (this.disposed) {
        this.emit('closed');
        return;
      }
      if (event.code === 1000 && event.wasClean) {
        this.emit('closed');
        this.handlers.onExit('session closed');
        return;
      }
      this.scheduleReconnect(
        event.code === 4401 || event.code === 4403
          ? 'terminal authorization was refused'
          : `socket closed (${event.code || 'network'})`,
      );
    });
  }

  private scheduleReconnect(reason: string) {
    if (this.disposed) return;
    this.attempt += 1;
    if (this.attempt > MAX_ATTEMPTS) {
      this.emit('error', reason);
      this.handlers.onExit(reason);
      return;
    }
    this.emit('reconnecting', reason);
    const backoff = Math.min(8000, 400 * 2 ** (this.attempt - 1));
    const jitter = Math.floor(Math.random() * 250);
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, backoff + jitter);
  }

  private fail(reason: string) {
    this.emit('error', reason);
    this.handlers.onExit(reason);
  }

  sendInput(data: string | Uint8Array) {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    if (bytes.byteLength === 0) return;
    this.socket.send(bytes);
  }

  sendResize(cols: number, rows: number) {
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) return;
    const frame = {
      type: 'resize',
      cols: Math.max(1, Math.min(500, Math.trunc(cols))),
      rows: Math.max(1, Math.min(500, Math.trunc(rows))),
    };
    if (this.socket?.readyState !== WebSocket.OPEN) {
      this.pendingResize = { cols: frame.cols, rows: frame.rows };
      return;
    }
    this.socket.send(JSON.stringify(frame));
  }

  close() {
    this.disposed = true;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState <= WebSocket.OPEN) {
      try {
        socket.close(1000, 'client closed');
      } catch {
        // Already closing.
      }
    }
    this.emit('closed');
  }

  /** Drop the current socket (if any) and immediately open a new one. */
  restart() {
    if (this.disposed) return;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState <= WebSocket.OPEN) {
      try {
        socket.close(1000, 'restart');
      } catch {
        // Already closing.
      }
    }
    this.attempt = 0;
    this.pendingResize = null;
    void this.connect();
  }
}
