import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { openDb, tokenHash } from "./db.ts";
import {
  authenticateScim,
  createGroup,
  createScimToken,
  createUser,
  deleteGroup,
  deleteUser,
  getGroup,
  getUser,
  listGroups,
  listScimTokens,
  listUsers,
  patchGroup,
  patchUser,
  replaceUser,
  revokeScimToken,
  ScimError,
  serviceProviderConfig,
} from "./scim.ts";

const USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
const GROUP_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:Group";
const ERROR_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:Error";
const PATCH_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:PatchOp";

function freshDb(): DatabaseSync {
  const file = join(mkdtempSync(join(tmpdir(), "mc-scim-")), "t.db");
  const db = openDb(file);
  db.prepare(
    "INSERT INTO users (id, email, name, password_hash, role, plan, created_at) VALUES ('u1', 'owner@example.com', 'Owner', '!', 'owner', 'community', ?)",
  ).run(Date.now());
  return db;
}

function asObject(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function nested(value: unknown, key: string): Record<string, unknown> {
  return asObject(asObject(value)[key]);
}

function resource(result: { body: unknown }): Record<string, unknown> {
  return asObject(result.body);
}

function newUser(db: DatabaseSync, userName: string, extra: Record<string, unknown> = {}): string {
  const result = createUser(db, { schemas: [USER_SCHEMA], userName, ...extra });
  assert.equal(result.status, 201);
  return String(resource(result).id);
}

function count(db: DatabaseSync, sql: string, ...params: (string | number)[]): number {
  const row = db.prepare(sql).get(...params) as { n: number } | undefined;
  return Number(row?.n ?? 0);
}

test("a SCIM token is hashed at rest, authenticates, and is revocable", () => {
  const db = freshDb();
  const created = createScimToken(db, "u1", "Okta provisioning");
  assert.match(created.token, /^scim_[a-f0-9]{48}$/);
  assert.equal(created.prefix, created.token.slice(0, 12));

  const stored = db.prepare("SELECT token_hash, last_used FROM scim_tokens WHERE id = ?").get(created.id) as {
    token_hash: string;
    last_used: number | null;
  };
  assert.equal(stored.token_hash, createHash("sha256").update(created.token).digest("hex"));
  assert.notEqual(stored.token_hash, created.token);
  assert.equal(stored.last_used, null);

  assert.deepEqual(authenticateScim(db, `Bearer ${created.token}`), { ownerId: "u1", tokenId: created.id });
  assert.equal(authenticateScim(db, null), null);
  assert.equal(authenticateScim(db, ""), null);
  // The HTTP auth scheme is case-insensitive; the scim_ token literal is not.
  assert.ok(authenticateScim(db, `bearer ${created.token}`));
  assert.equal(authenticateScim(db, `Bearer ${created.token.toUpperCase()}`), null);
  assert.equal(authenticateScim(db, `Bearer scim_${"0".repeat(48)}`), null);

  const listed = listScimTokens(db, "u1");
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, created.id);
  assert.equal(listed[0].name, "Okta provisioning");
  assert.equal(listed[0].prefix, created.prefix);
  assert.ok(typeof listed[0].createdAt === "number");
  assert.ok(typeof listed[0].lastUsed === "number");

  assert.equal(revokeScimToken(db, "u1", created.id), true);
  assert.equal(revokeScimToken(db, "u1", created.id), false);
  assert.equal(authenticateScim(db, `Bearer ${created.token}`), null);
  assert.deepEqual(listScimTokens(db, "u1"), []);
  db.close();
});

