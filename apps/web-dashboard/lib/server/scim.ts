import { randomBytes, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { logAuthEvent } from "./audit.ts";
import { NO_PASSWORD, newId, tokenHash } from "./db.ts";
import { tx } from "./events.ts";

/**
 * SCIM 2.0 provisioning (RFC 7643 / RFC 7644) for the MobileCloud identity
 * control plane.
 *
 * The deployment is single tenant: `users` are global accounts and a SCIM
 * token belongs to the operator account that issued it. The token is the only
 * credential the provisioning client presents, so it is generated here, only
 * its SHA-256 is stored, and every lookup re-checks the digest in constant
 * time. A token never carries user data and cannot be scoped wider than the
 * operator that owns it.
 *
 * All mutations run in one `tx()` block. A request either writes the account
 * change and its deprovisioning side effects together, or writes neither; a
 * crash cannot leave an account marked inactive while its sessions still
 * authenticate. Deactivation is deliberately destructive of live credentials
 * (sessions are deleted, access tokens expire now, refresh tokens are revoked)
 * because that is the point of SCIM deprovisioning.
 *
 * Storage note: RFC 7643 User attributes `externalId`, `name.givenName`,
 * `name.familyName` and `name.formatted` have no columns in the frozen
 * `users` schema. This module must not change `db.ts`, so those attributes are
 * kept in the existing generic `settings` store under the `scim.*` keyspace,
 * namespaced by the user id. `users.name` remains the authoritative display
 * name used by the rest of the application, and is recomputed from the SCIM
 * name parts whenever they change.
 */

const USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
const GROUP_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:Group";
const ERROR_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:Error";
const PATCH_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
const SERVICE_PROVIDER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig";

const SCIM_TOKEN_PREFIX = "scim_";
// The auth scheme is case-insensitive per HTTP, but the `scim_` token prefix is
// a fixed lower-case literal: a token is never accepted with different case.
const AUTHORIZATION_PATTERN = /^([A-Za-z]+)\s+(scim_[0-9a-f]{48})$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const MAX_EMAIL = 254;
const MAX_EXTERNAL_ID = 256;
const MAX_NAME_PART = 100;
const MAX_FORMATTED_NAME = 200;
const MAX_GROUP_NAME = 200;
const MAX_FILTER = 512;
const MAX_OPERATIONS = 100;
const MAX_MEMBERS = 1_000;
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 200;
/** The token's last-used column is refreshed lazily instead of on every call. */
const LAST_USED_RESOLUTION_MS = 60_000;

const PROFILE_KEYS = {
  externalId: "scim.external_id",
  givenName: "scim.given_name",
  familyName: "scim.family_name",
  formattedName: "scim.formatted_name",
  updatedAt: "scim.updated_at",
} as const;

/** Group rows have no updated_at column either; the profile store carries it. */
const GROUP_UPDATED_KEY = "scim.group.updated_at";

export type ScimQuery = { filter?: string | null; startIndex?: number; count?: number };

type ScimErrorBody = {
  schemas: string[];
  detail: string;
  status: string;
  scimType?: string;
};

/**
 * The one error shape this module speaks. Mutating endpoints return it inside
 * `{ status, body }`; listing endpoints throw it because their contract is a
 * ListResponse, so an invalid filter has no in-band place to live. It extends
 * Error so a generic request handler still logs a sensible message.
 */
export class ScimError extends Error {
  readonly status: number;
  readonly scimType: string | undefined;
  readonly body: ScimErrorBody;

  constructor(status: number, detail: string, scimType?: string) {
    super(detail);
    this.name = "ScimError";
    this.status = status;
    this.scimType = scimType;
    this.body = {
      schemas: [ERROR_SCHEMA],
      detail,
      status: String(status),
      ...(scimType ? { scimType } : {}),
    };
  }
}

type ScimResult = { status: number; body: unknown };
type Row = Record<string, unknown>;

/**
 * `settings` is a (owner_id, key, value) store. User profile rows use the user
 * id as the namespace, which no other platform setting does, and are removed
 * when the account is deleted. Keys are module constants; no request data is
 * ever interpolated into SQL.
 */
const USER_COLUMNS = `u.id, u.email, u.name, u.active, u.created_at AS createdAt,
  ext.value AS externalId, giv.value AS givenName, fam.value AS familyName,
  fmt.value AS formattedName, upd.value AS updatedAt`;
const USER_FROM = `FROM users u
  LEFT JOIN settings ext ON ext.owner_id = u.id AND ext.key = '${PROFILE_KEYS.externalId}'
  LEFT JOIN settings giv ON giv.owner_id = u.id AND giv.key = '${PROFILE_KEYS.givenName}'
  LEFT JOIN settings fam ON fam.owner_id = u.id AND fam.key = '${PROFILE_KEYS.familyName}'
  LEFT JOIN settings fmt ON fmt.owner_id = u.id AND fmt.key = '${PROFILE_KEYS.formattedName}'
  LEFT JOIN settings upd ON upd.owner_id = u.id AND upd.key = '${PROFILE_KEYS.updatedAt}'`;

const GROUP_COLUMNS = `g.id, g.display_name AS displayName, g.external_id AS externalId,
  g.created_at AS createdAt, upd.value AS updatedAt`;
const GROUP_FROM = `FROM scim_groups g
  LEFT JOIN settings upd ON upd.owner_id = g.id AND upd.key = '${GROUP_UPDATED_KEY}'`;

type UserRow = {
  id: string;
  email: string;
  name: string;
  active: number;
  createdAt: number;
  externalId: string | null;
  givenName: string | null;
  familyName: string | null;
  formattedName: string | null;
  updatedAt: string | null;
};

type GroupRow = {
  id: string;
  displayName: string;
  externalId: string | null;
  createdAt: number;
  updatedAt: string | null;
};

type MutableUser = {
  id: string;
  email: string;
  active: boolean;
  wasActive: boolean;
  externalId: string | null;
  givenName: string | null;
  familyName: string | null;
  formattedName: string | null;
  /** The current `users.name`, retained unless a SCIM name attribute changes. */
  displayName: string;
  nameChanged: boolean;
};

type MutableGroup = {
  id: string;
  displayName: string;
  externalId: string | null;
};

type PatchOpKind = "add" | "replace" | "remove";
type PatchOperation = { op: PatchOpKind; path: string | null; value: unknown };

// ---------------------------------------------------------------------------
// Small validation helpers. Every one throws ScimError; callers convert that
// into `{ status, body }` on mutating endpoints.
// ---------------------------------------------------------------------------

function invalid(detail: string, scimType = "invalidValue"): never {
  throw new ScimError(400, detail, scimType);
}

function asRecord(value: unknown, detail = "The request body must be a JSON object."): Row {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(detail, "invalidSyntax");
  return value as Row;
}

function hasOwn(value: Row, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function optionalString(value: unknown, field: string, max: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") invalid(`${field} must be a string.`);
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > max) invalid(`${field} must be at most ${max} characters.`);
  // Control characters have no legitimate place in an identity attribute and
  // can confuse log and header consumers downstream.
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) invalid(`${field} contains a control character.`);
  return trimmed;
}

