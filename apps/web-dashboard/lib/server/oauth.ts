import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { newId, tokenHash } from "./db.ts";
import { tx } from "./events.ts";

/**
 * OAuth 2.1 for MobileCloud clients.
 *
 * Two grants are supported:
 *   - the Device Authorization Grant (RFC 8628) for headless clients such as
 *     the CLI, where the user approves in the console or on the phone;
 *   - the Authorization Code grant with PKCE (RFC 9700) for clients that can
 *     open a browser and listen on a loopback callback.
 *
 * The implicit grant is gone, and every token the platform hands out is
 * scoped, hashed at rest, and refreshable through a rotating chain.
 */

const DEVICE_CODE_TTL_MS = 15 * 60_000;
const POLL_INTERVAL_SECS = 5;
const AUTHORIZATION_CODE_TTL_MS = 5 * 60_000;
const ACCESS_TOKEN_TTL_MS = 60 * 60_000;
const REFRESH_TOKEN_TTL_MS = 30 * 86_400_000;
const USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export type OAuthClient = {
  id: string;
  name: string;
  scopes: string[];
  redirectUris: string[];
};

const CLIENTS: Record<string, OAuthClient> = {
  "mobilecloud-cli": {
    id: "mobilecloud-cli",
    name: "MobileCloud CLI",
    scopes: ["cli:full"],
    redirectUris: ["http://127.0.0.1/callback", "http://localhost/callback"],
  },
};

export class OAuthError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function findClient(clientId: string): OAuthClient | null {
  return CLIENTS[clientId] ?? null;
}

/** Every scope a client may ask for, in the order the console lists them. */
export function knownScopes(): string[] {
  return [...new Set(Object.values(CLIENTS).flatMap((client) => client.scopes))];
}

/** Rejects a scope the client is not allowed to ask for. */
export function checkScope(client: OAuthClient, requested: string | null | undefined): string {
  const scope = (requested ?? "cli:full").trim();
  if (!scope) throw new OAuthError(400, "invalid_scope", "A scope is required.");
  for (const part of scope.split(/\s+/)) {
    if (!client.scopes.includes(part)) {
      throw new OAuthError(400, "invalid_scope", `This client cannot ask for the ${part} scope.`);
    }
  }
  return scope;
}

/** A device code for the user to type, and the secret the client polls with. */
export type DeviceGrant = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
};

function newUserCode(): string {
  const bytes = randomBytes(8);
  const raw = Array.from(bytes, (byte) => USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length]).join("");
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

/** Starts a device authorization. */
export function startDeviceGrant(db: DatabaseSync, input: { clientId: string; scope?: string | null; verificationUri: string }): DeviceGrant {
  const client = findClient(input.clientId);
  if (!client) throw new OAuthError(400, "invalid_client", "That client is not registered.");
  const scope = checkScope(client, input.scope);
  const deviceCode = randomBytes(32).toString("hex");
  const now = Date.now();
  const userCode = tx(db, () => {
    db.prepare("DELETE FROM oauth_device_codes WHERE expires_at <= ?").run(now);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const code = newUserCode();
      const result = db.prepare(
        "INSERT INTO oauth_device_codes (id, device_code_hash, user_code, client_id, scope, status, created_at, expires_at, interval_sec) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)",
      ).run(newId(), tokenHash(deviceCode), code, client.id, scope, now, now + DEVICE_CODE_TTL_MS, POLL_INTERVAL_SECS);
      if (Number(result.changes)) return code;
    }
    throw new OAuthError(503, "server_error", "No display code is available. Try again.");
  });
  return {
    deviceCode,
    userCode,
    verificationUri: input.verificationUri,
    verificationUriComplete: `${input.verificationUri}?code=${encodeURIComponent(userCode)}`,
    expiresIn: Math.floor(DEVICE_CODE_TTL_MS / 1000),
    interval: POLL_INTERVAL_SECS,
  };
}