test("the token's last_used marker is refreshed at most once a minute", () => {
  const db = freshDb();
  const created = createScimToken(db, "u1", "Okta");
  assert.ok(authenticateScim(db, `Bearer ${created.token}`));
  const recent = Date.now() - 30_000;
  db.prepare("UPDATE scim_tokens SET last_used = ? WHERE id = ?").run(recent, created.id);
  assert.ok(authenticateScim(db, `Bearer ${created.token}`));
  const unchanged = db.prepare("SELECT last_used FROM scim_tokens WHERE id = ?").get(created.id) as { last_used: number };
  assert.equal(unchanged.last_used, recent);

  const old = Date.now() - 61_000;
  db.prepare("UPDATE scim_tokens SET last_used = ? WHERE id = ?").run(old, created.id);
  assert.ok(authenticateScim(db, `Bearer ${created.token}`));
  const refreshed = db.prepare("SELECT last_used FROM scim_tokens WHERE id = ?").get(created.id) as { last_used: number };
  assert.ok(refreshed.last_used > old);
  db.close();
});

test("a token can only be revoked by the account that owns it", () => {
  const db = freshDb();
  db.prepare(
    "INSERT INTO users (id, email, name, password_hash, role, plan, created_at) VALUES ('u2', 'second@example.com', 'Second', '!', 'member', 'community', ?)",
  ).run(Date.now());
  const created = createScimToken(db, "u1", "Okta");
  assert.equal(revokeScimToken(db, "u2", created.id), false);
  assert.ok(authenticateScim(db, `Bearer ${created.token}`));
  db.close();
});

