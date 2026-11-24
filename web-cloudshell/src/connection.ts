/**
 * Resilient auto-reconnecting WebSocket transport for the Web CloudShell
 * (terminal doc §1.2 + §6.2).
 *
 * Protocol against the Rust gateway (`core-engine` ws_handler):
 *   client → server : {"type":"input","data":"…"} | {"type":"resize","cols":C,"rows":R}
 *   server → client : binary frames of raw PTY bytes
 *
 * Reconnection policy: exponential backoff (0.5s → 8s cap) with jitter so a
 * phone toggling Wi-Fi ↔ 5G doesn't stampede the tunnel. Incoming binary
 * chunks are handed to `onData` as `Uint8Array` exactly once, in order.
 */

export type ConnectionStatus =
  | 'connecting'
  | 'open'
  | 'closed'
  | 'reconnecting';

export interface CloudShellConnectionOptions {
  /** Override the websocket URL (defaults to the serving origin). */
  url?: string;
  /** Terminal credential; falls back to the page's `?token=` query param. */
  token?: string;
  /** Callback for ordered PTY output bytes. */
  onData: (bytes: Uint8Array) => void;
  /** Status transitions (for the UI indicator). */
  onStatus?: (status: ConnectionStatus) => void;
  /** Initial grid dimensions sent with the connection handshake. */
  cols: number;
  rows: number;
}

const MIN_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 8_000;

export class CloudShellConnection {
  private socket: WebSocket | null = null;
  private backoffMs = MIN_BACKOFF_MS;
  private reconnectTimer: number | null = null;
  private disposed = false;

  constructor(private readonly options: CloudShellConnectionOptions) {}

  /** Human/gateway-facing URL: wss:// when served over TLS, token-gated. */
  private endpoint(): string {
    const base =
      this.options.url ??
      `${location.protocol === 'https:' ? 'wss://' : 'ws://'}${location.host}/terminal/ws`;
    const token =
      this.options.token ?? new URLSearchParams(location.search).get('token') ?? undefined;
    if (!token) return base;
    const url = new URL(base, location.href);
    url.searchParams.set('token', token);
    return url.toString();
  }

  connect(): void {
    if (this.disposed) return;
    this.options.onStatus?.('connecting');
    const socket = new WebSocket(this.endpoint());
    socket.binaryType = 'arraybuffer';
    this.socket = socket;

    socket.onopen = () => {
      this.backoffMs = MIN_BACKOFF_MS;
      this.options.onStatus?.('open');
      // Announce the initial grid so the PTY spawns at the right size.
      this.resize(this.options.cols, this.options.rows);
    };

    socket.onmessage = (event: MessageEvent<ArrayBuffer | string>) => {
      if (typeof event.data === 'string') return; // control frames unused today
      this.options.onData(new Uint8Array(event.data));
    };

    socket.onclose = () => {
      if (this.disposed) {
        this.options.onStatus?.('closed');
        return;
      }
      this.scheduleReconnect();
    };

    socket.onerror = () => {
      // onclose follows; nothing else to do on error.
    };
  }

  private scheduleReconnect(): void {
    this.options.onStatus?.('reconnecting');
    const jitter = Math.random() * 0.3 * this.backoffMs;
    const delay = this.backoffMs + jitter;
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
    this.reconnectTimer = window.setTimeout(() => this.connect(), delay);
  }

  /** Force an immediate reconnect (e.g. after a network change). */
  reset(): void {
    this.teardownSocket();
    this.backoffMs = MIN_BACKOFF_MS;
    this.connect();
  }

  sendInput(data: string): void {
    this.send({ type: 'input', data });
  }

  resize(cols: number, rows: number): void {
    this.options.cols = cols;
    this.options.rows = rows;
    this.send({ type: 'resize', cols, rows });
  }

  private send(payload: unknown): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return; // silently drop while offline
    this.socket.send(JSON.stringify(payload));
  }

  private teardownSocket(): void {
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
      socket.close();
    }
  }

  dispose(): void {
    this.disposed = true;
    this.teardownSocket();
    this.options.onStatus?.('closed');
  }
}
