import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign as cryptoSign } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { newId, tokenHash } from "./db.ts";
import type { OAuthClient } from "./oauth.ts";
import type { User } from "../types.ts";

/**
 * OpenID Connect provider primitives.
 *
 * The control plane already authenticates people with passkeys, QR approval and
 * scoped sessions. This module turns that identity into a standards-based SSO
 * provider: discovery metadata, a JWKS endpoint, signed ID tokens, back-channel
 * logout tokens, and RFC 7009 revocation.
 *
 * Signing keys live in the database so rotation is explicit and the JWKS
 * endpoint can publish an overlap window. An operator can supply the private
 * key through `MOBILECLOUD_OIDC_PRIVATE_KEY`; otherwise one is generated on
 * first use. In production the column should be encrypted at rest or replaced
 * by a KMS/HSM-backed signer — see docs/SSO.md.
 */

const ID_TOKEN_TTL_MS = 10 * 60_000;
const LOGOUT_TOKEN_TTL_MS = 2 * 60_000;
const CLOCK_SKEW_SEC = 60;

export type SigningKey = {
  kid: string;
  alg: "RS256";
  privatePem: string;
  jwk: Record<string, unknown>;
};

export function b64url(value: Buffer | string): string {
  return Buffer.from(value).toString("base64url");
}

function publicJwk(privatePem: string, kid: string): Record<string, unknown> {
  const exported = createPublicKey(createPrivateKey(privatePem)).export({ format: "jwk" }) as {
    kty: string;
    n: string;
    e: string;
  };
  return { kty: exported.kty, n: exported.n, e: exported.e, use: "sig", alg: "RS256", kid };
}

/**
 * Returns the active RSA signing key, generating and persisting one when the
 * account has never issued an ID token.
 */
export function ensureSigningKey(db: DatabaseSync): SigningKey {
  const row = db.prepare(
    "SELECT kid, private_pem, public_jwk FROM signing_keys WHERE alg = 'RS256' AND active = 1 ORDER BY created_at DESC LIMIT 1",
  ).get() as { kid: string; private_pem: string; public_jwk: string } | undefined;
  if (row) {
    return {
      kid: row.kid,
      alg: "RS256",
      privatePem: row.private_pem,
      jwk: JSON.parse(row.public_jwk) as Record<string, unknown>,
    };
  }
  const privatePem = process.env.MOBILECLOUD_OIDC_PRIVATE_KEY?.trim()
    ? process.env.MOBILECLOUD_OIDC_PRIVATE_KEY.trim().replace(/\\n/g, "\n")
    : (createGeneratedKey());
  const kid = randomBytes(8).toString("hex");
  const jwk = publicJwk(privatePem, kid);
  db.prepare(
    "INSERT INTO signing_keys (id, kid, alg, private_pem, public_jwk, certificate_pem, created_at, active) VALUES (?, ?, 'RS256', ?, ?, NULL, ?, 1)",
  ).run(newId(), kid, privatePem, JSON.stringify(jwk), Date.now());
  return { kid, alg: "RS256", privatePem, jwk };
}

function createGeneratedKey(): string {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}

/** Every currently published verification key (rotation keeps the old one for a while). */
export function jwks(db: DatabaseSync): { keys: Record<string, unknown>[] } {
  ensureSigningKey(db);
  const rows = db.prepare("SELECT public_jwk FROM signing_keys WHERE alg = 'RS256' AND active = 1").all() as {
    public_jwk: string;
  }[];
  return { keys: rows.map((row) => JSON.parse(row.public_jwk) as Record<string, unknown>) };
}

/** The OIDC discovery document for this issuer. */
export function discovery(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    userinfo_endpoint: `${origin}/oauth/userinfo`,
    jwks_uri: `${origin}/.well-known/jwks.json`,
    revocation_endpoint: `${origin}/oauth/revoke`,
    end_session_endpoint: `${origin}/oauth/logout`,
    scopes_supported: ["openid", "profile", "email", "offline_access"],
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["RS256"],
    token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "none"],
    code_challenge_methods_supported: ["S256"],
    claims_supported: [
      "iss",
      "sub",
      "aud",
      "exp",
      "iat",
      "auth_time",
      "nonce",
      "email",
      "email_verified",
      "name",
      "preferred_username",
    ],
    backchannel_logout_supported: true,
    backchannel_logout_session_supported: true,
  };
}

