import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { newId, tokenHash } from "./db.ts";
import { tx } from "./events.ts";

/**
 * GitHub integration: OAuth, repository access and webhooks.
 *
 * The control plane connects to GitHub two ways:
 *
 *   - **OAuth** — an account links its GitHub identity, the platform keeps the
 *     token sealed at rest, and repositories are listed through the API.
 *   - **Webhooks** — GitHub posts push, pull request and release events, and
 *     the platform turns them into builds. Every delivery is checked against
 *     the shared secret with a constant-time comparison.
 *
 * Nothing here is enabled unless the operator configures it: without a
 * client id and secret the connect endpoints refuse, and a webhook without a
 * secret is rejected outright.
 */

const AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const API = "https://api.github.com";
const USER_AGENT = "MobileCloud";
const STATE_TTL_MS = 10 * 60_000;

/** The scopes the platform asks for. */
export const GITHUB_SCOPES = ["repo", "read:user", "user:email", "read:org"];

export class GitHubError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type GitHubConfig = {
  clientId: string;
  clientSecret: string;
  webhookSecret: string;
};

export function githubConfig(): GitHubConfig | null {
  const clientId = (process.env.GITHUB_CLIENT_ID ?? "").trim();
  const clientSecret = (process.env.GITHUB_CLIENT_SECRET ?? "").trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret, webhookSecret: (process.env.GITHUB_WEBHOOK_SECRET ?? "").trim() };
}

/** The public origin GitHub redirects back to. */
function callbackUri(): string {
  const origin = (process.env.MOBILECLOUD_PUBLIC_ORIGIN ?? "").trim().replace(/\/+$/, "");
  if (!origin) throw new GitHubError(503, "MOBILECLOUD_PUBLIC_ORIGIN is not configured.");
  return `${origin}/api/github/callback`;
}

// ---------------------------------------------------------------------------
// Token sealing
// ---------------------------------------------------------------------------

/**
 * The master key that seals third-party credentials.
 *
 * It is generated once, on first use, and kept in the database beside the
 * tokens it protects. The point is not to survive a database compromise — it
 * does not — but to keep a plain dump of the control plane from handing over
 * a GitHub token.
 */
function masterKey(db: DatabaseSync): Buffer {
  const row = db.prepare("SELECT value FROM secrets WHERE name = 'github_token_key'").get() as { value: string } | undefined;
  if (row) return Buffer.from(row.value, "hex");
  const key = randomBytes(32);
  db.prepare("INSERT INTO secrets (name, value, created_at) VALUES ('github_token_key', ?, ?)").run(key.toString("hex"), Date.now());
  return key;
}

