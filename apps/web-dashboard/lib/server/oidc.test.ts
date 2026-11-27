import assert from "node:assert/strict";
import { createHash, createPublicKey, randomBytes, verify as cryptoVerify } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { handle } from "./api.ts";

/**
 * The OIDC provider, exercised through the same handlers a client calls.
 *
 * These tests are the contract for discovery, PKCE, ID-token signatures,
 * userinfo, revocation, and client authentication. They use a real RSA key and
 * verify the signature the way a relying party does, rather than decoding the
 * token and trusting the payload.
 */

const root = mkdtempSync(join(tmpdir(), "mc-oidc-"));
process.env.MOBILECLOUD_DB = join(root, "oidc.db");
process.env.MOBILECLOUD_DATA_ROOT = root;
process.env.MOBILECLOUD_BOOTSTRAP_EMAIL = "operator@example.test";
process.env.MOBILECLOUD_BOOTSTRAP_PASSWORD = "test-operator-password";
process.env.MOBILECLOUD_PUBLIC_ORIGIN = "https://console.example.test";

const origin = process.env.MOBILECLOUD_PUBLIC_ORIGIN;
const credentials = { email: process.env.MOBILECLOUD_BOOTSTRAP_EMAIL, password: process.env.MOBILECLOUD_BOOTSTRAP_PASSWORD };

function request(path: string, method = "GET", body?: object | string, headers?: HeadersInit) {
  const all = new Headers(headers);
  if (body !== undefined) {
    all.set("content-type", typeof body === "string" ? "application/x-www-form-urlencoded" : "application/json");
  }
  const [pathname] = path.split("?");
  return handle(
    new Request(`${origin}/api/${path}`, {
      method,
      headers: all,
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    }),
    pathname.split("/"),
  );
}

type Browser = { cookie: string; "x-mc-csrf": string; userId: string };

async function login(): Promise<Browser> {
  const response = await request("auth/login", "POST", credentials, { origin });
  assert.equal(response.status, 200);
  const cookie = response.headers.getSetCookie().find((value) => value.startsWith("mc_session="))!.split(";")[0];
  const me = await (await request("auth/me", "GET", undefined, { cookie })).json();
  return { cookie, "x-mc-csrf": me.csrfToken as string, userId: me.user.id as string };
}