function requiredString(value: unknown, field: string, max: number): string {
  const parsed = optionalString(value, field, max);
  if (!parsed) invalid(`${field} is required.`);
  return parsed;
}

function booleanValue(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") invalid(`${field} must be a boolean.`);
  return value;
}

function normalizeUserName(value: unknown): string {
  if (typeof value !== "string") invalid("userName is required.", "invalidValue");
  const email = value.trim().toLowerCase();
  if (!email || email.length > MAX_EMAIL || !EMAIL_PATTERN.test(email)) {
    invalid("userName must be a valid email address.");
  }
  return email;
}

type NameParts = { givenName: string | null; familyName: string | null; formatted: string | null };

function parseName(value: unknown): NameParts {
  if (value === undefined || value === null) return { givenName: null, familyName: null, formatted: null };
  const name = asRecord(value, "name must be an object.");
  return {
    givenName: optionalString(name.givenName, "name.givenName", MAX_NAME_PART),
    familyName: optionalString(name.familyName, "name.familyName", MAX_NAME_PART),
    formatted: optionalString(name.formatted, "name.formatted", MAX_FORMATTED_NAME),
  };
}

/** The display name the rest of the application stores in `users.name`. */
function effectiveName(
  parts: { givenName: string | null; familyName: string | null; formattedName: string | null },
  email: string,
): string {
  const combined = [parts.givenName, parts.familyName]
    .filter((part): part is string => part !== null && part.length > 0)
    .join(" ");
  return parts.formattedName ?? (combined || email);
}

function unescapeFilterValue(raw: string): string {
  return raw.replace(/\\(.)/g, (_match: string, escape: string) => {
    switch (escape) {
      case '"':
        return '"';
      case "\\":
        return "\\";
      case "/":
        return "/";
      case "b":
        return "\b";
      case "f":
        return "\f";
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      default:
        // SCIM only defines the escapes above; accepting an unknown one would
        // make two different filters compare equal.
        throw new ScimError(400, "The filter contains an unsupported escape sequence.", "invalidFilter");
    }
  });
}

type ParsedFilter = { attribute: string; value: string };

/**
 * Parses the deliberately tiny filter subset SCIM clients need:
 * `<attribute> eq "<value>"`. Attribute names are case-insensitive; the value
 * is exact (never a substring), and the result is always bound as a SQL
 * parameter, never interpolated.
 */
function parseFilter(raw: string | null | undefined, allowed: readonly string[]): ParsedFilter | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") throw new ScimError(400, "The filter must be a string.", "invalidFilter");
  const text = raw.trim();
  if (!text) return null;
  if (text.length > MAX_FILTER) throw new ScimError(400, "That filter is too long.", "invalidFilter");
  const match = /^([A-Za-z][A-Za-z0-9._-]*)\s+eq\s+"((?:[^"\\]|\\.)*)"$/i.exec(text);
  if (!match) {
    throw new ScimError(400, 'Unsupported filter. Only <attribute> eq "<value>" is supported.', "invalidFilter");
  }
  const attribute = match[1].toLowerCase();
  if (!allowed.includes(attribute)) {
    throw new ScimError(400, `Filtering by ${match[1]} is not supported.`, "invalidFilter");
  }
  const value = unescapeFilterValue(match[2]);
  if (value.length > MAX_FILTER || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new ScimError(400, "The filter value is not valid.", "invalidFilter");
  }
  return { attribute, value };
}