/** Signs a compact JWT with the active RS256 key. */
export function signJwt(db: DatabaseSync, payload: Record<string, unknown>): string {
  const key = ensureSigningKey(db);
  const header = { alg: "RS256", typ: "JWT", kid: key.kid };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signature = cryptoSign("RSA-SHA256", Buffer.from(signingInput, "utf8"), key.privatePem);
  return `${signingInput}.${signature.toString("base64url")}`;
}

/** Claims in an ID token, filtered by the scopes the client was granted. */
export function userClaims(user: Pick<User, "id" | "email" | "name">, scope: string) {
  const scopes = scope.split(/\s+/);
  const claims: Record<string, unknown> = { sub: user.id };
  if (scopes.includes("email")) {
    claims.email = user.email;
    claims.email_verified = true;
  }
  if (scopes.includes("profile")) {
    claims.name = user.name;
    claims.preferred_username = user.email;
  }
  return claims;
}

export type IdTokenInput = {
  origin: string;
  client: OAuthClient;
  user: Pick<User, "id" | "email" | "name">;
  scope: string;
  nonce?: string | null;
  authTime?: number;
  sessionId?: string | null;
};

/** Issues an OIDC ID token for an authorization-code exchange. */
export function issueIdToken(db: DatabaseSync, input: IdTokenInput): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: Record<string, unknown> = {
    iss: input.origin,
    aud: input.client.id,
    azp: input.client.id,
    iat: now,
    exp: now + Math.floor(ID_TOKEN_TTL_MS / 1000),
    auth_time: Math.floor((input.authTime ?? Date.now()) / 1000),
    ...userClaims(input.user, input.scope),
  };
  if (input.nonce) payload.nonce = input.nonce;
  if (input.sessionId) payload.sid = input.sessionId;
  return signJwt(db, payload);
}

/**
 * Issues an OIDC Back-Channel Logout token.
 *
 * It is deliberately short lived, audience-bound to one client, and carries
 * the backchannel-logout event so a client can reject a token minted for
 * anything else.
 */
export function issueLogoutToken(
  db: DatabaseSync,
  input: { origin: string; client: OAuthClient; user: Pick<User, "id">; sessionId?: string | null },
): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: Record<string, unknown> = {
    iss: input.origin,
    aud: input.client.id,
    iat: now,
    exp: now + Math.floor(LOGOUT_TOKEN_TTL_MS / 1000),
    jti: randomBytes(16).toString("hex"),
    sub: input.user.id,
    events: { "http://schemas.openid.net/event/backchannel-logout": {} },
  };
  if (input.sessionId) payload.sid = input.sessionId;
  return signJwt(db, payload);
}

/** Decodes a JWT payload without trusting it; callers must verify before use. */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const parsed = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Delivers a back-channel logout token to a client.
 *
 * Best-effort by design: a logout must complete even when an SP is offline.
 * The client acknowledges with any 2xx; anything else is reported to the
 * caller, which logs it and moves on.
 */
export async function deliverBackchannelLogout(client: OAuthClient, logoutToken: string): Promise<boolean> {
  if (!client.backchannelLogoutUri) return false;
  try {
    const response = await fetch(client.backchannelLogoutUri, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ logout_token: logoutToken }).toString(),
      signal: AbortSignal.timeout(2000),
      redirect: "error",
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * RFC 7009 token revocation.
 *
 * The caller is not told whether the token existed: a revocation endpoint that
 * answers differently for known and unknown tokens is an oracle.
 */
export function revokeToken(db: DatabaseSync, rawToken: string): void {
  const hash = tokenHash(rawToken);
  const access = db.prepare("SELECT id FROM access_tokens WHERE token_hash = ?").get(hash) as { id: string } | undefined;
  if (access) {
    const now = Date.now();
    db.prepare("UPDATE access_tokens SET expires_at = ? WHERE id = ?").run(now, access.id);
    db.prepare("UPDATE refresh_tokens SET revoked = 1 WHERE access_token_id = ?").run(access.id);
    return;
  }
  db.prepare("UPDATE refresh_tokens SET revoked = 1 WHERE token_hash = ?").run(hash);
}

/** True when the clock is inside the token's validity window (with skew). */
export function withinValidity(exp: unknown, iat: unknown): boolean {
  const now = Math.floor(Date.now() / 1000);
  return typeof exp === "number" && typeof iat === "number" && exp + CLOCK_SKEW_SEC > now && iat - CLOCK_SKEW_SEC <= now;
}