test("serviceProviderConfig advertises only implemented capabilities", () => {
  const config = serviceProviderConfig();
  assert.deepEqual(config.schemas, ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"]);
  assert.equal(nested(config, "patch").supported, true);
  assert.equal(nested(config, "filter").supported, true);
  assert.equal(nested(config, "bulk").supported, false);
  assert.equal(nested(config, "changePassword").supported, false);
  assert.equal(nested(config, "etag").supported, false);
  const schemes = config.authenticationSchemes as { type: string }[];
  assert.equal(schemes[0].type, "oauthbearertoken");
});

test("createUser validates input, derives a name, and ignores privilege fields", () => {
  const db = freshDb();
  const result = createUser(db, {
    schemas: [USER_SCHEMA],
    userName: "Alice@Example.COM",
    name: { givenName: "Alice", familyName: "Smith" },
    externalId: "ext-1",
    // A provisioning client must never be able to choose these.
    role: "owner",
    password: "chosen-by-the-client",
  });
  assert.equal(result.status, 201);
  const user = resource(result);
  assert.deepEqual(user.schemas, [USER_SCHEMA]);
  assert.equal(user.userName, "alice@example.com");
  assert.equal(user.displayName, "Alice Smith");
  assert.equal(user.externalId, "ext-1");
  assert.equal(user.active, true);
  const name = asObject(user.name);
  assert.equal(name.givenName, "Alice");
  assert.equal(name.familyName, "Smith");
  assert.equal(name.formatted, "Alice Smith");
  const emails = user.emails as Record<string, unknown>[];
  assert.deepEqual(emails, [{ value: "alice@example.com", primary: true, type: "work" }]);
  const meta = asObject(user.meta);
  assert.equal(meta.resourceType, "User");
  assert.equal(meta.location, `/scim/v2/Users/${String(user.id)}`);
  assert.ok(!Number.isNaN(Date.parse(String(meta.created))));
  assert.ok(!Number.isNaN(Date.parse(String(meta.lastModified))));

  const row = db.prepare("SELECT email, name, role, plan, password_hash, active FROM users WHERE id = ?").get(String(user.id)) as {
    email: string;
    name: string;
    role: string;
    plan: string;
    password_hash: string;
    active: number;
  };
  assert.equal(row.email, "alice@example.com");
  assert.equal(row.name, "Alice Smith");
  assert.equal(row.role, "member");
  assert.equal(row.plan, "community");
  assert.equal(row.password_hash, "!");
  assert.equal(row.active, 1);

  // name.formatted wins over the parts; a missing name still falls back to the
  // email, and active defaults to true.
  const formatted = createUser(db, { userName: "formatted@example.com", name: { formatted: "Formatted Person" } });
  assert.equal(resource(formatted).displayName, "Formatted Person");
  const minimal = createUser(db, { userName: "minimal@example.com" });
  assert.equal(resource(minimal).displayName, "minimal@example.com");
  const inactive = createUser(db, { userName: "inactive@example.com", active: false });
  assert.equal(resource(inactive).active, false);
  db.close();
});

test("a duplicate email is rejected as a uniqueness conflict", () => {
  const db = freshDb();
  newUser(db, "alice@example.com");
  const duplicate = createUser(db, { userName: "ALICE@example.com" });
  assert.equal(duplicate.status, 409);
  const error = asObject(duplicate.body);
  assert.deepEqual(error.schemas, [ERROR_SCHEMA]);
  assert.equal(error.status, "409");
  assert.equal(error.scimType, "uniqueness");
  db.close();
});

test("listUsers pages and filters by userName or externalId", () => {
  const db = freshDb();
  const alice = newUser(db, "alice@example.com", { externalId: "ext-alice" });
  const bob = newUser(db, "bob@example.com", { externalId: "ext-bob" });

  const byName = listUsers(db, { filter: 'userName eq "alice@example.com"' });
  assert.equal(byName.totalResults, 1);
  assert.equal(byName.startIndex, 1);
  assert.equal(byName.itemsPerPage, 1);
  assert.equal(String(asObject(byName.Resources[0]).id), alice);

  // Attribute names and the email value are both compared case-insensitively.
  const upper = listUsers(db, { filter: 'USERNAME eq "ALICE@EXAMPLE.COM"' });
  assert.equal(upper.totalResults, 1);

  const byExternal = listUsers(db, { filter: 'externalId eq "ext-bob"' });
  assert.equal(byExternal.totalResults, 1);
  assert.equal(String(asObject(byExternal.Resources[0]).id), bob);

  const missing = listUsers(db, { filter: 'userName eq "nobody@example.com"' });
  assert.equal(missing.totalResults, 0);
  assert.deepEqual(missing.Resources, []);

  // The owner plus the two SCIM users.
  const all = listUsers(db, {});
  assert.equal(all.totalResults, 3);
  const secondPage = listUsers(db, { startIndex: 2, count: 1 });
  assert.equal(secondPage.totalResults, 3);
  assert.equal(secondPage.startIndex, 2);
  assert.equal(secondPage.itemsPerPage, 1);
  assert.equal(secondPage.Resources.length, 1);
  db.close();
});

test("getUser returns the resource or null", () => {
  const db = freshDb();
  const id = newUser(db, "alice@example.com", { externalId: "ext-1" });
  const user = asObject(getUser(db, id));
  assert.equal(user.userName, "alice@example.com");
  assert.equal(getUser(db, "does-not-exist"), null);
  db.close();
});

test("PATCH active:false deprovisions sessions, access tokens and refresh tokens", () => {
  const db = freshDb();
  const id = newUser(db, "alice@example.com");
  const now = Date.now();
  db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at, csrf) VALUES ('session-hash', ?, ?, 'csrf')").run(
    id,
    now + 86_400_000,
  );
  db.prepare(
    "INSERT INTO access_tokens (id, owner_id, name, token_hash, prefix, created_at, expires_at) VALUES ('at1', ?, 'cli', 'access-hash', 'mc_1234567', ?, ?)",
  ).run(id, now, now + 3_600_000);
  db.prepare(
    "INSERT INTO refresh_tokens (id, user_id, token_hash, client_type, scope, created_at, expires_at) VALUES ('rt1', ?, 'refresh-hash', 'cli', 'cli:full', ?, ?)",
  ).run(id, now, now + 86_400_000);

  const result = patchUser(db, id, {
    schemas: [PATCH_SCHEMA],
    Operations: [{ op: "replace", path: "active", value: false }],
  });
  assert.equal(result.status, 200);
  assert.equal(resource(result).active, false);

  const row = db.prepare("SELECT active FROM users WHERE id = ?").get(id) as { active: number };
  assert.equal(row.active, 0);
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?", id), 0);
  const access = db.prepare("SELECT expires_at FROM access_tokens WHERE id = 'at1'").get() as { expires_at: number };
  assert.ok(access.expires_at <= Date.now());
  const refresh = db.prepare("SELECT revoked FROM refresh_tokens WHERE id = 'rt1'").get() as { revoked: number };
  assert.equal(refresh.revoked, 1);

  const events = db.prepare("SELECT event_type, outcome FROM auth_events WHERE user_id = ?").all(id) as {
    event_type: string;
    outcome: string;
  }[];
  assert.equal(events.length, 1);
  assert.equal(events[0].event_type, "auth.user.deactivated");
  assert.equal(events[0].outcome, "success");

  // Reactivation is explicit and does not resurrect the dead credentials.
  const reactivated = patchUser(db, id, {
    schemas: [PATCH_SCHEMA],
    Operations: [{ op: "replace", path: "active", value: true }],
  });
  assert.equal(reactivated.status, 200);
  assert.equal(resource(reactivated).active, true);
  assert.equal((db.prepare("SELECT active FROM users WHERE id = ?").get(id) as { active: number }).active, 1);
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?", id), 0);
  db.close();
});