function pkce() {
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

async function registerClient(browser: Browser, body: Record<string, unknown>) {
  const response = await request("admin/oidc-clients", "POST", body, browser);
  assert.equal(response.status, 201);
  return response.json();
}

/** Verifies a compact RS256 JWT against the issuer's published JWKS. */
async function verifyJwt(token: string) {
  const [headerPart, payloadPart, signaturePart] = token.split(".");
  const header = JSON.parse(Buffer.from(headerPart, "base64url").toString("utf8"));
  const payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
  const keys = await (await request(".well-known/jwks.json")).json();
  const jwk = (keys.keys as Record<string, unknown>[]).find((key) => key.kid === header.kid);
  assert.ok(jwk, "the ID token names a published key");
  const publicKey = createPublicKey({ key: jwk as never, format: "jwk" });
  const valid = cryptoVerify(
    "RSA-SHA256",
    Buffer.from(`${headerPart}.${payloadPart}`),
    publicKey,
    Buffer.from(signaturePart, "base64url"),
  );
  assert.equal(valid, true);
  return { header, payload };
}

test("discovery and JWKS describe a usable RS256 provider", async () => {
  const config = await (await request(".well-known/openid-configuration")).json();
  assert.equal(config.issuer, origin);
  assert.equal(config.authorization_endpoint, `${origin}/oauth/authorize`);
  assert.equal(config.token_endpoint, `${origin}/oauth/token`);
  assert.equal(config.userinfo_endpoint, `${origin}/oauth/userinfo`);
  assert.equal(config.jwks_uri, `${origin}/.well-known/jwks.json`);
  assert.equal(config.revocation_endpoint, `${origin}/oauth/revoke`);
  assert.deepEqual(config.response_types_supported, ["code"]);
  assert.ok(config.id_token_signing_alg_values_supported.includes("RS256"));
  assert.deepEqual(config.code_challenge_methods_supported, ["S256"]);
  assert.equal(config.backchannel_logout_supported, true);

  const keys = await (await request(".well-known/jwks.json")).json();
  assert.ok(Array.isArray(keys.keys) && keys.keys.length >= 1);
  assert.equal(keys.keys[0].kty, "RSA");
  assert.equal(keys.keys[0].alg, "RS256");
  assert.ok(keys.keys[0].n && keys.keys[0].e && keys.keys[0].kid);
});

test("authorization code + PKCE issues a verifiable ID token and userinfo", async () => {
  const browser = await login();
  const created = await registerClient(browser, {
    name: "Example App",
    redirect_uris: ["https://app.example.test/callback"],
    post_logout_redirect_uris: ["https://app.example.test/signed-out"],
    scopes: ["openid", "profile", "email"],
    public: true,
  });
  assert.equal(created.client.public, true);
  assert.equal(created.client_secret, null);

  const { verifier, challenge } = pkce();
  const consent = await request(
    "oauth/authorize",
    "POST",
    {
      client_id: created.client.client_id,
      redirect_uri: "https://app.example.test/callback",
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: "openid profile email",
      state: "state-123",
      nonce: "nonce-abc",
      decision: "approve",
    },
    { ...browser, accept: "application/json" },
  );
  assert.equal(consent.status, 200);
  const location = (await consent.json()).redirect as string;
  const redirect = new URL(location);
  assert.equal(redirect.origin + redirect.pathname, "https://app.example.test/callback");
  assert.equal(redirect.searchParams.get("state"), "state-123");
  const code = redirect.searchParams.get("code");
  assert.ok(code);

  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code: code!,
    redirect_uri: "https://app.example.test/callback",
    client_id: created.client.client_id,
    code_verifier: verifier,
  }).toString();
  const tokenResponse = await request("oauth/token", "POST", form);
  assert.equal(tokenResponse.status, 200);
  const tokens = await tokenResponse.json();
  assert.match(tokens.access_token, /^mc_/);
  assert.match(tokens.refresh_token, /^mcr_/);
  assert.equal(tokens.token_type, "Bearer");
  assert.ok(tokens.id_token);

  const { payload } = await verifyJwt(tokens.id_token);
  assert.equal(payload.iss, origin);
  assert.equal(payload.aud, created.client.client_id);
  assert.equal(payload.nonce, "nonce-abc");
  assert.equal(payload.sub, browser.userId);
  assert.equal(payload.email, credentials.email);
  assert.equal(payload.email_verified, true);
  assert.ok(payload.name);

  const userinfo = await request("oauth/userinfo", "GET", undefined, { authorization: `Bearer ${tokens.access_token}` });
  assert.equal(userinfo.status, 200);
  const claims = await userinfo.json();
  assert.equal(claims.sub, browser.userId);
  assert.equal(claims.email, credentials.email);

  // The authorization code is single use, even with the right verifier.
  assert.equal((await request("oauth/token", "POST", form)).status, 400);
});

test("a confidential client must present its secret at the token endpoint", async () => {
  const browser = await login();
  const created = await registerClient(browser, {
    name: "Confidential App",
    redirect_uris: ["https://secret.example.test/callback"],
    scopes: ["openid", "email"],
    public: false,
  });
  assert.match(created.client_secret, /^mcs_/);

  const { verifier, challenge } = pkce();
  const consent = await request(
    "oauth/authorize",
    "POST",
    {
      client_id: created.client.client_id,
      redirect_uri: "https://secret.example.test/callback",
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: "openid email",
      decision: "approve",
    },
    { ...browser, accept: "application/json" },
  );
  const code = new URL((await consent.json()).redirect).searchParams.get("code")!;
  const base = {
    grant_type: "authorization_code",
    code,
    redirect_uri: "https://secret.example.test/callback",
    client_id: created.client.client_id,
    code_verifier: verifier,
  };

  const unauthenticated = await request("oauth/token", "POST", new URLSearchParams(base).toString());
  assert.equal(unauthenticated.status, 401);
  assert.equal((await unauthenticated.json()).error, "invalid_client");

  const basic = Buffer.from(`${created.client.client_id}:${created.client_secret}`).toString("base64");
  const authenticated = await request(
    "oauth/token",
    "POST",
    new URLSearchParams(base).toString(),
    { authorization: `Basic ${basic}` },
  );
  assert.equal(authenticated.status, 200);
  const tokens = await authenticated.json();
  assert.ok(tokens.id_token);
  const { payload } = await verifyJwt(tokens.id_token);
  assert.equal(payload.email, credentials.email);
  // The email scope was requested, but not profile.
  assert.equal(payload.name, undefined);
});

