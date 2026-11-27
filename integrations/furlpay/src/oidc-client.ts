import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import type { FurlPayConfig } from "./config.ts";
import { assertSafeOutboundUrl, fetchJson, FurlPayHttpError, type FetchLike } from "./http.ts";
import { createNonce, createPkce, createState } from "./pkce.ts";

/**
 * The OpenID Connect client FurlPay uses.
 *
 * This is the relying-party half: it builds the authorization request, carries
 * state and nonce, exchanges the code with PKCE, and verifies the ID token
 * against the issuer's published keys. It never treats the ID token as an
 * access token and never calls a FurlPay financial API with it.
 */

export type DiscoveryDocument = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
  jwks_uri: string;
  end_session_endpoint?: string;
  revocation_endpoint?: string;
  id_token_signing_alg_values_supported?: string[];
  code_challenge_methods_supported?: string[];
};

export type TokenResponse = {
  access_token: string;
  token_type: string;
  expires_in: number;
  id_token: string;
  refresh_token?: string;
  scope: string;
};

export type IdTokenClaims = {
  iss: string;
  sub: string;
  aud: string | string[];
  azp?: string;
  exp: number;
  iat: number;
  nonce?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  preferred_username?: string;
  sid?: string;
  [claim: string]: unknown;
};

export type RelyingPartyDeps = {
  fetch?: FetchLike;
  now?: () => number;
  /** Only for tests and local development. */
  allowInsecureLoopback?: boolean;
};

type Jwk = Record<string, unknown> & { kid?: string; kty?: string; n?: string; e?: string };

const CLOCK_SKEW_SEC = 60;

function sameOrigin(endpoint: string, issuer: string): boolean {
  try {
    return new URL(endpoint).origin === new URL(issuer).origin;
  } catch {
    return false;
  }
}

function decodeJsonPart(part: string): Record<string, unknown> {
  try {
    const value = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
    return value as Record<string, unknown>;
  } catch {
    throw new FurlPayHttpError("invalid_id_token", "The ID token has a malformed header or payload");
  }
}