test("PUT active:false also deprovisions immediately", () => {
  const db = freshDb();
  const id = newUser(db, "alice@example.com");
  db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ('session-hash', ?, ?)").run(id, Date.now() + 86_400_000);
  const result = replaceUser(db, id, {
    schemas: [USER_SCHEMA],
    userName: "alice@example.com",
    active: false,
  });
  assert.equal(result.status, 200);
  assert.equal(resource(result).active, false);
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?", id), 0);
  db.close();
});

test("PATCH updates name parts and externalId, and a path-less object works", () => {
  const db = freshDb();
  const id = newUser(db, "alice@example.com", { name: { givenName: "Alice", familyName: "Smith" } });

  const renamed = patchUser(db, id, {
    schemas: [PATCH_SCHEMA],
    Operations: [
      { op: "replace", path: "name.givenName", value: "Alicia" },
      { op: "replace", path: "externalId", value: "ext-2" },
    ],
  });
  assert.equal(renamed.status, 200);
  const renamedUser = resource(renamed);
  assert.equal(renamedUser.displayName, "Alicia Smith");
  assert.equal(asObject(renamedUser.name).givenName, "Alicia");
  assert.equal(renamedUser.externalId, "ext-2");
  assert.equal(listUsers(db, { filter: 'externalId eq "ext-2"' }).totalResults, 1);

  const relabelled = patchUser(db, id, {
    schemas: [PATCH_SCHEMA],
    Operations: [{ op: "replace", path: "displayName", value: "Alice Jones" }],
  });
  assert.equal(relabelled.status, 200);
  assert.equal(resource(relabelled).displayName, "Alice Jones");

  const pathless = patchUser(db, id, {
    schemas: [PATCH_SCHEMA],
    Operations: [
      {
        op: "replace",
        value: { name: { givenName: "Alicia", familyName: "Jones" }, externalId: "ext-3" },
      },
    ],
  });
  assert.equal(pathless.status, 200);
  assert.equal(resource(pathless).displayName, "Alicia Jones");
  assert.equal(listUsers(db, { filter: 'externalId eq "ext-3"' }).totalResults, 1);

  const removed = patchUser(db, id, {
    schemas: [PATCH_SCHEMA],
    Operations: [{ op: "remove", path: "externalId" }],
  });
  assert.equal(resource(removed).externalId, null);
  db.close();
});

test("PUT replaces the sent attributes and rejects a colliding userName", () => {
  const db = freshDb();
  const id = newUser(db, "alice@example.com", { name: { givenName: "Alice", familyName: "Smith" } });
  newUser(db, "bob@example.com");

  const result = replaceUser(db, id, {
    schemas: [USER_SCHEMA],
    userName: "alice2@example.com",
    name: { formatted: "Alice Jones" },
    externalId: "put-1",
  });
  assert.equal(result.status, 200);
  const user = resource(result);
  assert.equal(user.userName, "alice2@example.com");
  assert.equal(user.displayName, "Alice Jones");
  assert.equal(asObject(user.name).formatted, "Alice Jones");
  assert.equal(user.externalId, "put-1");

  const collision = replaceUser(db, id, { userName: "bob@example.com" });
  assert.equal(collision.status, 409);
  assert.equal(asObject(collision.body).scimType, "uniqueness");
  db.close();
});