test("revocation ends the token and a replayed refresh token is refused", async () => {
  const browser = await login();
  const created = await registerClient(browser, {
    name: "Revocation App",
    redirect_uris: ["https://revoke.example.test/callback"],
    scopes: ["openid"],
    public: true,
  });
  const { verifier, challenge } = pkce();
  const consent = await request(
    "oauth/authorize",
    "POST",
    {
      client_id: created.client.client_id,
      redirect_uri: "https://revoke.example.test/callback",
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: "openid",
      decision: "approve",
    },
    { ...browser, accept: "application/json" },
  );
  const code = new URL((await consent.json()).redirect).searchParams.get("code")!;
  const tokens = await (
    await request(
      "oauth/token",
      "POST",
      new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: "https://revoke.example.test/callback",
        client_id: created.client.client_id,
        code_verifier: verifier,
      }).toString(),
    )
  ).json();

  const rotated = await request(
    "oauth/token",
    "POST",
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: created.client.client_id,
    }).toString(),
  );
  assert.equal(rotated.status, 200);
  const next = await rotated.json();
  assert.notEqual(next.refresh_token, tokens.refresh_token);

  // Reusing the old refresh token is evidence of theft: the family is revoked.
  const replay = await request(
    "oauth/token",
    "POST",
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: created.client.client_id,
    }).toString(),
  );
  assert.equal(replay.status, 400);
  const descendant = await request(
    "oauth/token",
    "POST",
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: next.refresh_token,
      client_id: created.client.client_id,
    }).toString(),
  );
  assert.equal(descendant.status, 400);

  // Revocation is idempotent and never reveals whether the token existed.
  const revoke = await request("oauth/revoke", "POST", new URLSearchParams({ token: next.access_token }).toString());
  assert.equal(revoke.status, 200);
  assert.equal(
    (await request("oauth/userinfo", "GET", undefined, { authorization: `Bearer ${next.access_token}` })).status,
    401,
  );
  assert.equal((await request("oauth/revoke", "POST", new URLSearchParams({ token: "mc_unknown" }).toString())).status, 200);
});

test("unregistered redirect URIs and unknown clients are refused at consent", async () => {
  const browser = await login();
  const created = await registerClient(browser, {
    name: "Strict App",
    redirect_uris: ["https://strict.example.test/callback"],
    scopes: ["openid"],
    public: true,
  });
  const { challenge } = pkce();
  const wrongRedirect = await request(
    "oauth/authorize",
    "POST",
    {
      client_id: created.client.client_id,
      redirect_uri: "https://strict.example.test/other",
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: "openid",
      decision: "approve",
    },
    { ...browser, accept: "application/json" },
  );
  assert.equal(wrongRedirect.status, 400);

  const unknown = await request(
    "oauth/authorize",
    "POST",
    {
      client_id: "no-such-client",
      redirect_uri: "https://strict.example.test/callback",
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: "openid",
      decision: "approve",
    },
    { ...browser, accept: "application/json" },
  );
  assert.equal(unknown.status, 400);
});

test("logging out clears the session and honours only registered post-logout redirects", async () => {
  const browser = await login();
  const created = await registerClient(browser, {
    name: "Logout App",
    redirect_uris: ["https://logout.example.test/callback"],
    post_logout_redirect_uris: ["https://logout.example.test/signed-out"],
    scopes: ["openid"],
    public: true,
  });
  const logout = await request(
    `oauth/logout?client_id=${encodeURIComponent(created.client.client_id)}&post_logout_redirect_uri=${encodeURIComponent("https://logout.example.test/signed-out")}`,
    "GET",
    undefined,
    { cookie: browser.cookie },
  );
  assert.equal(logout.status, 302);
  assert.equal(logout.headers.get("location"), "https://logout.example.test/signed-out");
  assert.ok(logout.headers.getSetCookie().some((cookie) => cookie.startsWith("mc_session=") && cookie.includes("Max-Age=0")));

  const stillIn = await request("overview", "GET", undefined, { cookie: browser.cookie });
  assert.equal(stillIn.status, 401);

  const unregistered = await request(
    `oauth/logout?client_id=${encodeURIComponent(created.client.client_id)}&post_logout_redirect_uri=${encodeURIComponent("https://evil.example.test/")}`,
    "GET",
    undefined,
    { cookie: browser.cookie },
  );
  assert.equal(unregistered.status, 400);
});