export type DeviceCodeRow = {
  id: string;
  user_code: string;
  client_id: string;
  scope: string;
  status: string;
  approved_by: string | null;
  device_name: string | null;
  device_platform: string | null;
  expires_at: number;
  created_at: number;
};

/** Finds a pending device code by the code a human typed. */
export function findDeviceCode(db: DatabaseSync, userCode: string): DeviceCodeRow | null {
  const normalized = userCode.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  if (!normalized) return null;
  // The stored code carries a display hyphen ("ABCD-1234") while a person may
  // type it with or without one, so the comparison ignores punctuation.
  const row = db.prepare(
    "SELECT id, user_code, client_id, scope, status, approved_by, device_name, device_platform, expires_at, created_at FROM oauth_device_codes WHERE REPLACE(user_code, '-', '') = ?",
  ).get(normalized) as DeviceCodeRow | undefined;
  return row ?? null;
}

/** Approves a device code on behalf of the signed-in account. */
export function approveDeviceCode(db: DatabaseSync, id: string, userId: string, device?: { name?: string | null; platform?: string | null }): void {
  const result = db.prepare(
    "UPDATE oauth_device_codes SET status = 'approved', approved_by = ?, device_name = COALESCE(?, device_name), device_platform = COALESCE(?, device_platform) WHERE id = ? AND status = 'pending' AND expires_at > ?",
  ).run(userId, device?.name ?? null, device?.platform ?? null, id, Date.now());
  if (!Number(result.changes)) throw new OAuthError(409, "invalid_grant", "That request was already handled.");
}

/** Denies a device code. */
export function denyDeviceCode(db: DatabaseSync, id: string): void {
  const result = db.prepare(
    "UPDATE oauth_device_codes SET status = 'denied' WHERE id = ? AND status = 'pending' AND expires_at > ?",
  ).run(id, Date.now());
  if (!Number(result.changes)) throw new OAuthError(409, "invalid_grant", "That request was already handled.");
}

export type TokenPair = {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  scope: string;
  tokenType: "Bearer";
};

/**
 * Writes an access token and its first refresh token.
 *
 * The two rows belong together, so they are written in one transaction. When
 * the caller already holds a transaction, use {@link insertTokenPair} instead
 * so the writes join that transaction instead of nesting a second one.
 */
export function issueTokenPair(
  db: DatabaseSync,
  input: { userId: string; scope: string; clientType: "cli" | "api"; sessionId?: string | null; name?: string },
): TokenPair {
  return tx(db, () => insertTokenPair(db, input));
}

/** The writes behind {@link issueTokenPair}, without opening a transaction. */
function insertTokenPair(
  db: DatabaseSync,
  input: { userId: string; scope: string; clientType: "cli" | "api"; sessionId?: string | null; name?: string },
): TokenPair {
  const accessToken = `mc_${randomBytes(24).toString("hex")}`;
  const refreshToken = `mcr_${randomBytes(32).toString("hex")}`;
  const now = Date.now();
  const tokenId = newId();
  const refreshId = newId();
  db.prepare(
    "INSERT INTO access_tokens (id, owner_id, name, token_hash, prefix, scope, client_type, session_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    tokenId,
    input.userId,
    (input.name ?? "cli").slice(0, 60),
    tokenHash(accessToken),
    accessToken.slice(0, 10),
    input.scope,
    input.clientType,
    input.sessionId ?? null,
    now,
    now + ACCESS_TOKEN_TTL_MS,
  );
  db.prepare(
    "INSERT INTO refresh_tokens (id, user_id, token_hash, session_id, access_token_id, client_type, scope, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    refreshId,
    input.userId,
    tokenHash(refreshToken),
    input.sessionId ?? null,
    tokenId,
    input.clientType,
    input.scope,
    now,
    now + REFRESH_TOKEN_TTL_MS,
  );
  return { accessToken, refreshToken, expiresIn: Math.floor(ACCESS_TOKEN_TTL_MS / 1000), scope: input.scope, tokenType: "Bearer" };
}

