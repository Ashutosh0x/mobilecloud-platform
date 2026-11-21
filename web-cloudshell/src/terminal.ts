/**
 * Xterm.js Canvas / WebGL terminal surface (terminal doc §6.2).
 *
 * Owns the Terminal instance, the fit + WebGL addons, the resilient
 * CloudShellConnection, and the resize handshake driven by window resizes
 * (SIGWINCH propagation through the PTY gateway).
 */

import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { CloudShellConnection } from './connection';

export interface TerminalHandle {
  terminal: Terminal;
  fit: () => void;
  dispose: () => void;
}

/** CIDS-matched theme (Cyber-Institutional Design System, §1.1). */
const CIDS_THEME = {
  background: '#070A13',
  foreground: '#F8FAFC',
  cursor: '#38BDF8',
  selectionBackground: '#1E293B',
  green: '#34D399',
  cyan: '#38BDF8',
  blue: '#818CF8',
  red: '#EF4444',
  yellow: '#F59E0B',
} as const;

export function mountTerminal(
  container: HTMLElement,
  onStatus?: (status: import('./connection').ConnectionStatus) => void,
): TerminalHandle {
  const terminal = new Terminal({
    cursorBlink: true,
    fontSize: 14,
    fontFamily: 'JetBrains Mono, Menlo, Consolas, monospace',
    theme: CIDS_THEME,
    scrollback: 10_000,
    convertEol: false,
    allowProposedApi: true,
  });

  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.open(container);

  // Hardware-accelerated WebGL rendering with graceful Canvas fallback
  // (terminal doc §1.2: 60 FPS scrolling on the browser CloudShell).
  try {
    terminal.loadAddon(new WebglAddon());
  } catch {
    console.warn('WebGL unavailable — falling back to the Canvas renderer');
  }

  fitAddon.fit();

  const connection = new CloudShellConnection({
    cols: terminal.cols,
    rows: terminal.rows,
    onData: (bytes) => terminal.write(bytes),
    onStatus: (status) => {
      renderStatus(terminal, status);
      onStatus?.(status);
    },
  });

  // Keystrokes → PTY stdin.
  terminal.onData((data) => connection.sendInput(data));

  // Grid changes → TIOCSWINSZ (SIGWINCH) on the phone.
  terminal.onResize(({ cols, rows }) => connection.resize(cols, rows));

  const onWindowResize = () => {
    fitAddon.fit();
    connection.resize(terminal.cols, terminal.rows);
  };
  window.addEventListener('resize', onWindowResize);

  connection.connect();
  terminal.writeln(
    '\x1b[1;36m*** MobileCloud CloudShell — connecting to edge node ***\x1b[0m'
  );

  return {
    terminal,
    fit: () => fitAddon.fit(),
    dispose: () => {
      window.removeEventListener('resize', onWindowResize);
      connection.dispose();
      terminal.dispose();
    },
  };
}

function renderStatus(terminal: Terminal, status: string): void {
  const messages: Record<string, string> = {
    open: '\x1b[1;32m*** Connected (Snapdragon 8 Elite ARM64 · tmux session attached) ***\x1b[0m\r\n',
    connecting: '\x1b[33m… connecting\x1b[0m\r\n',
    reconnecting: '\x1b[33m*** connection lost — auto-reconnecting (backoff) ***\x1b[0m\r\n',
    closed: '\x1b[31m*** session closed ***\x1b[0m\r\n',
  };
  terminal.write(messages[status] ?? '');
}