test("bad patch operations and malformed bodies are rejected with SCIM errors", () => {
  const db = freshDb();
  const id = newUser(db, "alice@example.com");

  const unknownOp = patchUser(db, id, {
    schemas: [PATCH_SCHEMA],
    Operations: [{ op: "move", path: "active", value: true }],
  });
  assert.equal(unknownOp.status, 400);
  assert.equal(asObject(unknownOp.body).scimType, "invalidSyntax");

  const unknownPath = patchUser(db, id, {
    schemas: [PATCH_SCHEMA],
    Operations: [{ op: "replace", path: "role", value: "owner" }],
  });
  assert.equal(unknownPath.status, 400);
  assert.equal(asObject(unknownPath.body).scimType, "invalidPath");

  const noOperations = patchUser(db, id, { schemas: [PATCH_SCHEMA], Operations: [] });
  assert.equal(noOperations.status, 400);
  assert.deepEqual(asObject(noOperations.body).schemas, [ERROR_SCHEMA]);
  assert.equal(asObject(noOperations.body).status, "400");

  for (const body of [null, "not-json", {}, { userName: "not-an-email" }, { userName: 42 }]) {
    const rejected = createUser(db, body);
    assert.equal(rejected.status, 400);
    assert.equal(asObject(rejected.body).status, "400");
    assert.equal((asObject(rejected.body).schemas as string[])[0], ERROR_SCHEMA);
  }

  for (const body of [null, {}, { displayName: "" }, { displayName: "Team", members: "nope" }]) {
    const rejected = createGroup(db, body);
    assert.equal(rejected.status, 400);
  }

  assert.equal(patchUser(db, "missing", { Operations: [{ op: "replace", path: "active", value: true }] }).status, 404);
  assert.equal(replaceUser(db, id, {}).status, 400);
  assert.equal(replaceUser(db, id, { role: "owner" }).status, 400);
  db.close();
});

test("deleteUser removes memberships, sessions, tokens and passkeys, then the row", () => {
  const db = freshDb();
  const id = newUser(db, "alice@example.com");
  const group = createGroup(db, { displayName: "Engineering", members: [{ value: id }] });
  const groupId = String(resource(group).id);
  const now = Date.now();
  db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ('session-hash', ?, ?)").run(id, now + 86_400_000);
  db.prepare(
    "INSERT INTO access_tokens (id, owner_id, name, token_hash, prefix, created_at, expires_at) VALUES ('at1', ?, 'cli', 'access-hash', 'mc_1234567', ?, ?)",
  ).run(id, now, now + 86_400_000);
  db.prepare(
    "INSERT INTO refresh_tokens (id, user_id, token_hash, client_type, scope, created_at, expires_at) VALUES ('rt1', ?, 'refresh-hash', 'cli', 'cli:full', ?, ?)",
  ).run(id, now, now + 86_400_000);
  db.prepare(
    "INSERT INTO credentials (id, user_id, credential_type, public_key, sign_count, created_at) VALUES ('cred1', ?, 'passkey', ?, 0, ?)",
  ).run(id, Buffer.from([1, 2, 3]), now);

  assert.equal(deleteUser(db, id), true);
  assert.equal(deleteUser(db, id), false);
  assert.equal(getUser(db, id), null);
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM users WHERE id = ?", id), 0);
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM scim_group_members WHERE user_id = ?", id), 0);
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?", id), 0);
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM access_tokens WHERE owner_id = ?", id), 0);
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM refresh_tokens WHERE user_id = ?", id), 0);
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM credentials WHERE user_id = ?", id), 0);

  // The group survives with no members.
  const surviving = asObject(getGroup(db, groupId));
  assert.deepEqual(surviving.members, []);
  db.close();
});

