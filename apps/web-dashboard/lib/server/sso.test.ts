import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { handle } from "./api.ts";
import { openDb } from "./db.ts";

/**
 * HTTP wiring for the SSO surface: the public SAML endpoints and the SCIM
 * administration path, driven through the same handler the route uses.
 * Protocol internals are covered by saml.test.ts, scim.test.ts and oidc.test.ts.
 */

const root = mkdtempSync(join(tmpdir(), "mc-sso-"));
process.env.MOBILECLOUD_DB = join(root, "sso.db");
process.env.MOBILECLOUD_DATA_ROOT = root;
process.env.MOBILECLOUD_BOOTSTRAP_EMAIL = "operator@example.test";
process.env.MOBILECLOUD_BOOTSTRAP_PASSWORD = "test-operator-password";
process.env.MOBILECLOUD_PUBLIC_ORIGIN = "https://console.example.test";

const origin = process.env.MOBILECLOUD_PUBLIC_ORIGIN;

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
  const response = await request("auth/login", "POST", {
    email: process.env.MOBILECLOUD_BOOTSTRAP_EMAIL,
    password: process.env.MOBILECLOUD_BOOTSTRAP_PASSWORD,
  });
  assert.equal(response.status, 200);
  const cookie = response.headers.getSetCookie().find((value) => value.startsWith("mc_session="))!.split(";")[0];
  const me = await (await request("auth/me", "GET", undefined, { cookie })).json();
  return { cookie, "x-mc-csrf": me.csrfToken as string, userId: me.user.id as string };
}

function authnRequest(): string {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_sso_test_request" Version="2.0" IssueInstant="2026-11-27T10:00:00Z" Destination="${origin}/saml/sso" AssertionConsumerServiceURL="https://sp.example.test/acs">
  <saml:Issuer>https://sp.example.test/metadata</saml:Issuer>
</samlp:AuthnRequest>`;
  return deflateRawSync(Buffer.from(xml, "utf8")).toString("base64");
}

test("SAML metadata is public and names the SSO endpoint and certificate", async () => {
  const response = await request("saml/metadata");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /samlmetadata\+xml/);
  const xml = await response.text();
  assert.match(xml, /EntityDescriptor/);
  assert.match(xml, /SingleSignOnService/);
  assert.match(xml, /<ds:X509Certificate>[A-Za-z0-9+/=]+<\/ds:X509Certificate>/);
  assert.match(xml, /\/saml\/sso/);
});

test("SAML SSO redirects an anonymous browser to sign in, then emits a signed response", async () => {
  const browser = await login();
  const provider = await request(
    "admin/saml-sps",
    "POST",
    {
      entity_id: "https://sp.example.test/metadata",
      acs_url: "https://sp.example.test/acs",
    },
    browser,
  );
  assert.equal(provider.status, 201);

  const query = new URLSearchParams({ SAMLRequest: authnRequest(), RelayState: "relay-1" }).toString();
  const anonymous = await request(`saml/sso?${query}`);
  assert.equal(anonymous.status, 302);
  const location = new URL(anonymous.headers.get("location")!);
  assert.equal(location.pathname, "/login");
  assert.match(location.searchParams.get("next") ?? "", /^\/saml\/sso\?/);

  const signed = await request(`saml/sso?${query}`, "GET", undefined, { cookie: browser.cookie });
  assert.equal(signed.status, 200);
  const html = await signed.text();
  assert.match(html, /<form[^>]+action="https:\/\/sp\.example\.test\/acs"/);
  assert.match(html, /name="SAMLResponse" value="[A-Za-z0-9+/=]+"/);
  assert.match(html, /name="RelayState" value="relay-1"/);
});

test("a malformed SAML request is refused with a client error", async () => {
  const browser = await login();
  const response = await request("saml/sso?SAMLRequest=not-base64", "GET", undefined, { cookie: browser.cookie });
  assert.equal(response.status, 400);
});

test("SCIM provisioning works end to end over HTTP and deactivation blocks sign-in", async () => {
  const browser = await login();
  const issued = await request("admin/scim-tokens", "POST", { name: "Test provisioning" }, browser);
  assert.equal(issued.status, 201);
  const { token } = await issued.json();
  assert.match(token, /^scim_/);
  const bearer = { authorization: `Bearer ${token}` };

  const config = await request("scim/v2/ServiceProviderConfig", "GET", undefined, bearer);
  assert.equal(config.status, 200);
  assert.equal(config.headers.get("content-type"), "application/scim+json");
  assert.equal((await config.json()).patch.supported, true);

  const created = await request(
    "scim/v2/Users",
    "POST",
    {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
      userName: "provisioned@example.test",
      name: { givenName: "Provisioned", familyName: "User" },
      active: true,
    },
    bearer,
  );
  assert.equal(created.status, 201);
  const user = await created.json();
  assert.equal(user.userName, "provisioned@example.test");
  assert.equal(user.displayName, "Provisioned User");
  assert.equal(user.active, true);
  assert.equal(user.meta.resourceType, "User");

  const filtered = await request(
    `scim/v2/Users?filter=${encodeURIComponent('userName eq "provisioned@example.test"')}`,
    "GET",
    undefined,
    bearer,
  );
  assert.equal(filtered.status, 200);
  assert.equal((await filtered.json()).totalResults, 1);

  const deactivated = await request(
    `scim/v2/Users/${user.id}`,
    "PATCH",
    {
      schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
      Operations: [{ op: "replace", path: "active", value: false }],
    },
    bearer,
  );
  assert.equal(deactivated.status, 200);
  assert.equal((await deactivated.json()).active, false);
  assert.equal((openDb().prepare("SELECT active FROM users WHERE id = ?").get(user.id) as { active: number }).active, 0);

  // A deactivated account cannot sign in, even with the operator password
  // reset: the active flag is checked before the password.
  const denied = await request("auth/login", "POST", {
    email: "provisioned@example.test",
    password: "any-password-at-all",
  });
  assert.equal(denied.status, 401);

  assert.equal((await request(`scim/v2/Users/${user.id}`, "DELETE", undefined, bearer)).status, 204);
  assert.equal((await request(`scim/v2/Users/${user.id}`, "GET", undefined, bearer)).status, 404);
});

test("SCIM requires its own bearer token, not a console session", async () => {
  const browser = await login();
  assert.equal((await request("scim/v2/Users", "GET", undefined, { cookie: browser.cookie })).status, 401);
  const bogus = await request("scim/v2/Users", "GET", undefined, { authorization: `Bearer scim_${"0".repeat(48)}` });
  assert.equal(bogus.status, 401);
  assert.equal((await bogus.json()).schemas[0], "urn:ietf:params:scim:api:messages:2.0:Error");
});
