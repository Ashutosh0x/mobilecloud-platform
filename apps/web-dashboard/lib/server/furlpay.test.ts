import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { handle } from "./api.ts";
import { openDb } from "./db.ts";
import {
  assertFinancialAuthorization,
  createFurlPayOidcClient,
  createFurlPayService,
  FurlPayHttpError,
  FinancialAuthorizationError,
  loadFurlPayConfig,
  MemoryIdentityLinkStore,
  ssoOnlyContext,
  type FetchLike,
} from "../../../../integrations/furlpay/src/index.ts";

/**
 * FurlPay as the first external relying party.
 *
 * The IdP is the real `handle` implementation and the RP is the module in
 * `integrations/furlpay`. Only the transport is replaced: a fetch adapter
 * feeds each outbound discovery/JWKS/token request back into the handler, so
 * signatures, discovery metadata and error documents are all real.
 */

const root = mkdtempSync(join(tmpdir(), "mc-furlpay-"));
process.env.MOBILECLOUD_DB = join(root, "furlpay.db");
process.env.MOBILECLOUD_DATA_ROOT = root;
process.env.MOBILECLOUD_BOOTSTRAP_EMAIL = "operator@example.test";
process.env.MOBILECLOUD_BOOTSTRAP_PASSWORD = "test-operator-password";
process.env.MOBILECLOUD_PUBLIC_ORIGIN = "https://console.example.test";
process.env.FURLPAY_OIDC_ENABLED = "1";
process.env.FURLPAY_OIDC_CLIENT_ID = "furlpay";
process.env.FURLPAY_OIDC_REDIRECT_URI = "https://furlpay.com/auth/mobilecloud/callback";
process.env.FURLPAY_OIDC_SCOPES = "openid profile email";
process.env.FURLPAY_OIDC_POST_LOGOUT_REDIRECT_URI = "https://furlpay.com/signed-out";

const origin = process.env.MOBILECLOUD_PUBLIC_ORIGIN;
process.env.FURLPAY_OIDC_ISSUER = origin;
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

