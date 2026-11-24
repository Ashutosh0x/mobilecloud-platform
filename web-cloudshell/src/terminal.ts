import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { TerminalConnection, resolveEndpoint, type ConnectionStatus } from './connection';

export interface TerminalHandle {
  terminal: Terminal;
  connection: TerminalConnection;
  fit: () => void;
  reconnect: () => void;
  dispose: () => void;
}

export interface MountOptions {
  fontSize?: number;
  scrollback?: number;
  /** Offer OSC 52 clipboard writes to the page (default: true). */
  allowClipboard?: boolean;
  onTitle?: (title: string) => void;
}

const THEME = {
  background: '#070A13',
  foreground: '#F8FAFC',
  cursor: '#38BDF8',
  cursorAccent: '#070A13',
  selectionBackground: '#1E3A5F',
  black: '#1E293B',
  red: '#F87171',
  green: '#34D399',
  yellow: '#FBBF24',
  blue: '#60A5FA',
  magenta: '#C084FC',
  cyan: '#22D3EE',
  white: '#E2E8F0',
  brightBlack: '#475569',
  brightRed: '#FCA5A5',
  brightGreen: '#6EE7B7',
  brightYellow: '#FDE68A',
  brightBlue: '#93C5FD',
  brightMagenta: '#D8B4FE',
  brightCyan: '#67E8F9',
  brightWhite: '#FFFFFF',
};

function decodeBase64(value: string): Uint8Array | null {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

export function mountTerminal(
  container: HTMLElement,
  onStatus?: (status: ConnectionStatus, detail?: string) => void,
  options: MountOptions = {},
): TerminalHandle {
  const terminal = new Terminal({
    disableStdin: false,
    allowProposedApi: true,
    convertEol: false,
    cursorBlink: true,
    cursorStyle: 'block',
    drawBoldTextInBrightColors: true,
    fontSize: options.fontSize ?? 14,
    fontFamily: "'JetBrains Mono', Menlo, Consolas, 'Courier New', monospace",
    fontWeight: '400',
    fontWeightBold: '700',
    letterSpacing: 0,
    lineHeight: 1.15,
    scrollback: options.scrollback ?? 10_000,
    smoothScrollDuration: 0,
    scrollOnUserInput: true,
    theme: THEME,
    windowsMode: false,
  });

  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.open(container);

  // WebGL is the fast path; a lost context falls back to the DOM renderer.
  let webgl: WebglAddon | null = null;
  try {
    webgl = new WebglAddon();
    webgl.onContextLoss(() => {
      webgl?.dispose();
      webgl = null;
    });
    terminal.loadAddon(webgl);
  } catch {
    webgl = null;
  }

  const fit = () => {
    try {
      fitAddon.fit();
    } catch {
      // Container not laid out yet; the ResizeObserver retries.
    }
  };

  const connection = new TerminalConnection(
    {
      onData: (data) => terminal.write(data),
      onStatus: (status, detail) => {
        onStatus?.(status, detail);
        if (status === 'reconnecting') {
          terminal.write(`\r\n\x1b[33m[reconnecting: ${detail ?? 'network'}]\x1b[0m\r\n`);
        } else if (status === 'error') {
          terminal.write(`\r\n\x1b[31m[terminal error: ${detail ?? 'unavailable'}]\x1b[0m\r\n`);
        }
      },
      onExit: (reason) => {
        terminal.write(`\r\n\x1b[90m[session ended: ${reason}]\x1b[0m\r\n`);
      },
    },
    resolveEndpoint(),
  );

  terminal.onData((data) => connection.sendInput(data));
  terminal.onBinary((data) => {
    const bytes = new Uint8Array(data.length);
    for (let i = 0; i < data.length; i += 1) bytes[i] = data.charCodeAt(i) & 0xff;
    connection.sendInput(bytes);
  });
  terminal.onResize(({ cols, rows }) => connection.sendResize(cols, rows));

  terminal.onTitleChange((title) => options.onTitle?.(title));

  // OSC 52: applications running on the phone can place text on the browser
  // clipboard. Writes require page focus, mirroring xterm.js security posture.
  terminal.parser.registerOscHandler(52, (data) => {
    const allowClipboard = options.allowClipboard ?? true;
    if (!allowClipboard || !document.hasFocus()) return false;
    const separator = data.indexOf(';');
    if (separator < 0) return false;
    const selector = data.slice(0, separator);
    if (selector !== 'c' && selector !== '') return false;
    const decoded = decodeBase64(data.slice(separator + 1));
    if (!decoded) return false;
    const text = new TextDecoder().decode(decoded);
    void navigator.clipboard?.writeText(text).catch(() => undefined);
    return true;
  });

  // Ctrl/Cmd+Shift+C copies a selection; Ctrl/Cmd+Shift+V pastes (xterm then
  // wraps the paste in bracketed-paste markers when the app asked for them).
  terminal.attachCustomKeyEventHandler((event) => {
    if (event.type !== 'keydown') return true;
    const modifier = event.ctrlKey || event.metaKey;
    if (!modifier || !event.shiftKey) return true;
    if (event.key.toLowerCase() === 'c' && terminal.hasSelection()) {
      void navigator.clipboard?.writeText(terminal.getSelection()).catch(() => undefined);
      terminal.clearSelection();
      return false;
    }
    if (event.key.toLowerCase() === 'v') {
      void navigator.clipboard
        ?.readText()
        .then((text) => terminal.paste(text))
        .catch(() => undefined);
      return false;
    }
    return true;
  });

  const observer = new ResizeObserver(() => {
    window.requestAnimationFrame(fit);
  });
  observer.observe(container);
  window.addEventListener('resize', fit);
  window.requestAnimationFrame(() => {
    fit();
    void connection.connect();
  });

  return {
    terminal,
    connection,
    fit,
    reconnect: () => {
      connection.restart();
    },
    dispose: () => {
      observer.disconnect();
      window.removeEventListener('resize', fit);
      connection.close();
      webgl?.dispose();
      terminal.dispose();
    },
  };
}