function pageWindow(query: ScimQuery): { startIndex: number; limit: number } {
  const rawStart = query.startIndex;
  const rawCount = query.count;
  // SCIM defines startIndex as 1-based. A missing or nonsensical value is
  // normalized to the first page rather than producing a SQLite error.
  const startIndex =
    typeof rawStart === "number" && Number.isFinite(rawStart) && rawStart >= 1 ? Math.floor(rawStart) : 1;
  const requested = typeof rawCount === "number" && Number.isFinite(rawCount) && rawCount >= 0 ? Math.floor(rawCount) : DEFAULT_PAGE_SIZE;
  return { startIndex, limit: Math.min(requested, MAX_PAGE_SIZE) };
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/i.test(error.message);
}

function failure(error: unknown): ScimResult {
  if (error instanceof ScimError) return { status: error.status, body: error.body };
  throw error;
}

// ---------------------------------------------------------------------------
// Profile persistence and resource projection
// ---------------------------------------------------------------------------

function writeProfile(
  db: DatabaseSync,
  userId: string,
  profile: {
    externalId: string | null;
    givenName: string | null;
    familyName: string | null;
    formattedName: string | null;
    updatedAt: number;
  },
): void {
  const entries: [string, string | null][] = [
    [PROFILE_KEYS.externalId, profile.externalId],
    [PROFILE_KEYS.givenName, profile.givenName],
    [PROFILE_KEYS.familyName, profile.familyName],
    [PROFILE_KEYS.formattedName, profile.formattedName],
    [PROFILE_KEYS.updatedAt, String(profile.updatedAt)],
  ];
  for (const [key, value] of entries) {
    if (value === null) {
      db.prepare("DELETE FROM settings WHERE owner_id = ? AND key = ?").run(userId, key);
    } else {
      db.prepare(
        "INSERT INTO settings (owner_id, key, value) VALUES (?, ?, ?) ON CONFLICT(owner_id, key) DO UPDATE SET value = excluded.value",
      ).run(userId, key, value);
    }
  }
}

function touchGroup(db: DatabaseSync, groupId: string, at: number): void {
  db.prepare(
    "INSERT INTO settings (owner_id, key, value) VALUES (?, ?, ?) ON CONFLICT(owner_id, key) DO UPDATE SET value = excluded.value",
  ).run(groupId, GROUP_UPDATED_KEY, String(at));
}