/** Feeds the RP's outbound identity requests into the real IdP handler. */
const idpFetch: FetchLike = async (input, init) => {
  const url = new URL(String(input));
  if (url.origin !== origin) throw new Error(`The RP tried to call an unexpected origin: ${url.origin}`);
  const path = url.pathname.replace(/^\//, "");
  return handle(new Request(url.toString(), init), path.split("/"));
};

type Browser = { cookie: string; "x-mc-csrf": string; userId: string };

async function login(): Promise<Browser> {
  const response = await request("auth/login", "POST", credentials);
  assert.equal(response.status, 200);
  const cookie = response.headers.getSetCookie().find((value) => value.startsWith("mc_session="))!.split(";")[0];
  const me = await (await request("auth/me", "GET", undefined, { cookie })).json();
  return { cookie, "x-mc-csrf": me.csrfToken as string, userId: me.user.id as string };
}

function config() {
  return loadFurlPayConfig(process.env);
}

function service() {
  return createFurlPayService(config(), { fetch: idpFetch, linkStore: new MemoryIdentityLinkStore() });
}

/** Runs beginLogin + the browser's consent POST, returning the callback code. */
async function authorize(rp: ReturnType<typeof service>, browser: Browser) {
  const started = await rp.beginLogin();
  const authUrl = new URL(started.url);
  const consent = await request(
    "oauth/authorize",
    "POST",
    {
      client_id: authUrl.searchParams.get("client_id"),
      redirect_uri: authUrl.searchParams.get("redirect_uri"),
      code_challenge: authUrl.searchParams.get("code_challenge"),
      code_challenge_method: "S256",
      scope: authUrl.searchParams.get("scope"),
      state: authUrl.searchParams.get("state"),
      nonce: authUrl.searchParams.get("nonce"),
      decision: "approve",
    },
    { ...browser, accept: "application/json" },
  );
  assert.equal(consent.status, 200);
  const redirect = new URL((await consent.json()).redirect);
  return {
    transaction: started.transaction,
    code: redirect.searchParams.get("code")!,
    state: redirect.searchParams.get("state")!,
  };
}

test("a first federated login creates no FurlPay account silently and no session", async () => {
  const browser = await login();
  const rp = service();
  const { transaction, code, state } = await authorize(rp, browser);
  const completed = await rp.completeLogin({ code, state, transaction, resolveLocalAccount: () => null });
  assert.equal(completed.resolution.status, "create_account");
  assert.equal(completed.session, null);
  assert.equal(completed.claims.iss, origin);
  assert.equal(completed.claims.aud, "furlpay");
  assert.equal(completed.claims.email, credentials.email);
  assert.equal(completed.claims.nonce, transaction.nonce);

  // Creating the FurlPay account and linking it is an explicit two-step act.
  const account = { id: "fp-1", email: completed.claims.email!, displayName: "FurlPay user" };
  const pending = rp.linking.beginExplicitLink(
    { issuer: completed.claims.iss, subject: completed.claims.sub, email: completed.claims.email ?? null },
    account,
    account.id,
  );
  assert.equal(
    rp.linking.confirmExplicitLink(pending, { decision: "approve", authenticatedAccountId: account.id }).status,
    "linked",
  );

  const again = await authorize(rp, browser);
  const second = await rp.completeLogin({
    code: again.code,
    state: again.state,
    transaction: again.transaction,
    resolveLocalAccount: () => account,
  });
  assert.equal(second.resolution.status, "linked");
  assert.ok(second.session);
  assert.equal(second.session.accountId, "fp-1");
  assert.equal(second.session.financialStepUp, false);
});

test("an existing FurlPay account is never merged by matching email", async () => {
  const browser = await login();
  const rp = service();
  const first = await authorize(rp, browser);
  const completed = await rp.completeLogin({ code: first.code, state: first.state, transaction: first.transaction, resolveLocalAccount: () => null });
  const sameEmailAccount = { id: "fp-existing", email: completed.claims.email!, displayName: "Existing" };
  assert.equal(rp.linking.resolve({ issuer: completed.claims.iss, subject: completed.claims.sub, email: completed.claims.email ?? null }, sameEmailAccount).status, "link_required");

  const second = await authorize(rp, browser);
  const loginResult = await rp.completeLogin({
    code: second.code,
    state: second.state,
    transaction: second.transaction,
    resolveLocalAccount: () => sameEmailAccount,
  });
  assert.equal(loginResult.resolution.status, "link_required");
  assert.equal(loginResult.session, null);
  assert.equal(rp.store.findByAccount("fp-existing"), null, "no link exists until the user confirms");

  const pending = (loginResult.resolution as { pendingToken: string }).pendingToken;
  assert.throws(
    () => rp.linking.confirmExplicitLink(pending, { decision: "approve", authenticatedAccountId: "fp-attacker" }),
    /different FurlPay account/,
  );
});

test("state and nonce are verified before a session can exist", async () => {
  const browser = await login();
  const rp = service();
  const { transaction, code, state } = await authorize(rp, browser);

  await assert.rejects(
    rp.completeLogin({ code, state: "wrong-state", transaction, resolveLocalAccount: () => null }),
    /state does not match/,
  );

  const second = await authorize(rp, browser);
  const tampered = { ...second.transaction, nonce: "not-the-nonce" };
  await assert.rejects(
    rp.completeLogin({ code: second.code, state: second.state, transaction: tampered, resolveLocalAccount: () => null }),
    (error: unknown) => error instanceof FurlPayHttpError && error.code === "nonce_mismatch",
  );
});

test("issuer, audience and signature are enforced on the ID token", async () => {
  const browser = await login();
  const rp = service();
  const { transaction, code, state } = await authorize(rp, browser);
  const completed = await rp.completeLogin({ code, state, transaction, resolveLocalAccount: () => null });

  const wrongAudience = createFurlPayOidcClient({ ...config(), clientId: "another-client" }, { fetch: idpFetch });
  await assert.rejects(
    wrongAudience.verifyIdToken(completed.tokens.id_token, transaction.nonce),
    (error: unknown) => error instanceof FurlPayHttpError && error.code === "audience_mismatch",
  );

  const [header, payload, signature] = completed.tokens.id_token.split(".");
  const tampered = `${header}.${payload}.${signature.slice(0, -4)}AAAA`;
  await assert.rejects(
    rp.oidc.verifyIdToken(tampered, transaction.nonce),
    (error: unknown) => error instanceof FurlPayHttpError && error.code === "invalid_signature",
  );
});

test("an authorization code is single use and expires", async () => {
  const browser = await login();
  const rp = service();
  const { transaction, code, state } = await authorize(rp, browser);
  const tokens = await rp.oidc.exchangeCode({ code, codeVerifier: transaction.codeVerifier });
  assert.ok(tokens.id_token);
  await assert.rejects(
    rp.oidc.exchangeCode({ code, codeVerifier: transaction.codeVerifier }),
    (error: unknown) => error instanceof FurlPayHttpError && error.code === "http_error" && error.status === 400,
  );

  const expired = await authorize(rp, browser);
  openDb().prepare("UPDATE oauth_authorization_codes SET expires_at = ? WHERE used = 0").run(Date.now() - 1_000);
  await assert.rejects(
    rp.oidc.exchangeCode({ code: expired.code, codeVerifier: expired.transaction.codeVerifier }),
    (error: unknown) => error instanceof FurlPayHttpError && error.status === 400,
  );
});

test("logout ends the MobileCloud session but not FurlPay's own session", async () => {
  const browser = await login();
  const rp = service();
  const { transaction, code, state } = await authorize(rp, browser);
  const completed = await rp.completeLogin({ code, state, transaction, resolveLocalAccount: () => null });
  const account = { id: "fp-logout", email: completed.claims.email!, displayName: "Logout" };
  const pending = rp.linking.beginExplicitLink(
    { issuer: completed.claims.iss, subject: completed.claims.sub, email: completed.claims.email ?? null },
    account,
    account.id,
  );
  rp.linking.confirmExplicitLink(pending, { decision: "approve", authenticatedAccountId: account.id });
  const loginAgain = await authorize(rp, browser);
  const linked = await rp.completeLogin({ code: loginAgain.code, state: loginAgain.state, transaction: loginAgain.transaction, resolveLocalAccount: () => account });
  const session = linked.session!;

  const url = await rp.oidc.logoutUrl({ idTokenHint: linked.tokens.id_token });
  assert.match(url, /\/oauth\/logout/);
  assert.match(url, /post_logout_redirect_uri=https%3A%2F%2Ffurlpay\.com%2Fsigned-out/);
  const logout = await request(
    "oauth/logout?client_id=furlpay&post_logout_redirect_uri=" + encodeURIComponent("https://furlpay.com/signed-out"),
    "GET",
    undefined,
    { cookie: browser.cookie },
  );
  assert.equal(logout.status, 302);
  assert.equal((await request("overview", "GET", undefined, { cookie: browser.cookie })).status, 401);
  // FurlPay owns its session: the IdP logout is not a FurlPay session revocation.
  assert.equal(session.accountId, "fp-logout");
  assert.ok(session.expiresAt > Date.now());
});

test("an SSO session can never authorize a FurlPay financial action", () => {
  const context = ssoOnlyContext("fp-1", "session-1");
  for (const action of ["payment.initiate", "withdrawal.create", "wallet.sign", "agent.spend"] as const) {
    assert.throws(
      () => assertFinancialAuthorization(context, action),
      (error: unknown) => error instanceof FinancialAuthorizationError && error.code === "financial_step_up_required",
    );
  }
  const now = 1_800_000_000_000;
  assert.throws(
    () => assertFinancialAuthorization({ ...context, methods: ["sso", "passkey"], deviceBound: true, stepUpAt: now }, "payment.initiate", { now: () => now + 6 * 60_000 }),
    FinancialAuthorizationError,
  );
  assert.doesNotThrow(() =>
    assertFinancialAuthorization({ ...context, methods: ["passkey"], deviceBound: true, stepUpAt: now }, "payment.initiate", { now: () => now + 30_000 }),
  );
});

test("introspection and client management work over the API", async () => {
  const browser = await login();
  const rp = service();
  const { transaction, code, state } = await authorize(rp, browser);
  const tokens = await rp.completeLogin({ code, state, transaction, resolveLocalAccount: () => null }).then((result) => result.tokens);

  const introspection = await request(
    "oauth/introspect",
    "POST",
    new URLSearchParams({ token: tokens.access_token, client_id: "furlpay" }).toString(),
  );
  assert.equal(introspection.status, 200);
  const info = await introspection.json();
  assert.equal(info.active, true);
  assert.equal(info.client_id, "furlpay");
  assert.equal(info.sub, browser.userId);

  await request("oauth/revoke", "POST", new URLSearchParams({ token: tokens.access_token }).toString());
  const revoked = await (await request("oauth/introspect", "POST", new URLSearchParams({ token: tokens.access_token, client_id: "furlpay" }).toString())).json();
  assert.equal(revoked.active, false);

  const list = await request("oauth/clients", "GET", undefined, browser);
  assert.equal(list.status, 200);
  assert.ok((await list.json()).clients.some((client: { client_id: string }) => client.client_id === "furlpay"));

  const created = await request(
    "oauth/clients",
    "POST",
    { name: "Managed app", redirect_uris: ["https://managed.example.test/cb"], scopes: ["openid"] },
    browser,
  );
  assert.equal(created.status, 201);
  const managed = await created.json();
  const patched = await request(`oauth/clients/${managed.client.client_id}`, "PATCH", { name: "Renamed app" }, browser);
  assert.equal(patched.status, 200);
  assert.equal((await patched.json()).client.name, "Renamed app");
  assert.equal((await request(`oauth/clients/${managed.client.client_id}`, "DELETE", undefined, browser)).status, 200);
});

test("signing-key rotation publishes an overlap key and keeps old tokens verifiable", async () => {
  const browser = await login();
  const rp = service();
  const { transaction, code, state } = await authorize(rp, browser);
  const completed = await rp.completeLogin({ code, state, transaction, resolveLocalAccount: () => null });
  const oldHeader = JSON.parse(Buffer.from(completed.tokens.id_token.split(".")[0], "base64url").toString());

  const rotated = await request("admin/signing-keys/rotate", "POST", {}, browser);
  assert.equal(rotated.status, 200);
  const next = await rotated.json();
  assert.notEqual(next.kid, oldHeader.kid);

  const keys = await (await request(".well-known/jwks.json")).json();
  const kids = (keys.keys as { kid: string }[]).map((key) => key.kid);
  assert.ok(kids.includes(oldHeader.kid), "the old key remains published during the overlap");
  assert.ok(kids.includes(next.kid));

  const oldStillValid = await rp.oidc.verifyIdToken(completed.tokens.id_token, transaction.nonce);
  assert.equal(oldStillValid.iss, origin);
});