/**
 * Exchanges a device code for tokens.
 *
 * The device code is single use: it is consumed in the same transaction that
 * issues the tokens, so a replayed poll cannot mint a second session.
 */
export function redeemDeviceCode(db: DatabaseSync, input: { deviceCode: string; clientId: string }): TokenPair {
  const client = findClient(input.clientId);
  if (!client) throw new OAuthError(400, "invalid_client", "That client is not registered.");
  const hash = tokenHash(input.deviceCode);
  return tx(db, () => {
    const row = db.prepare(
      "SELECT id, status, approved_by, scope, expires_at FROM oauth_device_codes WHERE device_code_hash = ?",
    ).get(hash) as { id: string; status: string; approved_by: string | null; scope: string; expires_at: number } | undefined;
    if (!row) throw new OAuthError(400, "invalid_grant", "That device code is not valid.");
    if (row.expires_at <= Date.now()) {
      db.prepare("UPDATE oauth_device_codes SET status = 'expired' WHERE id = ? AND status = 'pending'").run(row.id);
      throw new OAuthError(400, "expired_token", "That request expired. Start the login again.");
    }
    if (row.status === "pending") {
      throw new OAuthError(428, "authorization_pending", "The request has not been approved yet.");
    }
    if (row.status === "denied") throw new OAuthError(403, "access_denied", "The request was denied.");
    if (row.status !== "approved" || !row.approved_by) {
      throw new OAuthError(400, "invalid_grant", "That device code is in an unexpected state.");
    }
    db.prepare("UPDATE oauth_device_codes SET status = 'consumed' WHERE id = ?").run(row.id);
    return insertTokenPair(db, { userId: row.approved_by, scope: row.scope, clientType: "cli", name: client.name });
  });
}

/** Creates an authorization code for the PKCE flow. */
export function createAuthorizationCode(
  db: DatabaseSync,
  input: { clientId: string; userId: string; redirectUri: string; scope: string; codeChallenge: string; codeChallengeMethod: string },
): string {
  const code = randomBytes(32).toString("hex");
  const now = Date.now();
  db.prepare(
    "INSERT INTO oauth_authorization_codes (id, code_hash, client_id, user_id, redirect_uri, scope, code_challenge, code_challenge_method, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    newId(),
    tokenHash(code),
    input.clientId,
    input.userId,
    input.redirectUri,
    input.scope,
    input.codeChallenge,
    input.codeChallengeMethod,
    now,
    now + AUTHORIZATION_CODE_TTL_MS,
  );
  return code;
}

/** Exchanges an authorization code for tokens, proving the PKCE verifier. */
export function redeemAuthorizationCode(
  db: DatabaseSync,
  input: { code: string; codeVerifier: string; clientId: string; redirectUri: string },
): TokenPair {
  return tx(db, () => {
    const row = db.prepare(
      "SELECT id, client_id, user_id, redirect_uri, scope, code_challenge, code_challenge_method, used, expires_at FROM oauth_authorization_codes WHERE code_hash = ?",
  ).get(tokenHash(input.code)) as {
      id: string;
      client_id: string;
      user_id: string;
      redirect_uri: string;
      scope: string;
      code_challenge: string;
      code_challenge_method: string;
      used: number;
      expires_at: number;
    } | undefined;
    if (!row) throw new OAuthError(400, "invalid_grant", "That authorization code is not valid.");
    if (row.used) throw new OAuthError(400, "invalid_grant", "That authorization code was already used.");
    if (row.expires_at <= Date.now()) throw new OAuthError(400, "invalid_grant", "That authorization code expired.");
    if (row.client_id !== input.clientId) throw new OAuthError(400, "invalid_client", "That code was issued to another client.");
    if (row.redirect_uri !== input.redirectUri) throw new OAuthError(400, "invalid_grant", "That redirect URI does not match.");
    const expected = createHash("sha256").update(input.codeVerifier).digest("base64url");
    if (row.code_challenge_method !== "S256" || expected !== row.code_challenge) {
      throw new OAuthError(400, "invalid_grant", "That code verifier does not match.");
    }
    db.prepare("UPDATE oauth_authorization_codes SET used = 1 WHERE id = ?").run(row.id);
    return insertTokenPair(db, { userId: row.user_id, scope: row.scope, clientType: "cli", name: findClient(row.client_id)?.name });
  });
}

