/**
 * CloudShell operator API client.
 *
 * Every call is same-origin: the page is served by the same gateway that
 * fronts the phone's engine, and the gateway attaches the operator
 * credential. The browser never holds that credential, so it cannot be
 * replayed from anywhere else.
 */

export interface FileEntry {
  name: string;
  directory: boolean;
  size: number;
  modified: number;
}

export interface DirectoryListing {
  path: string;
  parent: string;
  entries: FileEntry[];
}

export interface PreviewSession {
  port: number;
  url: string;
  expires_in: number;
}

async function readError(response: Response, fallback: string): Promise<string> {
  try {
    const text = await response.text();
    return text.trim() || fallback;
  } catch {
    return fallback;
  }
}

async function request(path: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    cache: 'no-store',
    ...init,
    headers: {
      accept: 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  if (!response.ok) {
    throw new Error(await readError(response, `${init?.method ?? 'GET'} ${path} failed (${response.status})`));
  }
  return response;
}

/** List a directory inside the phone workspace. */
export async function listFiles(path = ''): Promise<DirectoryListing> {
  const response = await request(`/api/v1/terminal/files?path=${encodeURIComponent(path)}`);
  return (await response.json()) as DirectoryListing;
}

/** Upload one file into the workspace at `path`. */
export async function uploadFile(path: string, file: File): Promise<void> {
  const response = await request(`/api/v1/terminal/upload?path=${encodeURIComponent(path)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: file,
  });
  await response.json();
}

/** Remove a file or directory. */
export async function deleteFile(path: string): Promise<void> {
  const response = await request(`/api/v1/terminal/file?path=${encodeURIComponent(path)}`, {
    method: 'DELETE',
  });
  await response.json();
}

/** The URL a browser should use to download `path`. */
export function downloadUrl(path: string): string {
  return `/api/v1/terminal/download?path=${encodeURIComponent(path)}`;
}

/** Loopback ports that currently have a dev server listening. */
export async function listPreviewPorts(): Promise<number[]> {
  const response = await request('/api/v1/preview/ports');
  const payload = (await response.json()) as { ports?: number[] };
  return payload.ports ?? [];
}

/**
 * Mint a preview session and return the URL that exposes the loopback dev
 * server to the browser.
 */
export async function createPreviewSession(port: number): Promise<PreviewSession> {
  const response = await request(`/api/v1/preview/session?port=${port}`, { method: 'POST' });
  return (await response.json()) as PreviewSession;
}

/** Human-readable byte size. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || Number.isInteger(value) ? 0 : 1)} ${units[unit]}`;
}