export function createFurlPayOidcClient(config: FurlPayConfig, deps: RelyingPartyDeps = {}) {
  const fetchImpl: FetchLike = deps.fetch ?? ((input, init) => fetch(input, init));
  const now = deps.now ?? (() => Date.now());
  const allowLoopback = deps.allowInsecureLoopback ?? config.allowInsecureLoopback;

  let discoveryCache: { document: DiscoveryDocument; fetchedAt: number } | null = null;
  let jwksCache: { keys: Jwk[]; fetchedAt: number } | null = null;

  async function discover(): Promise<DiscoveryDocument> {
    if (discoveryCache && now() - discoveryCache.fetchedAt < 10 * 60_000) return discoveryCache.document;
    const url = `${config.issuer}/.well-known/openid-configuration`;
    const document = await fetchJson<DiscoveryDocument>(fetchImpl, url, { allowLoopback });
    if (document.issuer !== config.issuer) {
      throw new FurlPayHttpError("issuer_mismatch", "The discovery document was issued for a different issuer");
    }
    for (const endpoint of [document.authorization_endpoint, document.token_endpoint, document.jwks_uri, document.userinfo_endpoint]) {
      assertSafeOutboundUrl(endpoint, { allowLoopback });
      if (!sameOrigin(endpoint, config.issuer)) {
        throw new FurlPayHttpError("issuer_mismatch", "A discovery endpoint is outside the configured issuer");
      }
    }
    if (!(document.code_challenge_methods_supported ?? []).includes("S256")) {
      throw new FurlPayHttpError("unsupported_provider", "The issuer does not support PKCE S256");
    }
    discoveryCache = { document, fetchedAt: now() };
    return document;
  }

  async function fetchJwks(force = false): Promise<Jwk[]> {
    if (!force && jwksCache && now() - jwksCache.fetchedAt < 10 * 60_000) return jwksCache.keys;
    const document = await discover();
    const value = await fetchJson<{ keys?: Jwk[] }>(fetchImpl, document.jwks_uri, { allowLoopback });
    if (!Array.isArray(value.keys)) throw new FurlPayHttpError("invalid_jwks", "The JWKS document has no keys");
    const keys = value.keys.filter((key) => key && key.kty === "RSA");
    jwksCache = { keys, fetchedAt: now() };
    return keys;
  }

  function verifySignature(idToken: string, jwk: Jwk): void {
    const parts = idToken.split(".");
    if (parts.length !== 3) throw new FurlPayHttpError("invalid_id_token", "The ID token is not a compact JWT");
    let key;
    try {
      key = createPublicKey({ key: jwk as never, format: "jwk" });
    } catch {
      throw new FurlPayHttpError("invalid_jwks", "The published key could not be read");
    }
    const valid = cryptoVerify(
      "RSA-SHA256",
      Buffer.from(`${parts[0]}.${parts[1]}`),
      key,
      Buffer.from(parts[2], "base64url"),
    );
    if (!valid) throw new FurlPayHttpError("invalid_signature", "The ID token signature did not verify");
  }

  return {
    async authorizationUrl(input: { state?: string; nonce?: string; codeChallenge: string; scope?: string }): Promise<string> {
      const document = await discover();
      const url = new URL(document.authorization_endpoint);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", config.clientId);
      url.searchParams.set("redirect_uri", config.redirectUri);
      url.searchParams.set("scope", input.scope ?? config.scopes.join(" "));
      url.searchParams.set("state", input.state ?? createState());
      url.searchParams.set("nonce", input.nonce ?? createNonce());
      url.searchParams.set("code_challenge", input.codeChallenge);
      url.searchParams.set("code_challenge_method", "S256");
      return url.toString();
    },

    async exchangeCode(input: { code: string; codeVerifier: string; redirectUri?: string }): Promise<TokenResponse> {
      const document = await discover();
      const body = new URLSearchParams({
        grant_type: "authorization_code",
        code: input.code,
        code_verifier: input.codeVerifier,
        redirect_uri: input.redirectUri ?? config.redirectUri,
        client_id: config.clientId,
      });
      const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
      if (config.clientSecret) {
        headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(config.clientId)}:${encodeURIComponent(config.clientSecret)}`).toString("base64")}`;
      }
      const tokens = await fetchJson<TokenResponse>(fetchImpl, document.token_endpoint, {
        method: "POST",
        headers,
        body: body.toString(),
        allowLoopback,
      });
      if (!tokens.id_token) throw new FurlPayHttpError("missing_id_token", "The token response did not include an ID token");
      if (tokens.token_type.toLowerCase() !== "bearer") throw new FurlPayHttpError("invalid_token_type", "Unexpected token type");
      return tokens;
    },

    /** Verifies signature, issuer, audience, time window and nonce. */
    async verifyIdToken(idToken: string, expectedNonce: string): Promise<IdTokenClaims> {
      const parts = idToken.split(".");
      if (parts.length !== 3) throw new FurlPayHttpError("invalid_id_token", "The ID token is not a compact JWT");
      const header = decodeJsonPart(parts[0]);
      const claims = decodeJsonPart(parts[1]) as IdTokenClaims;
      if (header.alg !== "RS256") throw new FurlPayHttpError("invalid_id_token", "Only RS256 ID tokens are accepted");
      if (typeof header.kid !== "string" || !header.kid) throw new FurlPayHttpError("invalid_id_token", "The ID token has no key id");
      let keys = await fetchJwks();
      let jwk = keys.find((key) => key.kid === header.kid);
      if (!jwk) {
        // A rotation may have happened since the cache was filled.
        jwksCache = null;
        keys = await fetchJwks(true);
        jwk = keys.find((key) => key.kid === header.kid);
      }
      if (!jwk) throw new FurlPayHttpError("unknown_signing_key", "The ID token names a key the issuer does not publish");
      verifySignature(idToken, jwk);

      if (claims.iss !== config.issuer) throw new FurlPayHttpError("issuer_mismatch", "The ID token was issued by a different issuer");
      const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      if (!audience.includes(config.clientId)) throw new FurlPayHttpError("audience_mismatch", "The ID token is for a different client");
      if (audience.length > 1 && claims.azp !== config.clientId) {
        throw new FurlPayHttpError("audience_mismatch", "The ID token has multiple audiences without this client as azp");
      }
      if (typeof claims.sub !== "string" || !claims.sub) throw new FurlPayHttpError("invalid_id_token", "The ID token has no subject");
      const current = Math.floor(now() / 1000);
      if (typeof claims.exp !== "number" || claims.exp + CLOCK_SKEW_SEC <= current) {
        throw new FurlPayHttpError("token_expired", "The ID token has expired");
      }
      if (typeof claims.iat !== "number" || claims.iat - CLOCK_SKEW_SEC > current) {
        throw new FurlPayHttpError("invalid_id_token", "The ID token was issued in the future");
      }
      if (claims.nonce !== expectedNonce) throw new FurlPayHttpError("nonce_mismatch", "The ID token nonce does not match this login");
      return claims;
    },

    /** Verifies a MobileCloud step-up token for one action and payload. */
    async verifyStepUpToken(
      stepUpToken: string,
      expected: { action: string; payloadHash: string },
    ): Promise<Record<string, unknown>> {
      const [headerPart, payloadPart, signaturePart] = stepUpToken.split(".");
      if (!headerPart || !payloadPart || !signaturePart) {
        throw new FurlPayHttpError("invalid_step_up", "The step-up token is not a compact JWT");
      }
      const header = decodeJsonPart(headerPart);
      if (header.alg !== "RS256" || typeof header.kid !== "string") {
        throw new FurlPayHttpError("invalid_step_up", "The step-up token has an invalid header");
      }
      let keys = await fetchJwks();
      let jwk = keys.find((key) => key.kid === header.kid);
      if (!jwk) {
        jwksCache = null;
        keys = await fetchJwks(true);
        jwk = keys.find((key) => key.kid === header.kid);
      }
      if (!jwk) throw new FurlPayHttpError("unknown_signing_key", "The step-up token names an unpublished key");
      const parts = stepUpToken.split(".");
      const key = createPublicKey({ key: jwk as never, format: "jwk" });
      const valid = cryptoVerify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], "base64url"));
      if (!valid) throw new FurlPayHttpError("invalid_signature", "The step-up token signature did not verify");

      const claims = decodeJsonPart(payloadPart);
      const current = Math.floor(now() / 1000);
      if (claims.iss !== config.issuer) throw new FurlPayHttpError("issuer_mismatch", "The step-up token was issued by another issuer");
      const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      if (!audience.includes(config.clientId)) throw new FurlPayHttpError("audience_mismatch", "The step-up token is for another client");
      if (claims.typ !== "stepup") throw new FurlPayHttpError("invalid_step_up", "That token is not a step-up token");
      if (claims.action !== expected.action) throw new FurlPayHttpError("action_mismatch", "The step-up token authorizes a different action");
      if (claims.payload_hash !== expected.payloadHash) {
        throw new FurlPayHttpError("payload_mismatch", "The approved amount or recipient changed");
      }
      if (typeof claims.exp !== "number" || claims.exp + CLOCK_SKEW_SEC <= current) {
        throw new FurlPayHttpError("token_expired", "The step-up token has expired");
      }
      return claims;
    },

    async userInfo(accessToken: string): Promise<Record<string, unknown>> {
      const document = await discover();
      return fetchJson<Record<string, unknown>>(fetchImpl, document.userinfo_endpoint, {
        headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
        allowLoopback,
      });
    },

    async logoutUrl(input: { idTokenHint?: string; state?: string; postLogoutRedirectUri?: string } = {}): Promise<string> {
      const document = await discover();
      if (!document.end_session_endpoint) throw new FurlPayHttpError("unsupported_provider", "The issuer does not publish an end-session endpoint");
      const url = new URL(document.end_session_endpoint);
      if (input.idTokenHint) url.searchParams.set("id_token_hint", input.idTokenHint);
      url.searchParams.set("client_id", config.clientId);
      const redirect = input.postLogoutRedirectUri ?? config.postLogoutRedirectUri;
      if (redirect) url.searchParams.set("post_logout_redirect_uri", redirect);
      if (input.state) url.searchParams.set("state", input.state);
      return url.toString();
    },

    /** Clears caches; call after a key rotation event or a signing failure. */
    invalidate(): void {
      discoveryCache = null;
      jwksCache = null;
    },
  };
}

export type FurlPayOidcClient = ReturnType<typeof createFurlPayOidcClient>;
export { createPkce, createState, createNonce };