/**
 * Rotates a refresh token.
 *
 * A refresh token is single use. When one is presented a second time, the
 * token was either stolen or replayed, and the whole family is revoked: the
 * legitimate client then fails to refresh and has to sign in again, while the
 * attacker holds a token that no longer works.
 */
export function refreshTokens(db: DatabaseSync, rawRefreshToken: string): TokenPair {
  const hash = tokenHash(rawRefreshToken);
  const row = db.prepare(
    "SELECT id, user_id, session_id, access_token_id, client_type, scope, created_at, expires_at, used_at, revoked FROM refresh_tokens WHERE token_hash = ?",
  ).get(hash) as {
    id: string;
    user_id: string;
    session_id: string | null;
    access_token_id: string | null;
    client_type: string;
    scope: string;
    created_at: number;
    expires_at: number;
    used_at: number | null;
    revoked: number;
  } | undefined;
  if (!row) throw new OAuthError(400, "invalid_grant", "That refresh token is not valid.");
  if (row.revoked) throw new OAuthError(400, "invalid_grant", "That refresh token was revoked.");
  if (row.used_at) {
    // Replay: revoke every refresh token this session owns.
    tx(db, () => {
      if (row.session_id) {
        db.prepare("UPDATE refresh_tokens SET revoked = 1 WHERE session_id = ?").run(row.session_id);
      } else {
        db.prepare("UPDATE refresh_tokens SET revoked = 1 WHERE user_id = ? AND client_type = ?").run(row.user_id, row.client_type);
      }
      db.prepare("UPDATE access_tokens SET expires_at = ? WHERE id = ?").run(Date.now(), row.access_token_id ?? "");
    });
    throw new OAuthError(400, "invalid_grant", "That refresh token was already used. Sign in again.");
  }
  if (row.expires_at <= Date.now()) throw new OAuthError(400, "invalid_grant", "That refresh token expired.");

  return tx(db, () => {
    const pair = insertTokenPair(db, {
      userId: row.user_id,
      scope: row.scope,
      clientType: row.client_type as "cli" | "api",
      sessionId: row.session_id,
      name: "cli",
    });
    db.prepare("UPDATE refresh_tokens SET used_at = ?, replaced_by = ? WHERE id = ?").run(Date.now(), pair.refreshToken, row.id);
    // The access token this refresh belonged to is retired with it.
    db.prepare("UPDATE access_tokens SET expires_at = ? WHERE id = ?").run(Date.now(), row.access_token_id ?? "");
    return pair;
  });
}

/** Revokes an access token and the refresh tokens that belong to it. */
export function revokeToken(db: DatabaseSync, rawAccessToken: string): boolean {
  const tokenId = db.prepare("SELECT id FROM access_tokens WHERE token_hash = ?").get(tokenHash(rawAccessToken)) as { id: string } | undefined;
  if (!tokenId) return false;
  tx(db, () => {
    db.prepare("UPDATE access_tokens SET expires_at = ? WHERE id = ?").run(Date.now(), tokenId.id);
    db.prepare("UPDATE refresh_tokens SET revoked = 1 WHERE access_token_id = ?").run(tokenId.id);
  });
  return true;
}

/** The scopes and lifetime a client sees for a token. */
export function describeToken(db: DatabaseSync, rawAccessToken: string) {
  return db.prepare(
    "SELECT id, owner_id AS userId, name, scope, client_type AS clientType, expires_at AS expiresAt, created_at AS createdAt FROM access_tokens WHERE token_hash = ?",
  ).get(tokenHash(rawAccessToken));
}