function numberOr(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function toUserResource(row: UserRow): Row {
  const created = Number(row.createdAt);
  const modified = numberOr(row.updatedAt, created);
  return {
    schemas: [USER_SCHEMA],
    id: row.id,
    userName: row.email,
    name: {
      givenName: row.givenName,
      familyName: row.familyName,
      formatted: row.formattedName ?? row.name,
    },
    emails: [{ value: row.email, primary: true, type: "work" }],
    displayName: row.name,
    active: Number(row.active) === 1,
    externalId: row.externalId,
    meta: {
      resourceType: "User",
      created: new Date(created).toISOString(),
      lastModified: new Date(modified).toISOString(),
      location: `/scim/v2/Users/${row.id}`,
    },
  };
}

function toGroupResource(db: DatabaseSync, row: GroupRow): Row {
  const created = Number(row.createdAt);
  const modified = numberOr(row.updatedAt, created);
  const members = db.prepare(
    `SELECT m.user_id AS value, u.name AS display
     FROM scim_group_members m JOIN users u ON u.id = m.user_id
     WHERE m.group_id = ? ORDER BY m.rowid ASC`,
  ).all(row.id).map((entry) => {
    const member = entry as { value: string; display: string };
    return { value: member.value, display: member.display };
  });
  return {
    schemas: [GROUP_SCHEMA],
    id: row.id,
    displayName: row.displayName,
    externalId: row.externalId,
    members,
    meta: {
      resourceType: "Group",
      created: new Date(created).toISOString(),
      lastModified: new Date(modified).toISOString(),
      location: `/scim/v2/Groups/${row.id}`,
    },
  };
}

function readUserRow(db: DatabaseSync, id: string): UserRow | null {
  if (typeof id !== "string" || !id) return null;
  const row = db.prepare(`SELECT ${USER_COLUMNS} ${USER_FROM} WHERE u.id = ?`).get(id) as UserRow | undefined;
  return row ?? null;
}

function readGroupRow(db: DatabaseSync, id: string): GroupRow | null {
  if (typeof id !== "string" || !id) return null;
  const row = db.prepare(`SELECT ${GROUP_COLUMNS} ${GROUP_FROM} WHERE g.id = ?`).get(id) as GroupRow | undefined;
  return row ?? null;
}

/**
 * Applies every credential-side effect of deactivation. The caller has already
 * started a transaction: if any statement fails, the whole patch rolls back and
 * the account is never left half-provisioned.
 */
function deprovisionUser(db: DatabaseSync, userId: string): void {
  const now = Date.now();
  db.prepare("UPDATE users SET active = 0 WHERE id = ?").run(userId);
  db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
  // Expiring is preferred to deleting: the audit trail of token metadata stays
  // intact while the bearer credential immediately stops authenticating.
  db.prepare("UPDATE access_tokens SET expires_at = ? WHERE owner_id = ?").run(now, userId);
  db.prepare("UPDATE refresh_tokens SET revoked = 1 WHERE user_id = ?").run(userId);
  logAuthEvent(db, {
    userId,
    eventType: "auth.user.deactivated",
    clientType: "api",
    credentialType: "token",
    outcome: "success",
    metadata: { source: "scim" },
  });
}

function persistUserState(db: DatabaseSync, state: MutableUser, updatedAt: number): void {
  const name = state.nameChanged ? effectiveName(state, state.email) : state.displayName;
  db.prepare("UPDATE users SET name = ?, active = ? WHERE id = ?").run(name, state.active ? 1 : 0, state.id);
  writeProfile(db, state.id, {
    externalId: state.externalId,
    givenName: state.givenName,
    familyName: state.familyName,
    formattedName: state.formattedName,
    updatedAt,
  });
  // Only a real state transition touches live credentials; a patch that
  // leaves active=false on an already-inactive account stays idempotent.
  if (state.wasActive && !state.active) deprovisionUser(db, state.id);
}

function stateFromRow(row: UserRow): MutableUser {
  return {
    id: row.id,
    email: row.email,
    active: Number(row.active) === 1,
    wasActive: Number(row.active) === 1,
    externalId: row.externalId,
    givenName: row.givenName,
    familyName: row.familyName,
    formattedName: row.formattedName,
    displayName: row.name,
    nameChanged: false,
  };
}

// ---------------------------------------------------------------------------
// SCIM tokens
// ---------------------------------------------------------------------------

/** Issues a provisioning token. The raw value is returned once and never stored. */
export function createScimToken(
  db: DatabaseSync,
  ownerId: string,
  name: string,
): { id: string; token: string; prefix: string } {
  if (typeof ownerId !== "string" || !ownerId) throw new ScimError(404, "The token owner does not exist.");
  const owner = db.prepare("SELECT 1 FROM users WHERE id = ? AND active = 1").get(ownerId);
  if (!owner) throw new ScimError(404, "The token owner does not exist or is deactivated.");
  const token = `${SCIM_TOKEN_PREFIX}${randomBytes(24).toString("hex")}`;
  // A prefix is for display only ("scim_1a2b3c4d..."), never enough to guess.
  const prefix = token.slice(0, 12);
  const id = newId();
  db.prepare(
    "INSERT INTO scim_tokens (id, owner_id, name, token_hash, prefix, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(id, ownerId, (typeof name === "string" ? name.trim() : "").slice(0, 80) || "SCIM provisioning", tokenHash(token), prefix, Date.now());
  return { id, token, prefix };
}

/** Tokens are metadata only: the hash never leaves the database. */
export function listScimTokens(
  db: DatabaseSync,
  ownerId: string,
): { id: string; name: string; prefix: string; createdAt: number; lastUsed: number | null }[] {
  return db.prepare(
    "SELECT id, name, prefix, created_at AS createdAt, last_used AS lastUsed FROM scim_tokens WHERE owner_id = ? ORDER BY created_at DESC, rowid DESC",
  ).all(ownerId).map((entry) => {
    const row = entry as { id: string; name: string; prefix: string; createdAt: number; lastUsed: number | null };
    return {
      id: row.id,
      name: row.name,
      prefix: row.prefix,
      createdAt: Number(row.createdAt),
      lastUsed: row.lastUsed === null ? null : Number(row.lastUsed),
    };
  });
}

/** Revokes a token, scoped to the owner so one operator cannot delete another's. */
export function revokeScimToken(db: DatabaseSync, ownerId: string, id: string): boolean {
  if (typeof id !== "string" || !id) return false;
  const result = db.prepare("DELETE FROM scim_tokens WHERE id = ? AND owner_id = ?").run(id, ownerId);
  return Number(result.changes) > 0;
}

/**
 * Authenticates a SCIM bearer token.
 *
 * The header shape is checked before the database is touched. The digest is
 * compared with `timingSafeEqual` even though SQLite already matched the
 * indexed hash, so the comparison the code relies on is constant time. The
 * owner must still be active: deactivating an operator revokes their ability to
 * provision, which is the fail-closed direction.
 */
export function authenticateScim(
  db: DatabaseSync,
  authorization: string | null,
): { ownerId: string; tokenId: string } | null {
  if (typeof authorization !== "string") return null;
  const match = AUTHORIZATION_PATTERN.exec(authorization.trim());
  if (!match || match[1].toLowerCase() !== "bearer") return null;
  const digest = tokenHash(match[2]);
  const row = db.prepare(
    `SELECT t.id, t.owner_id, t.token_hash, u.active
     FROM scim_tokens t JOIN users u ON u.id = t.owner_id
     WHERE t.token_hash = ?`,
  ).get(digest) as { id: string; owner_id: string; token_hash: string; active: number } | undefined;
  if (!row) return null;
  const expected = Buffer.from(row.token_hash, "utf8");
  const presented = Buffer.from(digest, "utf8");
  if (expected.length !== presented.length || !timingSafeEqual(expected, presented)) return null;
  if (Number(row.active) !== 1) return null;
  const now = Date.now();
  try {
    db.prepare("UPDATE scim_tokens SET last_used = ? WHERE id = ? AND (last_used IS NULL OR last_used < ?)").run(
      now,
      row.id,
      now - LAST_USED_RESOLUTION_MS,
    );
  } catch {
    // Activity metadata is advisory; authentication must not fail because the
    // accounting write could not complete.
  }
  return { ownerId: row.owner_id, tokenId: row.id };
}

// ---------------------------------------------------------------------------
// Service provider configuration
// ---------------------------------------------------------------------------

/** Advertises exactly the capabilities implemented below. */
export function serviceProviderConfig(): Record<string, unknown> {
  return {
    schemas: [SERVICE_PROVIDER_SCHEMA],
    documentationUri: "https://www.rfc-editor.org/rfc/rfc7644",
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: MAX_PAGE_SIZE },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [
      {
        type: "oauthbearertoken",
        name: "OAuth Bearer Token",
        description: "Authentication with a SCIM provisioning token issued by MobileCloud.",
        specUri: "https://www.rfc-editor.org/info/rfc6750",
        primary: true,
      },
    ],
    meta: { resourceType: "ServiceProviderConfig", location: "/scim/v2/ServiceProviderConfig" },
  };
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

/** Lists users; supports `userName eq` and `externalId eq` plus 1-based paging. */
export function listUsers(
  db: DatabaseSync,
  query: ScimQuery,
): { totalResults: number; startIndex: number; itemsPerPage: number; Resources: unknown[] } {
  const filter = parseFilter(query.filter, ["username", "externalid"]);
  const { startIndex, limit } = pageWindow(query);
  const where: string[] = [];
  const params: string[] = [];
  if (filter) {
    if (filter.attribute === "username") {
      // Stored emails are canonical lower case; SCIM treats userName as
      // case-insensitive, so the comparison value is canonicalized too.
      where.push("lower(u.email) = ?");
      params.push(filter.value.toLowerCase());
    } else {
      where.push("ext.value = ?");
      // externalId is caseExact in RFC 7643 and is compared verbatim.
      params.push(filter.value);
    }
  }
  const whereSql = where.length ? ` WHERE ${where.join(" AND ")}` : "";
  const total = db.prepare(`SELECT COUNT(*) AS total ${USER_FROM}${whereSql}`).get(...params) as { total: number };
  const rows = db.prepare(
    `SELECT ${USER_COLUMNS} ${USER_FROM}${whereSql} ORDER BY u.created_at DESC, u.rowid DESC LIMIT ? OFFSET ?`,
  ).all(...params, limit, startIndex - 1) as UserRow[];
  const Resources = rows.map(toUserResource);
  return { totalResults: Number(total.total), startIndex, itemsPerPage: Resources.length, Resources };
}

export function createUser(db: DatabaseSync, body: unknown): ScimResult {
  try {
    return tx(db, () => ({ status: 201, body: insertUser(db, body) }));
  } catch (error) {
    return failure(error);
  }
}

function insertUser(db: DatabaseSync, body: unknown): Row {
  const input = asRecord(body);
  const email = normalizeUserName(input.userName);
  const duplicate = db.prepare("SELECT 1 FROM users WHERE lower(email) = ?").get(email);
  if (duplicate) throw new ScimError(409, `A user named ${email} already exists.`, "uniqueness");

  const name = parseName(input.name);
  const externalId = optionalString(input.externalId, "externalId", MAX_EXTERNAL_ID);
  const active = hasOwn(input, "active") ? booleanValue(input.active, "active") : true;
  const display = effectiveName({ givenName: name.givenName, familyName: name.familyName, formattedName: name.formatted }, email);
  const id = newId();
  const now = Date.now();
  // role and password_hash are constants, never request-derived: a provisioning
  // client must not be able to mint an administrator or set a password.
  try {
    db.prepare(
      "INSERT INTO users (id, email, name, password_hash, role, plan, active, created_at) VALUES (?, ?, ?, ?, 'member', 'community', ?, ?)",
    ).run(id, email, display, NO_PASSWORD, active ? 1 : 0, now);
  } catch (error) {
    if (isUniqueViolation(error)) throw new ScimError(409, `A user named ${email} already exists.`, "uniqueness");
    throw error;
  }
  writeProfile(db, id, {
    externalId,
    givenName: name.givenName,
    familyName: name.familyName,
    formattedName: name.formatted,
    updatedAt: now,
  });
  const created = readUserRow(db, id);
  if (!created) throw new ScimError(500, "The user could not be stored.");
  return toUserResource(created);
}

export function getUser(db: DatabaseSync, id: string): unknown | null {
  const row = readUserRow(db, id);
  return row ? toUserResource(row) : null;
}

export function patchUser(db: DatabaseSync, id: string, body: unknown): ScimResult {
  try {
    return tx(db, () => ({ status: 200, body: patchUserRecord(db, id, body) }));
  } catch (error) {
    return failure(error);
  }
}

function patchUserRecord(db: DatabaseSync, id: string, body: unknown): Row {
  const row = readUserRow(db, id);
  if (!row) throw new ScimError(404, "No such user.");
  const state = stateFromRow(row);
  const operations = parsePatchOperations(body);
  for (const operation of operations) {
    if (operation.path === null) {
      const value = asRecord(operation.value, "A path-less patch operation needs an object value.");
      for (const [key, entry] of Object.entries(value)) {
        applyUserAttribute(state, normalizePatchPath(key), operation.op, entry);
      }
    } else {
      applyUserAttribute(state, normalizePatchPath(operation.path), operation.op, operation.value);
    }
  }
  persistUserState(db, state, Date.now());
  const updated = readUserRow(db, id);
  if (!updated) throw new ScimError(500, "The user could not be updated.");
  return toUserResource(updated);
}

export function replaceUser(db: DatabaseSync, id: string, body: unknown): ScimResult {
  try {
    return tx(db, () => ({ status: 200, body: replaceUserRecord(db, id, body) }));
  } catch (error) {
    return failure(error);
  }
}

/**
 * PUT replaces the attributes the client sent. Attributes the client omitted
 * are retained (SCIM clients in the wild send sparse PUTs); active is only
 * changed when it is explicitly present, so a PUT can never reactivate an
 * account by accident.
 */
function replaceUserRecord(db: DatabaseSync, id: string, body: unknown): Row {
  const row = readUserRow(db, id);
  if (!row) throw new ScimError(404, "No such user.");
  const input = asRecord(body);
  // Sparse PUTs are tolerated for interop, but a body that carries none of the
  // attributes this endpoint can replace is malformed rather than a no-op.
  if (!["userName", "name", "externalId", "active"].some((key) => hasOwn(input, key))) {
    invalid("Provide at least one user attribute to replace.");
  }
  const email = hasOwn(input, "userName") ? normalizeUserName(input.userName) : row.email;
  if (email !== row.email) {
    const duplicate = db.prepare("SELECT 1 FROM users WHERE lower(email) = ? AND id <> ?").get(email, id);
    if (duplicate) throw new ScimError(409, `A user named ${email} already exists.`, "uniqueness");
  }
  const name = hasOwn(input, "name") ? parseName(input.name) : {
    givenName: row.givenName,
    familyName: row.familyName,
    formatted: row.formattedName,
  };
  const externalId = hasOwn(input, "externalId")
    ? optionalString(input.externalId, "externalId", MAX_EXTERNAL_ID)
    : row.externalId;
  const active = hasOwn(input, "active") ? booleanValue(input.active, "active") : Number(row.active) === 1;
  const state: MutableUser = {
    id,
    email,
    active,
    wasActive: Number(row.active) === 1,
    externalId,
    givenName: name.givenName,
    familyName: name.familyName,
    formattedName: name.formatted,
    displayName: row.name,
    nameChanged: hasOwn(input, "name"),
  };
  db.prepare("UPDATE users SET email = ? WHERE id = ?").run(email, id);
  persistUserState(db, state, Date.now());
  const updated = readUserRow(db, id);
  if (!updated) throw new ScimError(500, "The user could not be updated.");
  return toUserResource(updated);
}

/** Deletes an account and every credential that could still act as it. */
export function deleteUser(db: DatabaseSync, id: string): boolean {
  if (typeof id !== "string" || !id) return false;
  return tx(db, () => {
    const exists = db.prepare("SELECT 1 FROM users WHERE id = ?").get(id);
    if (!exists) return false;
    db.prepare("DELETE FROM scim_group_members WHERE user_id = ?").run(id);
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(id);
    db.prepare("DELETE FROM access_tokens WHERE owner_id = ?").run(id);
    db.prepare("DELETE FROM refresh_tokens WHERE user_id = ?").run(id);
    db.prepare("DELETE FROM credentials WHERE user_id = ?").run(id);
    db.prepare("DELETE FROM scim_tokens WHERE owner_id = ?").run(id);
    db.prepare("DELETE FROM connected_devices WHERE owner_id = ?").run(id);
    // SCIM profile attributes live in the generic settings namespace.
    db.prepare("DELETE FROM settings WHERE owner_id = ?").run(id);
    // These columns point at users without ON DELETE CASCADE. The audit trail
    // survives with an anonymous attribution instead of blocking the delete or
    // being erased.
    db.prepare("UPDATE auth_events SET user_id = NULL WHERE user_id = ?").run(id);
    db.prepare("UPDATE oauth_device_codes SET approved_by = NULL WHERE approved_by = ?").run(id);
    db.prepare("UPDATE qr_login_challenges SET approved_by = NULL WHERE approved_by = ?").run(id);
    db.prepare("DELETE FROM users WHERE id = ?").run(id);
    return true;
  });
}

function applyUserAttribute(state: MutableUser, path: string, op: PatchOpKind, value: unknown): void {
  const removing = op === "remove";
  switch (path) {
    case "active":
      if (removing) throw new ScimError(400, "The active attribute cannot be removed.", "invalidPath");
      state.active = booleanValue(value, "active");
      return;
    case "externalid":
      state.externalId = removing ? null : optionalString(value, "externalId", MAX_EXTERNAL_ID);
      return;
    case "name.givenname":
      state.givenName = removing ? null : optionalString(value, "name.givenName", MAX_NAME_PART);
      state.nameChanged = true;
      return;
    case "name.familyname":
      state.familyName = removing ? null : optionalString(value, "name.familyName", MAX_NAME_PART);
      state.nameChanged = true;
      return;
    case "name.formatted":
      state.formattedName = removing ? null : optionalString(value, "name.formatted", MAX_FORMATTED_NAME);
      state.nameChanged = true;
      return;
    case "name": {
      if (removing) {
        state.givenName = null;
        state.familyName = null;
        state.formattedName = null;
        state.nameChanged = true;
        return;
      }
      const parts = parseName(value);
      state.givenName = parts.givenName;
      state.familyName = parts.familyName;
      state.formattedName = parts.formatted;
      state.nameChanged = true;
      return;
    }
    case "displayname":
      // The task's supported-path list includes displayName, so it is writable
      // here as the account's display name even though RFC 7643 marks the User
      // arm read-only. A subsequent name.* patch recomputes it.
      if (removing) throw new ScimError(400, "displayName cannot be removed.", "invalidPath");
      state.displayName = requiredString(value, "displayName", MAX_FORMATTED_NAME);
      // Keep the projected name.formatted in step with the display name.
      state.formattedName = state.displayName;
      state.nameChanged = true;
      return;
    case "username":
      throw new ScimError(400, "userName cannot be changed through PATCH. Use PUT.", "mutability");
    default:
      throw new ScimError(400, `Unsupported patch path: ${path}.`, "invalidPath");
  }
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

export function listGroups(
  db: DatabaseSync,
  query: ScimQuery,
): { totalResults: number; startIndex: number; itemsPerPage: number; Resources: unknown[] } {
  const filter = parseFilter(query.filter, ["displayname", "externalid"]);
  const { startIndex, limit } = pageWindow(query);
  const where: string[] = [];
  const params: string[] = [];
  if (filter) {
    if (filter.attribute === "displayname") {
      where.push("lower(g.display_name) = ?");
      params.push(filter.value.toLowerCase());
    } else {
      where.push("g.external_id = ?");
      params.push(filter.value);
    }
  }
  const whereSql = where.length ? ` WHERE ${where.join(" AND ")}` : "";
  const total = db.prepare(`SELECT COUNT(*) AS total ${GROUP_FROM}${whereSql}`).get(...params) as { total: number };
  const rows = db.prepare(
    `SELECT ${GROUP_COLUMNS} ${GROUP_FROM}${whereSql} ORDER BY g.created_at DESC, g.rowid DESC LIMIT ? OFFSET ?`,
  ).all(...params, limit, startIndex - 1) as GroupRow[];
  const Resources = rows.map((row) => toGroupResource(db, row));
  return { totalResults: Number(total.total), startIndex, itemsPerPage: Resources.length, Resources };
}

export function createGroup(db: DatabaseSync, body: unknown): ScimResult {
  try {
    return tx(db, () => ({ status: 201, body: insertGroup(db, body) }));
  } catch (error) {
    return failure(error);
  }
}

function insertGroup(db: DatabaseSync, body: unknown): Row {
  const input = asRecord(body);
  const displayName = requiredString(input.displayName, "displayName", MAX_GROUP_NAME);
  const externalId = optionalString(input.externalId, "externalId", MAX_EXTERNAL_ID);
  const members = parseMemberReferences(db, input.members, true);
  const id = newId();
  const now = Date.now();
  db.prepare("INSERT INTO scim_groups (id, display_name, external_id, created_at) VALUES (?, ?, ?, ?)").run(
    id,
    displayName,
    externalId,
    now,
  );
  for (const userId of members) insertMember(db, id, userId);
  touchGroup(db, id, now);
  const row = readGroupRow(db, id);
  if (!row) throw new ScimError(500, "The group could not be stored.");
  return toGroupResource(db, row);
}

export function getGroup(db: DatabaseSync, id: string): unknown | null {
  const row = readGroupRow(db, id);
  return row ? toGroupResource(db, row) : null;
}

export function patchGroup(db: DatabaseSync, id: string, body: unknown): ScimResult {
  try {
    return tx(db, () => ({ status: 200, body: patchGroupRecord(db, id, body) }));
  } catch (error) {
    return failure(error);
  }
}

function patchGroupRecord(db: DatabaseSync, id: string, body: unknown): Row {
  const row = readGroupRow(db, id);
  if (!row) throw new ScimError(404, "No such group.");
  const state: MutableGroup = { id, displayName: row.displayName, externalId: row.externalId };
  const operations = parsePatchOperations(body);
  for (const operation of operations) {
    if (operation.path === null) {
      const value = asRecord(operation.value, "A path-less patch operation needs an object value.");
      for (const [key, entry] of Object.entries(value)) {
        applyGroupAttribute(db, state, normalizePatchPath(key), operation.op, entry);
      }
    } else {
      applyGroupAttribute(db, state, normalizePatchPath(operation.path), operation.op, operation.value);
    }
  }
  db.prepare("UPDATE scim_groups SET display_name = ?, external_id = ? WHERE id = ?").run(
    state.displayName,
    state.externalId,
    id,
  );
  touchGroup(db, id, Date.now());
  const updated = readGroupRow(db, id);
  if (!updated) throw new ScimError(500, "The group could not be updated.");
  return toGroupResource(db, updated);
}

export function deleteGroup(db: DatabaseSync, id: string): boolean {
  if (typeof id !== "string" || !id) return false;
  return tx(db, () => {
    const exists = db.prepare("SELECT 1 FROM scim_groups WHERE id = ?").get(id);
    if (!exists) return false;
    db.prepare("DELETE FROM scim_group_members WHERE group_id = ?").run(id);
    db.prepare("DELETE FROM scim_groups WHERE id = ?").run(id);
    db.prepare("DELETE FROM settings WHERE owner_id = ? AND key = ?").run(id, GROUP_UPDATED_KEY);
    return true;
  });
}

function applyGroupAttribute(
  db: DatabaseSync,
  state: MutableGroup,
  path: string,
  op: PatchOpKind,
  value: unknown,
): void {
  switch (path) {
    case "displayname":
      if (op === "remove") throw new ScimError(400, "displayName is required and cannot be removed.", "mutability");
      state.displayName = requiredString(value, "displayName", MAX_GROUP_NAME);
      return;
    case "externalid":
      state.externalId = op === "remove" ? null : optionalString(value, "externalId", MAX_EXTERNAL_ID);
      return;
    case "members":
      applyMemberChange(db, state.id, op, value);
      return;
    default:
      throw new ScimError(400, `Unsupported patch path: ${path}.`, "invalidPath");
  }
}

function insertMember(db: DatabaseSync, groupId: string, userId: string): void {
  db.prepare("INSERT INTO scim_group_members (group_id, user_id) VALUES (?, ?) ON CONFLICT(group_id, user_id) DO NOTHING").run(
    groupId,
    userId,
  );
}

function applyMemberChange(db: DatabaseSync, groupId: string, op: PatchOpKind, value: unknown): void {
  if (op === "replace") {
    const members = parseMemberReferences(db, value, true);
    db.prepare("DELETE FROM scim_group_members WHERE group_id = ?").run(groupId);
    for (const userId of members) insertMember(db, groupId, userId);
    return;
  }
  if (op === "add") {
    for (const userId of parseMemberReferences(db, value, true)) insertMember(db, groupId, userId);
    return;
  }
  // remove without a value clears the membership list; remove with entries
  // deletes exactly those, idempotently.
  if (value === undefined || value === null) {
    db.prepare("DELETE FROM scim_group_members WHERE group_id = ?").run(groupId);
    return;
  }
  for (const userId of parseMemberReferences(db, value, false)) {
    db.prepare("DELETE FROM scim_group_members WHERE group_id = ? AND user_id = ?").run(groupId, userId);
  }
}

function parseMemberReferences(db: DatabaseSync, value: unknown, requireExisting: boolean): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) invalid("members must be an array of { value } objects.");
  if (value.length > MAX_MEMBERS) invalid("Too many group members.");
  const ids = new Set<string>();
  for (const entry of value) {
    let id: unknown;
    if (typeof entry === "string") {
      // Some provisioning clients send bare ids; accepting them is harmless
      // because a group member has no other meaning here.
      id = entry;
    } else if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      id = (entry as Row).value;
    } else {
      invalid("Each group member must be an object with a value.");
    }
    if (typeof id !== "string" || !id.trim()) invalid("Each group member needs a non-empty value.");
    const userId = id.trim();
    if (requireExisting && !db.prepare("SELECT 1 FROM users WHERE id = ?").get(userId)) {
      invalid(`No user exists with id ${userId}.`);
    }
    ids.add(userId);
  }
  return [...ids];
}