test("groups are created, listed, filtered, and support member add/replace/remove", () => {
  const db = freshDb();
  const alice = newUser(db, "alice@example.com");
  const bob = newUser(db, "bob@example.com");
  const carol = newUser(db, "carol@example.com");

  const created = createGroup(db, {
    schemas: [GROUP_SCHEMA],
    displayName: "Engineering",
    externalId: "team-42",
    members: [{ value: alice }],
  });
  assert.equal(created.status, 201);
  const group = resource(created);
  assert.deepEqual(group.schemas, [GROUP_SCHEMA]);
  assert.equal(group.displayName, "Engineering");
  assert.equal(group.externalId, "team-42");
  assert.equal(group.meta && asObject(group.meta).location, `/scim/v2/Groups/${String(group.id)}`);
  const groupId = String(group.id);
  assert.deepEqual((group.members as Record<string, unknown>[]).map((member) => member.value), [alice]);

  const added = patchGroup(db, groupId, {
    schemas: [PATCH_SCHEMA],
    Operations: [{ op: "add", path: "members", value: [{ value: bob }] }],
  });
  assert.equal(added.status, 200);
  assert.deepEqual(
    (resource(added).members as Record<string, unknown>[]).map((member) => member.value).sort(),
    [alice, bob].sort(),
  );

  const replaced = patchGroup(db, groupId, {
    schemas: [PATCH_SCHEMA],
    Operations: [{ op: "replace", path: "members", value: [{ value: carol }] }],
  });
  assert.deepEqual(
    (resource(replaced).members as Record<string, unknown>[]).map((member) => member.value),
    [carol],
  );

  const removed = patchGroup(db, groupId, {
    schemas: [PATCH_SCHEMA],
    Operations: [{ op: "remove", path: "members", value: [{ value: carol }] }],
  });
  assert.deepEqual(resource(removed).members, []);

  // displayName and externalId are mutable; filter comparisons ignore attribute
  // case and the displayName value case.
  patchGroup(db, groupId, {
    schemas: [PATCH_SCHEMA],
    Operations: [
      { op: "replace", path: "displayName", value: "Platform" },
      { op: "replace", path: "externalId", value: "team-43" },
    ],
  });
  const byName = listGroups(db, { filter: 'DISPLAYNAME eq "platform"' });
  assert.equal(byName.totalResults, 1);
  assert.equal(String(asObject(byName.Resources[0]).id), groupId);
  const byExternal = listGroups(db, { filter: 'externalId eq "team-43"' });
  assert.equal(byExternal.totalResults, 1);

  assert.equal(deleteGroup(db, groupId), true);
  assert.equal(deleteGroup(db, groupId), false);
  assert.equal(getGroup(db, groupId), null);
  db.close();
});

test("an unknown group member is rejected without creating the group", () => {
  const db = freshDb();
  const rejected = createGroup(db, { displayName: "Ghosts", members: [{ value: "missing-user" }] });
  assert.equal(rejected.status, 400);
  assert.equal(listGroups(db, {}).totalResults, 0);
  db.close();
});

test("unsupported filters fail closed with invalidFilter", () => {
  const db = freshDb();
  const filters = [
    'userName sw "a"',
    'userName eq "unterminated',
    'displayName eq "x" or displayName eq "y"',
    'name.givenName eq "Alice"',
  ];
  for (const filter of filters) {
    assert.throws(
      () => listUsers(db, { filter }),
      (error: unknown) => error instanceof ScimError && error.status === 400 && error.body.scimType === "invalidFilter",
    );
  }
  assert.throws(
    () => listGroups(db, { filter: 'members co "abc"' }),
    (error: unknown) => error instanceof ScimError && error.status === 400 && error.body.scimType === "invalidFilter",
  );
  db.close();
});
