/**
 * CloudShell toolbar panels: a file manager and a web-preview picker.
 *
 * Both panels talk to the phone's operator API through `api.ts`. The UI is
 * deliberately plain DOM — the terminal owns the viewport, and a framework
 * would fight the xterm canvas for layout.
 */

import {
  createPreviewSession,
  deleteFile,
  downloadUrl,
  formatBytes,
  listFiles,
  listPreviewPorts,
  uploadFile,
  type DirectoryListing,
} from './api';

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function formatTime(seconds: number): string {
  if (!seconds) return '';
  const date = new Date(seconds * 1000);
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** A drawer that slides up over the terminal. */
export class Panel {
  readonly root: HTMLDivElement;
  private readonly body: HTMLDivElement;
  private readonly titleNode: HTMLSpanElement;
  private open = false;

  constructor(
    label: string,
    private readonly onClose: () => void,
  ) {
    this.root = element('div', 'panel');
    this.root.hidden = true;

    const head = element('div', 'panel-head');
    this.titleNode = element('span', 'panel-title', label);
    const close = element('button', 'panel-close', '✕');
    close.type = 'button';
    close.title = 'Close';
    close.addEventListener('click', () => this.onClose());
    head.append(this.titleNode, close);

    this.body = element('div', 'panel-body');
    this.root.append(head, this.body);
  }

  setTitle(text: string): void {
    this.titleNode.textContent = text;
  }

  setBody(node: HTMLElement): void {
    this.body.replaceChildren(node);
  }

  show(): void {
    this.open = true;
    this.root.hidden = false;
  }

  hide(): void {
    this.open = false;
    this.root.hidden = true;
  }

  toggle(): void {
    if (this.open) this.hide();
    else this.show();
  }

  get isOpen(): boolean {
    return this.open;
  }
}

/**
 * File manager over the phone's workspace: browse, upload, download, delete.
 */
export class FilesPanel extends Panel {
  private path = '';
  private listing: DirectoryListing | null = null;

  constructor(onClose: () => void) {
    super('Files', onClose);
    void this.refresh();
  }

  private async refresh(): Promise<void> {
    const body = element('div', 'panel-loading', 'Loading…');
    this.setBody(body);
    try {
      this.listing = await listFiles(this.path);
      this.render();
    } catch (error) {
      this.setBody(
        element('div', 'panel-error', error instanceof Error ? error.message : 'Listing failed'),
      );
    }
  }

  private render(): void {
    const listing = this.listing;
    if (!listing) return;
    this.setTitle(`Files · ${listing.path || '/'}`);

    const bar = element('div', 'panel-toolbar');

    const up = element('button', 'ghost', '↑ Up');
    up.type = 'button';
    up.disabled = !listing.parent && listing.path !== '';
    up.addEventListener('click', () => {
      this.path = listing.parent;
      void this.refresh();
    });

    const refresh = element('button', 'ghost', '⟳');
    refresh.type = 'button';
    refresh.title = 'Refresh';
    refresh.addEventListener('click', () => void this.refresh());

    const upload = element('label', 'ghost', '↑ Upload');
    const input = element('input');
    input.type = 'file';
    input.multiple = true;
    input.hidden = true;
    input.addEventListener('change', () => {
      const files = Array.from(input.files ?? []);
      if (files.length === 0) return;
      void this.uploadAll(files);
    });
    upload.append(input);

    bar.append(up, refresh, upload);

    const list = element('div', 'file-list');
    if (listing.entries.length === 0) {
      list.append(element('div', 'panel-empty', 'This folder is empty.'));
    }
    for (const entry of listing.entries) {
      list.append(this.renderEntry(entry, listing));
    }

    this.setBody(element('div', 'panel-inner', ''));
    const inner = this.root.querySelector('.panel-inner') as HTMLDivElement;
    inner.append(bar, list);
  }

  private renderEntry(
    entry: { name: string; directory: boolean; size: number; modified: number },
    listing: DirectoryListing,
  ): HTMLElement {
    const row = element('div', 'file-row');
    const icon = element('span', 'file-icon', entry.directory ? '▸' : '·');
    const name = element('span', 'file-name', entry.name);
    name.title = entry.name;
    const meta = element(
      'span',
      'file-meta',
      entry.directory ? 'folder' : `${formatBytes(entry.size)} · ${formatTime(entry.modified)}`,
    );

    const actions = element('span', 'file-actions');
    if (entry.directory) {
      const open = element('button', 'ghost', 'Open');
      open.type = 'button';
      open.addEventListener('click', () => {
        this.path = listing.path ? `${listing.path}/${entry.name}` : entry.name;
        void this.refresh();
      });
      actions.append(open);
    } else {
      const download = element('button', 'ghost', 'Get');
      download.type = 'button';
      download.addEventListener('click', () => {
        const full = listing.path ? `${listing.path}/${entry.name}` : entry.name;
        window.open(downloadUrl(full), '_blank', 'noopener');
      });
      actions.append(download);
    }

    const remove = element('button', 'ghost danger', '✕');
    remove.type = 'button';
    remove.title = 'Delete';
    remove.addEventListener('click', () => {
      const full = listing.path ? `${listing.path}/${entry.name}` : entry.name;
      void this.remove(full, entry.name);
    });
    actions.append(remove);

    row.append(icon, name, meta, actions);
    return row;
  }

  private async uploadAll(files: File[]): Promise<void> {
    const directory = this.path;
    for (const file of files) {
      const target = directory ? `${directory}/${file.name}` : file.name;
      try {
        await uploadFile(target, file);
      } catch (error) {
        this.setBody(
          element(
            'div',
            'panel-error',
            error instanceof Error ? error.message : `Upload of ${file.name} failed`,
          ),
        );
        return;
      }
    }
    await this.refresh();
  }

  private async remove(path: string, name: string): Promise<void> {
    if (!window.confirm(`Delete ${name}? This cannot be undone.`)) return;
    try {
      await deleteFile(path);
    } catch (error) {
      this.setBody(
        element('div', 'panel-error', error instanceof Error ? error.message : 'Delete failed'),
      );
      return;
    }
    await this.refresh();
  }
}

/**
 * Web preview: expose a dev server that runs on the phone to this browser,
 * the way Google Cloud Shell exposes `localhost:8080`.
 */
export class PreviewPanel extends Panel {
  constructor(onClose: () => void) {
    super('Preview', onClose);
    void this.refresh();
  }

  private async refresh(): Promise<void> {
    const body = element('div', 'panel-loading', 'Scanning for dev servers…');
    this.setBody(body);

    const inner = element('div', 'panel-inner');
    const list = element('div', 'port-list');
    const manual = element('div', 'panel-toolbar');

    const input = element('input', 'port-input');
    input.type = 'number';
    input.min = '1024';
    input.max = '65535';
    input.placeholder = 'port';
    input.setAttribute('aria-label', 'Port');

    const open = element('button', 'primary', 'Open preview');
    open.type = 'button';
    open.addEventListener('click', () => {
      const port = Number(input.value);
      if (Number.isFinite(port) && port > 0) void this.openPreview(port);
    });

    manual.append(input, open);
    inner.append(manual, list);
    this.setBody(inner);

    try {
      const ports = await listPreviewPorts();
      if (ports.length === 0) {
        list.append(
          element('div', 'panel-empty', 'No dev server is listening. Start one in the terminal.'),
        );
        return;
      }
      for (const port of ports) {
        const row = element('div', 'port-row');
        const label = element('span', 'port-label', `127.0.0.1:${port}`);
        const button = element('button', 'ghost', 'Open');
        button.type = 'button';
        button.addEventListener('click', () => void this.openPreview(port));
        row.append(label, button);
        list.append(row);
      }
    } catch (error) {
      list.replaceChildren(
        element(
          'div',
          'panel-error',
          error instanceof Error ? error.message : 'Could not scan for dev servers',
        ),
      );
    }
  }

  private async openPreview(port: number): Promise<void> {
    try {
      const session = await createPreviewSession(port);
      window.open(session.url, '_blank', 'noopener');
    } catch (error) {
      this.setBody(
        element('div', 'panel-error', error instanceof Error ? error.message : 'Preview failed'),
      );
    }
  }
}