// ---------------------------------------------------------------------------
// PATCH parsing
// ---------------------------------------------------------------------------

function normalizePatchPath(path: string): string {
  // Attribute names are case-insensitive in our subset, and a fully qualified
  // schema URN is accepted because clients legitimately send one.
  return path
    .trim()
    .replace(/^urn:ietf:params:scim:schemas:core:2\.0:(?:User|Group):/i, "")
    .toLowerCase();
}

function parsePatchOperations(body: unknown): PatchOperation[] {
  const input = asRecord(body);
  if (hasOwn(input, "schemas")) {
    const schemas = input.schemas;
    if (!Array.isArray(schemas) || !schemas.some((schema) => schema === PATCH_SCHEMA)) {
      invalid("The request must use the SCIM PatchOp schema.", "invalidSyntax");
    }
  }
  const raw = hasOwn(input, "Operations") ? input.Operations : input.operations;
  if (!Array.isArray(raw) || raw.length === 0) invalid("Provide at least one patch operation.");
  if (raw.length > MAX_OPERATIONS) throw new ScimError(400, "Too many patch operations.", "tooMany");
  return raw.map((entry, index): PatchOperation => {
    const operation = asRecord(entry, `Patch operation ${index + 1} must be an object.`);
    const op = typeof operation.op === "string" ? operation.op.trim().toLowerCase() : "";
    if (op !== "add" && op !== "replace" && op !== "remove") {
      invalid(`Patch operation ${index + 1} uses an unsupported op.`, "invalidSyntax");
    }
    const path = operation.path === undefined || operation.path === null
      ? null
      : requiredString(operation.path, "path", 256);
    if ((op === "add" || op === "replace") && !hasOwn(operation, "value")) {
      invalid(`Patch operation ${index + 1} needs a value.`);
    }
    return { op, path, value: operation.value };
  });
}
