import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { ConnectionStatus } from './connection';

export interface TerminalHandle {
  terminal: Terminal;
  fit: () => void;
  dispose: () => void;
}

export function mountTerminal(
  container: HTMLElement,
  onStatus?: (status: ConnectionStatus) => void,
): TerminalHandle {
  const terminal = new Terminal({
    disableStdin: true,
    fontSize: 14,
    fontFamily: 'JetBrains Mono, Menlo, Consolas, monospace',
    theme: { background: '#070A13', foreground: '#F8FAFC' },
  });
  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.open(container);
  const fit = () => fitAddon.fit();
  window.addEventListener('resize', fit);
  fit();
  terminal.writeln('Browser CloudShell is disabled. Use an approved local terminal client.');
  onStatus?.('disabled');

  return {
    terminal,
    fit,
    dispose: () => {
      window.removeEventListener('resize', fit);
      terminal.dispose();
    },
  };
}