/** Seals a token with AES-256-GCM. The output is safe to store as text. */
export function sealSecret(db: DatabaseSync, plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey(db), iv);
  const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${encrypted.toString("base64url")}`;
}

/** Opens a sealed token. A token that does not authenticate is discarded. */
export function openSecret(db: DatabaseSync, sealed: string): string | null {
  try {
    const [iv, tag, payload] = sealed.split(".");
    if (!iv || !tag || !payload) return null;
    const decipher = createDecipheriv("aes-256-gcm", masterKey(db), Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(payload, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------

/** Creates the state that binds an authorization to the browser that began it. */
export function beginAuthorization(db: DatabaseSync, ownerId: string): string {
  const state = randomBytes(24).toString("base64url");
  db.prepare("DELETE FROM oauth_states WHERE expires_at <= ?").run(Date.now());
  db.prepare("INSERT INTO oauth_states (state, owner_id, created_at, expires_at) VALUES (?, ?, ?, ?)").run(
    state,
    ownerId,
    Date.now(),
    Date.now() + STATE_TTL_MS,
  );
  return state;
}

/** Consumes a state. It is single use and expires in ten minutes. */
export function consumeAuthorization(db: DatabaseSync, state: string): string | null {
  const row = db.prepare("SELECT owner_id, expires_at FROM oauth_states WHERE state = ?").get(state) as
    | { owner_id: string | null; expires_at: number }
    | undefined;
  if (!row) return null;
  db.prepare("DELETE FROM oauth_states WHERE state = ?").run(state);
  if (row.expires_at <= Date.now()) return null;
  return row.owner_id;
}

/** The URL the browser is sent to in order to authorize the platform. */
export function authorizationUrl(config: GitHubConfig, state: string): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: callbackUri(),
    scope: GITHUB_SCOPES.join(" "),
    state,
    allow_signup: "false",
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

export type GitHubToken = {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
  scopes: string;
};

/** Exchanges an authorization code for an access token. */
export async function exchangeCode(config: GitHubConfig, code: string): Promise<GitHubToken> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "user-agent": USER_AGENT },
    body: JSON.stringify({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      redirect_uri: callbackUri(),
    }),
  });
  if (!response.ok) throw new GitHubError(502, "GitHub refused the token exchange.");
  const payload = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    error?: string;
    error_description?: string;
  };
  if (payload.error || !payload.access_token) {
    throw new GitHubError(401, payload.error_description ?? payload.error ?? "GitHub did not return an access token.");
  }
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token ?? null,
    expiresAt: payload.expires_in ? Date.now() + payload.expires_in * 1000 : null,
    scopes: payload.scope ?? GITHUB_SCOPES.join(" "),
  };
}

/**
 * Starts a device authorization, for a CLI or a phone that cannot open a
 * browser on the same device as the console.
 */
export async function beginDeviceAuthorization(config: GitHubConfig): Promise<{
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}> {
  const response = await fetch(DEVICE_CODE_URL, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "user-agent": USER_AGENT },
    body: JSON.stringify({ client_id: config.clientId, scope: GITHUB_SCOPES.join(" ") }),
  });
  if (!response.ok) throw new GitHubError(502, "GitHub refused the device authorization.");
  const payload = (await response.json()) as {
    device_code?: string;
    user_code?: string;
    verification_uri?: string;
    expires_in?: number;
    interval?: number;
    error?: string;
  };
  if (!payload.device_code || !payload.user_code) throw new GitHubError(502, "GitHub did not return a device code.");
  return {
    deviceCode: payload.device_code,
    userCode: payload.user_code,
    verificationUri: payload.verification_uri ?? "https://github.com/login/device",
    expiresIn: payload.expires_in ?? 900,
    interval: payload.interval ?? 5,
  };
}

/** Polls GitHub for the device authorization to complete. */
export async function pollDeviceAuthorization(
  config: GitHubConfig,
  deviceCode: string,
): Promise<{ status: "pending" | "ok"; token?: GitHubToken; error?: string }> {
  const response = await fetch(ACCESS_TOKEN_URL, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "user-agent": USER_AGENT },
    body: JSON.stringify({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }),
  });
  const payload = (await response.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    error?: string;
  };
  if (payload.access_token) {
    return {
      status: "ok",
      token: {
        accessToken: payload.access_token,
        refreshToken: payload.refresh_token ?? null,
        expiresAt: payload.expires_in ? Date.now() + payload.expires_in * 1000 : null,
        scopes: payload.scope ?? GITHUB_SCOPES.join(" "),
      },
    };
  }
  if (payload.error === "authorization_pending") return { status: "pending" };
  if (payload.error === "slow_down") return { status: "pending" };
  return { status: "pending", error: payload.error ?? "authorization_pending" };
}

// ---------------------------------------------------------------------------
// The GitHub API
// ---------------------------------------------------------------------------

export type GitHubUser = { id: number; login: string; avatar_url?: string; name?: string | null };

export type GitHubRepo = {
  id: number;
  full_name: string;
  name: string;
  owner: { login: string };
  private: boolean;
  default_branch: string;
  language?: string | null;
  stargazers_count?: number;
  description?: string | null;
  pushed_at?: string | null;
  html_url?: string;
  clone_url?: string;
};

/** A repository row, as the console reads it. */
export type RepositoryRow = {
  id: string;
  githubId: string;
  fullName: string;
  name: string;
  ownerName: string;
  private: number;
  defaultBranch: string;
  language: string | null;
  stars: number;
  description: string | null;
  pushedAt: number | null;
  url: string | null;
  importedProjectId: string | null;
};

async function githubApi<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "user-agent": USER_AGENT,
      "x-github-api-version": "2022-11-28",
      ...(init?.headers ?? {}),
    },
  });
  if (response.status === 401) throw new GitHubError(401, "The GitHub token was rejected. Connect again.");
  if (!response.ok) throw new GitHubError(502, `GitHub answered ${response.status}.`);
  return (await response.json()) as T;
}

/** The account the token belongs to. */
export async function fetchViewer(token: string): Promise<GitHubUser> {
  return githubApi<GitHubUser>(token, "/user");
}

/** Every repository the token can reach, newest pushes first. */
export async function fetchRepositories(token: string): Promise<GitHubRepo[]> {
  const repos: GitHubRepo[] = [];
  for (let page = 1; page <= 5; page += 1) {
    const batch = await githubApi<GitHubRepo[]>(token, `/user/repos?per_page=100&sort=pushed&page=${page}`);
    repos.push(...batch);
    if (batch.length < 100) break;
  }
  return repos;
}

/** The files of a repository at a ref, for the repository browser. */
export async function fetchTree(token: string, owner: string, repo: string, ref: string): Promise<
  { path: string; type: string; size: number }[]
> {
  const url = `/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`;
  const payload = await githubApi<{ tree?: { path: string; type: string; size?: number }[] }>(token, url);
  return (payload.tree ?? [])
    .filter((entry) => entry.type === "blob")
    .map((entry) => ({ path: entry.path, type: entry.type, size: entry.size ?? 0 }))
    .slice(0, 2000);
}

/** The content of one file at a ref, truncated for the preview pane. */
export async function fetchFile(token: string, owner: string, repo: string, ref: string, path: string): Promise<string> {
  const url = `/repos/${owner}/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`;
  const payload = await githubApi<{ content?: string; encoding?: string }>(token, url);
  if (!payload.content) return "";
  return Buffer.from(payload.content, (payload.encoding ?? "base64") as BufferEncoding).toString("utf8").slice(0, 200_000);
}

// ---------------------------------------------------------------------------
// Connections and repositories
// ---------------------------------------------------------------------------

/** Stores a connection for an account. One connection per account. */
export function saveConnection(
  db: DatabaseSync,
  ownerId: string,
  user: GitHubUser,
  token: GitHubToken,
): void {
  const now = Date.now();
  tx(db, () => {
    db.prepare(
      `INSERT INTO github_connections (id, owner_id, github_id, login, avatar_url, access_token, refresh_token,
         token_expires_at, scopes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(owner_id) DO UPDATE SET github_id = excluded.github_id, login = excluded.login,
         avatar_url = excluded.avatar_url, access_token = excluded.access_token, refresh_token = excluded.refresh_token,
         token_expires_at = excluded.token_expires_at, scopes = excluded.scopes, updated_at = excluded.updated_at`,
    ).run(
      newId(),
      ownerId,
      String(user.id),
      user.login,
      user.avatar_url ?? null,
      sealSecret(db, token.accessToken),
      token.refreshToken ? sealSecret(db, token.refreshToken) : null,
      token.expiresAt,
      token.scopes,
      now,
      now,
    );
  });
}

/** The connection of an account, with the token opened. */
export function readConnection(db: DatabaseSync, ownerId: string): {
  id: string;
  githubId: string;
  login: string;
  avatarUrl: string | null;
  scopes: string | null;
  accessToken: string;
} | null {
  const row = db.prepare(
    "SELECT id, github_id AS githubId, login, avatar_url AS avatarUrl, scopes, access_token AS accessToken FROM github_connections WHERE owner_id = ?",
  ).get(ownerId) as
    | { id: string; githubId: string; login: string; avatarUrl: string | null; scopes: string | null; accessToken: string }
    | undefined;
  if (!row) return null;
  const token = openSecret(db, row.accessToken);
  if (!token) return null;
  return { ...row, accessToken: token };
}

/** Removes the connection and the repository list of an account. */
export function deleteConnection(db: DatabaseSync, ownerId: string): void {
  tx(db, () => {
    db.prepare("DELETE FROM repositories WHERE owner_id = ?").run(ownerId);
    db.prepare("DELETE FROM github_connections WHERE owner_id = ?").run(ownerId);
  });
}

/** Replaces the repository list of a connection with what GitHub reports. */
export function syncRepositories(db: DatabaseSync, ownerId: string, repos: GitHubRepo[]): void {
  const now = Date.now();
  tx(db, () => {
    for (const repo of repos) {
      db.prepare(
        `INSERT INTO repositories (id, owner_id, github_id, full_name, name, owner_name, private, default_branch,
           language, stars, description, pushed_at, url, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(owner_id, github_id) DO UPDATE SET full_name = excluded.full_name, name = excluded.name,
           owner_name = excluded.owner_name, private = excluded.private, default_branch = excluded.default_branch,
           language = excluded.language, stars = excluded.stars, description = excluded.description,
           pushed_at = excluded.pushed_at, url = excluded.url, updated_at = excluded.updated_at`,
      ).run(
        `${repo.id}:${repo.full_name}`,
        ownerId,
        String(repo.id),
        repo.full_name,
        repo.name,
        repo.owner.login,
        repo.private ? 1 : 0,
        repo.default_branch || "main",
        repo.language ?? null,
        repo.stargazers_count ?? 0,
        repo.description ?? null,
        repo.pushed_at ? Date.parse(repo.pushed_at) : null,
        repo.html_url ?? null,
        now,
        now,
      );
    }
  });
}

/** The repositories of a connection, newest pushes first. */
export function listRepositories(db: DatabaseSync, ownerId: string): RepositoryRow[] {
  return db.prepare(
    `SELECT id, github_id AS githubId, full_name AS fullName, name, owner_name AS ownerName, private,
       default_branch AS defaultBranch, language, stars, description, pushed_at AS pushedAt, url,
       imported_project_id AS importedProjectId
     FROM repositories WHERE owner_id = ? ORDER BY pushed_at IS NULL, pushed_at DESC, full_name`,
  ).all(ownerId) as RepositoryRow[];
}

/** A repository of a connection, by its GitHub identifier. */
export function findRepository(db: DatabaseSync, ownerId: string, repositoryId: string): RepositoryRow | null {
  return (db.prepare(
    `SELECT id, github_id AS githubId, full_name AS fullName, name, owner_name AS ownerName, private,
       default_branch AS defaultBranch, language, stars, description, pushed_at AS pushedAt, url,
       imported_project_id AS importedProjectId
     FROM repositories WHERE owner_id = ? AND (id = ? OR github_id = ?)`,
  ).get(ownerId, repositoryId, repositoryId) as RepositoryRow | undefined) ?? null;
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

/**
 * Checks the `X-Hub-Signature-256` header against the shared secret.
 *
 * The comparison is constant time, and a missing secret never verifies: an
 * unconfigured webhook is closed, not open.
 */
export function verifyWebhookSignature(secret: string, body: string, signature: string | null): boolean {
  if (!secret || !signature) return false;
  if (!signature.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", secret).update(body, "utf8").digest("hex");
  const given = signature.slice("sha256=".length);
  if (given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(given, "hex"), Buffer.from(expected, "hex"));
}

export type WebhookEvent = {
  kind: "push" | "pull_request" | "release" | "ignored";
  repositoryId: string;
  fullName: string;
  branch: string | null;
  commit: string | null;
  ref: string | null;
  pullNumber: number | null;
  action: string | null;
  installationId: string | null;
};

/** Reads the part of a webhook delivery the platform acts on. */
export function parseWebhookEvent(payload: unknown): WebhookEvent | null {
  const body = payload as {
    repository?: { id?: number; full_name?: string; default_branch?: string };
    ref?: string;
    after?: string;
    pull_request?: { number?: number };
    action?: string;
    release?: { tag_name?: string };
    installation?: { id?: number };
  };
  const repositoryId = body?.repository?.id ? String(body.repository.id) : "";
  const fullName = body?.repository?.full_name ?? "";
  if (!repositoryId || !fullName) return null;
  const event = body.installation?.id ? "installation" : undefined;
  void event;
  const installationId = body.installation?.id ? String(body.installation.id) : null;
  if (body.release?.tag_name) {
    return {
      kind: "release",
      repositoryId,
      fullName,
      branch: body.release.tag_name,
      commit: body.after ?? null,
      ref: `refs/tags/${body.release.tag_name}`,
      pullNumber: null,
      action: body.action ?? null,
      installationId,
    };
  }
  if (body.pull_request?.number) {
    return {
      kind: "pull_request",
      repositoryId,
      fullName,
      branch: body.ref?.replace("refs/heads/", "") ?? null,
      commit: body.after ?? null,
      ref: body.ref ?? null,
      pullNumber: body.pull_request.number,
      action: body.action ?? null,
      installationId,
    };
  }
  if (body.ref) {
    return {
      kind: "push",
      repositoryId,
      fullName,
      branch: body.ref.replace("refs/heads/", ""),
      commit: body.after ?? null,
      ref: body.ref,
      pullNumber: null,
      action: body.action ?? null,
      installationId,
    };
  }
  return null;
}

/** The accounts that may receive a webhook for a repository. */
export function ownersForRepository(db: DatabaseSync, repositoryId: string): string[] {
  const rows = db.prepare("SELECT owner_id AS ownerId FROM repositories WHERE github_id = ?").all(repositoryId) as { ownerId: string }[];
  return rows.map((row) => row.ownerId);
}

/** A stable digest of the delivery, so the same event is not built twice. */
export function deliveryDigest(body: string): string {
  return tokenHash(body).slice(0, 32);
}
