import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { CSRF_COOKIE, CSRF_HEADER } from "../csrf.ts";
import type { DnsSignal, Domain, DomainLastError, DomainPropagation, HealthSignal, RangeKey, SslSignal, User, VerificationMethod } from "../types.ts";
import { deriveStatus } from "../domain-status.ts";
import { BUILDER_DISABLED, builderConfig, dispatchDeploy, dispatchRollback, probeBuilder } from "./builder.ts";
import { ROLES, hasPermission, normalizeRole, roleFor, viewerMayMutate } from "./rbac.ts";
import { dataRoot, isRetiredPassword, newId, openDb, tokenHash, verifyPassword } from "./db.ts";
import { collectAnalytics, collectHost, collectMetrics } from "./metrics.ts";
import { collectSubsystems } from "./health.ts";
import { capabilities, collectObservability, inspectRequest, listBuilds, listDrives, listFirewallEvents, listRules, listWorkflows, observedJa4, summarizeVitals, trafficSummary } from "./platform.ts";
import { approveDevice, clearProtection, createToken, gateCookie, identityProviders, listNotifications, listSessions, listTokens, listWebhooks, notify, pollDevice, protectionStatus, readGate, setProtection, startDevice, unlockProtection, userFromBearer } from "./identity.ts";
import { assessLoginRisk, geoFor, listAuthEvents, logAuthEvent } from "./audit.ts";
import { listBuilds as listAccountBuilds, readBuild, readBuildEvents, startBuild } from "./builds.ts";
import {
  authorizationUrl,
  beginAuthorization,
  beginDeviceAuthorization,
  consumeAuthorization,
  deleteConnection,
  exchangeCode,
  fetchFile,
  fetchRepositories,
  fetchTree,
  fetchViewer,
  findRepository,
  githubConfig,
  listRepositories,
  ownersForRepository,
  parseWebhookEvent,
  pollDeviceAuthorization,
  readConnection,
  saveConnection,
  syncRepositories,
  verifyWebhookSignature,
} from "./github.ts";
import { approveDeviceCode, authenticateClient, checkScope, createAuthorizationCode, createClient, deleteClient, denyDeviceCode, findClient, findDeviceCode, listClients, OAuthError, redeemAuthorizationCode, redeemDeviceCode, refreshTokens, startDeviceGrant, updateClient, type OAuthClient, type TokenPair } from "./oauth.ts";
import { decodeJwtPayload, deliverBackchannelLogout, discovery, ensureSigningKey, issuer as issuerId, issueIdToken, issueLogoutToken, jwks as signingJwks, revokeToken as revokeOAuthToken, rotateSigningKey, userClaims } from "./oidc.ts";
import { consentFor, hasConsentFor, listConsents, recordConsent, revokeConsent } from "./consent.ts";
import { buildMetadata as buildSamlMetadata, buildResponse as buildSamlResponse, createServiceProvider, deleteServiceProvider, findServiceProvider, listServiceProviders, parseAuthnRequest, samlConfig } from "./saml.ts";
import { authenticateScim, createGroup, createScimToken, createUser, deleteGroup, deleteUser, getGroup, getUser, listGroups, listScimTokens, listUsers, patchGroup, patchUser, replaceUser, revokeScimToken, ScimError, serviceProviderConfig } from "./scim.ts";
import { beginAuthentication, beginRegistration, deleteCredential, finishAuthentication, finishRegistration, listCredentials, PasskeyError, verifyAssertion } from "./passkey.ts";
import { createStepUp, StepUpError, verifyStepUp } from "./stepup.ts";
import { approveQrLogin, consumeQrLogin, createQrLogin, denyQrLogin, QrLoginError, qrLoginStatus, scanQrLogin } from "./qrlogin.ts";
import { createSession, listAccountSessions, type ClientType } from "./sessions.ts";
import { EVENT_TYPES, changesSince, latestSeq, publish, snapshot, tx } from "./events.ts";
import { collectUsage, quotaBreach, quotaMessage, record as recordUsage } from "./metering.ts";
import { FunctionError, RUNTIME_DISABLED, validateSource } from "./runtime.ts";
import { executeFunction, runtimeEnabled } from "./isolate.ts";
import { deliverableHost, listDeliveries } from "./webhook.ts";
import { parseSteps, runWorkflow } from "./workflows.ts";
import { insertAttestation, porState, validateAttestation } from "./por.ts";
import { approveFromBrowser, approvePairing, closePairing, createPairing, expireStale, listDevices, markAwaitingApproval, publicPairing, readPairing, renameDevice, revokeDevice, scanPairing, scanProofMatches, secretMatches } from "./pairing.ts";
import { encodePairingTicket, renderPairingQr } from "./qr.ts";
import { renderLoginQr } from "./qr.ts";
import { checkCname, checkTxtToken, detectDnsProvider } from "./dns.ts";
import { validateHostname } from "./domain-validation.ts";

const COOKIE = "mc_session";
const WEEK = 7 * 24 * 3600 * 1000;
const attempts = new Map<string, { n: number; reset: number }>();

/** Port the realtime gateway listens on; advertised through `GET /api/health`. */
function realtimePort(): number {
  const raw = Number(process.env.MOBILECLOUD_REALTIME_PORT ?? 3211);
  return Number.isFinite(raw) && raw > 0 ? raw : 3211;
}

type Authentication =
  | {
      user: User;
      via: "bearer";
      tokenId: string;
      deviceId: string | null;
      token: { id: string; name: string; scope: string; client_type: string; expires_at: number };
    }
  | { user: User; via: "cookie"; hash: string; csrf: string; deviceId: string | null; createdAt: number | null };

class RequestError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function json(body: unknown, status = 200, headers?: Headers) {
  const h = headers ?? new Headers();
  h.set("content-type", "application/json");
  h.set("cache-control", "no-store");
  return new Response(JSON.stringify(body), { status, headers: h });
}

/**
 * Answers a consent decision.
 *
 * A browser form submits a normal navigation and wants the 302; the console's
 * own consent page calls this endpoint with `accept: application/json` and
 * navigates itself, which keeps the authorization code out of a fetch response
 * the page cannot read across origins.
 */
function consentRedirect(req: Request, target: string) {
  if ((req.headers.get("accept") ?? "").toLowerCase().includes("application/json")) {
    return json({ redirect: target }, 200);
  }
  return new Response(null, { status: 302, headers: { location: target } });
}

/** Client credentials from the HTTP Basic header (RFC 6749 §2.3.1). */
function clientCredentials(req: Request): { id: string; secret: string } | null {
  const header = req.headers.get("authorization") ?? "";
  if (!header.startsWith("Basic ")) return null;
  try {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator <= 0) return null;
    return {
      id: decodeURIComponent(decoded.slice(0, separator)),
      secret: decodeURIComponent(decoded.slice(separator + 1)),
    };
  } catch {
    return null;
  }
}

/** Authenticates a client or fails the token request with `invalid_client`. */
function requireClient(db: DatabaseSync, clientId: string, secret: string | null): OAuthClient {
  if (!clientId) throw new OAuthError(401, "invalid_client", "A client_id is required.");
  const client = authenticateClient(db, clientId, secret);
  if (!client) throw new OAuthError(401, "invalid_client", "Client authentication failed.");
  return client;
}

/** The token response shared by every grant, with an ID token when one was issued. */
function oauthJson(pair: TokenPair, idToken?: string | null) {
  return {
    response: json({
      access_token: pair.accessToken,
      token_type: pair.tokenType,
      expires_in: pair.expiresIn,
      refresh_token: pair.refreshToken,
      scope: pair.scope,
      ...(idToken ? { id_token: idToken } : {}),
    }),
    status: 200,
    owner: null,
  };
}

/** OIDC access tokens are short lived; the CLI keeps its own hour. */
function oidcAccessTtl(): number {
  const raw = Number(process.env.MOBILECLOUD_OIDC_ACCESS_TTL);
  return Number.isFinite(raw) && raw >= 60_000 ? Math.floor(raw) : 15 * 60_000;
}

/** The client fields safe to show an operator: never the secret hash. */
function publicClient(client: OAuthClient) {
  return {
    client_id: client.id,
    name: client.name,
    redirect_uris: client.redirectUris,
    post_logout_redirect_uris: client.postLogoutRedirectUris,
    scopes: client.scopes,
    grant_types: client.grantTypes,
    public: client.public,
    backchannel_logout_uri: client.backchannelLogoutUri,
  };
}

function scimResponse(body: unknown, status = 200) {
  const headers = new Headers({ "content-type": "application/scim+json", "cache-control": "no-store" });
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers });
}

function scimList(page: { totalResults: number; startIndex: number; itemsPerPage: number; Resources: unknown[] }) {
  return { schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"], ...page };
}

function scimError(status: number, detail: string, scimType?: string) {
  return {
    schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
    detail,
    status: String(status),
    ...(scimType ? { scimType } : {}),
  };
}

function publicOrigin(): string | null {
  try {
    const url = new URL(process.env.MOBILECLOUD_PUBLIC_ORIGIN ?? "");
    const schemeAllowed = url.protocol === "https:" || (process.env.NODE_ENV !== "production" && url.protocol === "http:");
    return schemeAllowed && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash ? url.origin : null;
  } catch {
    return null;
  }
}

function secureCookie(req: Request): boolean {
  return process.env.NODE_ENV === "production" || publicOrigin()?.startsWith("https://") === true || new URL(req.url).protocol === "https:";
}

function cookieHeader(req: Request, token: string, maxAge: number) {
  return `${COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}${secureCookie(req) ? "; Secure" : ""}`;
}

function readCookie(req: Request, name = COOKIE): string | null {
  const hits = (req.headers.get("cookie") ?? "").split(";").map((p) => p.trim()).filter((p) => p.startsWith(`${name}=`));
  if (hits.length !== 1) return null;
  const token = hits[0].slice(name.length + 1);
  return /^[a-f0-9]{64}$/.test(token) ? token : null;
}

// Reuse the native client's session cookie jar, but a scan capability is
// neither a login token (different value format) nor sent outside this ticket.
function pairingCookie(req: Request, id: string, proof: string, maxAge: number) {
  return `${COOKIE}=${proof}; HttpOnly; Path=/api/device/pairing/${id}; SameSite=Strict; Max-Age=${maxAge}${secureCookie(req) ? "; Secure" : ""}`;
}

function readScanProof(req: Request): string | null {
  const hits = (req.headers.get("cookie") ?? "").split(";").map((p) => p.trim()).filter((p) => /^mc_session=scan_[a-f0-9]{64}$/.test(p));
  return hits.length === 1 ? hits[0].slice(COOKIE.length + 1) : null;
}

/** The browser echoes this session-bound token; native clients can read auth/me. */
function csrfCookieHeader(req: Request, token: string, maxAge: number) {
  return `${CSRF_COOKIE}=${token}; Path=/; SameSite=Lax; Max-Age=${maxAge}${secureCookie(req) ? "; Secure" : ""}`;
}

/** Constant-time string comparison over equal-length byte arrays. */
function timingSafeEq(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function requireOrigin(req: Request): void {
  const origin = req.headers.get("origin");
  let allowed = origin === null || origin === publicOrigin();
  // Match the gateway's dev allowlist without trusting a request-derived host.
  if (!allowed && process.env.NODE_ENV !== "production" && !process.env.MOBILECLOUD_PUBLIC_ORIGIN) {
    const port = Number(process.env.PORT ?? 3210);
    if (Number.isInteger(port) && port > 0 && port <= 65535) {
      allowed = ["localhost", "127.0.0.1", "[::1]"].some((host) => origin === new URL(`http://${host}:${port}`).origin);
    }
  }
  if (!allowed || req.headers.get("sec-fetch-site") === "cross-site") {
    throw new RequestError(403, "Request origin is not allowed");
  }
}

function requireCsrf(req: Request, auth: Authentication | null): void {
  if (auth?.via !== "cookie" || req.method === "GET" || req.method === "HEAD") return;
  const header = req.headers.get(CSRF_HEADER);
  if (!header || !timingSafeEq(header, auth.csrf)) throw new RequestError(403, "The CSRF token is missing or invalid");
}

function authenticate(req: Request, db: DatabaseSync): Authentication | null {
  const authorization = req.headers.get("authorization");
  if (authorization !== null) {
    const bearer = userFromBearer(db, authorization);
    return bearer ? { ...bearer, via: "bearer" } : null;
  }
  const token = readCookie(req);
  if (!token) return null;
  const hash = tokenHash(token);
  const now = Date.now();
  const row = db.prepare(
    `SELECT u.id, u.email, u.name, u.role, u.plan, s.csrf, s.device_id AS deviceId, s.created_at AS createdAt
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ? AND s.csrf IS NOT NULL AND u.active = 1
       AND (s.device_id IS NULL OR EXISTS (
         SELECT 1 FROM connected_devices d JOIN access_tokens t ON t.id = d.token_id AND t.owner_id = d.owner_id
         WHERE d.id = s.device_id AND d.owner_id = s.user_id AND d.revoked = 0 AND t.expires_at > ?
       ))`,
  ).get(hash, now, now) as (User & { csrf: string; deviceId: string | null; createdAt: number | null }) | undefined;
  if (!row) return null;
  const { csrf, deviceId, createdAt, ...user } = row;
  return { user, csrf, hash, via: "cookie", deviceId, createdAt };
}

function requireRecentLogin(auth: Authentication) {
  // A bearer credential is presented on every request, so there is no older
  // cookie session to re-confirm. Its scope is checked by bearerMayWrite.
  if (auth.via === "bearer") return;
  if (auth.deviceId || !auth.createdAt || Date.now() - auth.createdAt > 15 * 60_000) {
    throw new RequestError(403, "Sign in again with your password to perform this action");
  }
}

/**
 * The mutations a CLI bearer token may perform.
 *
 * Bearer tokens stay read-only by default: a leaked API token should not be
 * able to change the account. A token issued with the `cli:full` scope is
 * different — it is the credential `mobilecloud login` just created, and the
 * CLI is expected to manage the very sessions and devices it belongs to. Only
 * that narrow set of routes is writable; everything else still requires a
 * cookie session with CSRF.
 */
function bearerMayWrite(auth: Authentication, method: string, parts: string[]): boolean {
  if (auth.via !== "bearer") return true;
  if (!auth.token.scope.split(/\s+/).includes("cli:full")) return false;
  if (method === "POST" && parts[0] === "auth" && parts[1] === "logout") return true;
  if (method === "POST" && parts[0] === "auth" && parts[1] === "refresh") return true;
  if (method === "DELETE" && parts[0] === "devices" && parts[1] !== undefined) return true;
  return method === "DELETE" && parts[0] === "auth" && parts[1] === "sessions" && parts[2] !== undefined;
}

function log(ownerId: string, level: "info" | "warn" | "error", source: string, message: string) {
  try {
    openDb().prepare("INSERT INTO logs (id, owner_id, level, source, message, at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(newId(), ownerId, level, source, message.slice(0, 500), Date.now());
  } catch {
    console.warn("Control-plane activity log write failed");
  }
}

function record(ownerId: string | null, path: string, status: number, started: number, req: Request) {
  openDb().prepare(
    "INSERT INTO requests (id, owner_id, path, status, duration_ms, at, user_agent, host, ja4) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    newId(),
    ownerId,
    path,
    status,
    Date.now() - started,
    Date.now(),
    req.headers.get("user-agent")?.slice(0, 180) ?? null,
    req.headers.get("host"),
    observedJa4(req),
  );
}

// The route has no trusted peer address. Do not accept forwarded headers as
// a rate-limit identity; apply an operation-wide budget and a target budget.
function throttle(operation: string, target?: string, targetLimit = 12) {
  const now = Date.now();
  for (const [key, row] of attempts) if (row.reset <= now) attempts.delete(key);
  function consume(key: string, allowance: number) {
    let row = attempts.get(key);
    if (!row) {
      if (attempts.size >= 2048) return false;
      row = { n: 0, reset: now + 60_000 };
      attempts.set(key, row);
    }
    return ++row.n <= allowance;
  }
  if (!consume(operation, 240) || (target && !consume(`${operation}:${target}`, targetLimit))) {
    throw new RequestError(429, "Too many attempts");
  }
}

function safeSlug(input: string, label: string) {
  const name = input.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "");
  if (!name || name.length > 48) throw new RequestError(400, `${label} must be 1-48 letters, numbers, or hyphens`);
  return name;
}

/** Event types a new webhook receives until the owner narrows them. */
const DEFAULT_WEBHOOK_EVENTS = "deployment.*,build.*,notification.created,account.updated";

/** Validates an event subscription (comma-separated string or array). `foo.*` is a family match. */
function subscription(raw: unknown): string {
  const tokens = (Array.isArray(raw) ? raw.map(str) : str(raw).split(",")).map((token) => token.trim()).filter(Boolean);
  if (!tokens.length) return DEFAULT_WEBHOOK_EVENTS;
  if (tokens.length > 16) throw new RequestError(400, "A webhook may subscribe to at most 16 event types");
  for (const token of tokens) {
    if (token === "*") continue;
    if (token.endsWith(".*")) {
      const prefix = token.slice(0, -1);
      if (!(EVENT_TYPES as readonly string[]).some((type) => type.startsWith(prefix))) {
        throw new RequestError(400, `${token} does not match any event family`);
      }
      continue;
    }
    if (!(EVENT_TYPES as readonly string[]).includes(token)) throw new RequestError(400, `${token} is not an event type`);
  }
  return tokens.join(",");
}

function requireJson(req: Request) {
  const type = req.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (type !== "application/json" && type !== "application/scim+json") {
    throw new RequestError(415, "Content-Type must be application/json");
  }
}

async function body(req: Request, maxBytes = 64 * 1024): Promise<Record<string, unknown>> {
  requireJson(req);
  if (Number(req.headers.get("content-length")) > maxBytes) throw new RequestError(413, "Request body is too large");
  const reader = req.body?.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        void reader.cancel().catch(() => undefined);
        throw new RequestError(413, "Request body is too large");
      }
      chunks.push(value);
    }
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks, length).toString("utf8"));
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
  } catch { /* rejected below */ }
  throw new RequestError(400, "Provide a valid JSON object");
}

/**
 * Reads the request body as text.
 *
 * A webhook signature is computed over the exact bytes GitHub sent, so the
 * body has to be read raw rather than parsed and re-serialised.
 */
async function rawBody(req: Request, maxBytes = 1024 * 1024): Promise<string> {
  const reader = req.body?.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        void reader.cancel().catch(() => undefined);
        throw new RequestError(413, "Request body is too large");
      }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks, length).toString("utf8");
}

/** Parses JSON without throwing; anything malformed becomes null. */
function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function str(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

/** A JSON array of strings, dropping blanks and non-strings. */
function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((entry) => str(entry)).filter(Boolean) : [];
}

/**
 * Reads request parameters from either a JSON object or a form body.
 *
 * OIDC token, revocation, and logout endpoints receive
 * `application/x-www-form-urlencoded`; the console and CLI use JSON. Accepting
 * both in one parser keeps the endpoints standard without a second code path.
 */
async function parameters(req: Request, maxBytes = 16 * 1024): Promise<Record<string, unknown>> {
  const type = req.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (type !== "application/x-www-form-urlencoded") return body(req, maxBytes);
  if (Number(req.headers.get("content-length")) > maxBytes) throw new RequestError(413, "Request body is too large");
  const text = await req.text();
  if (Buffer.byteLength(text, "utf8") > maxBytes) throw new RequestError(413, "Request body is too large");
  const result: Record<string, unknown> = {};
  for (const [key, value] of new URLSearchParams(text)) {
    if (key in result) throw new RequestError(400, `The ${key} parameter appears more than once`);
    result[key] = value;
  }
  return result;
}

function originOf(req: Request) {
  const configured = publicOrigin();
  if (configured) return configured;
  if (process.env.NODE_ENV === "production") throw new RequestError(503, "Configure the public HTTPS origin before starting pairing");
  return new URL(req.url).origin;
}

/** Turns a pairing state-machine reason into something a user can act on. */
function pairingError(reason: string) {
  switch (reason) {
    case "unknown_session":
    case "invalid_secret":
      return "This QR code is not valid. Ask the dashboard to show a new one.";
    case "expired":
      return "This QR code has expired. QR codes are valid for two minutes.";
    case "closed":
      return "This pairing was cancelled on the dashboard.";
    case "already_connected":
      return "This QR code was already used. If the phone did not receive its session, revoke the linked device and start a new pairing.";
    case "already_approved":
      return "This QR code was already approved. Ask the dashboard to show a new one.";
    case "not_approved":
      return "This pairing has not been approved on the dashboard yet.";
    case "account_mismatch":
      return "This QR code belongs to a different account.";
    default:
      return "This pairing could not be completed. Try again from the dashboard.";
  }
}

/** A repository URL must look like a git remote the builder can clone. */
function isGitUrl(value: string) {
  try {
    const url = new URL(value);
    return value.length <= 2048 && url.protocol === "https:" && !url.username && !url.password && !url.hash && !url.search && url.pathname !== "/";
  } catch {
    return false;
  }
}

const NO_REPO_NOTE = "No repository is configured for this project. Connect a repository before deploying.";

/** Records a deployment row and publishes `deployment.updated` atomically. */
function recordDeployment(
  db: DatabaseSync,
  owner: string,
  project: { id: string; name: string },
  status: string,
  note: string,
) {
  const id = newId();
  tx(db, () => {
    db.prepare(
      "INSERT INTO deployments (id, owner_id, project_id, status, note, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(id, owner, project.id, status, note, Date.now());
    publish(db, owner, "deployment.updated", id, { id, projectId: project.id, project: project.name, status, note });
  });
  return id;
}

/** Records a build row and publishes `build.updated` atomically. */
function recordBuild(
  db: DatabaseSync,
  owner: string,
  project: { id: string; name: string },
  target: string,
  status: string,
  note: string,
) {
  const id = newId();
  tx(db, () => {
    db.prepare(
      "INSERT INTO builds (id, owner_id, project_id, target, status, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(id, owner, project.id, target, status, note, Date.now());
    publish(db, owner, "build.updated", id, { id, projectId: project.id, project: project.name, target, status, note });
  });
  return id;
}

export async function handle(req: Request, parts: string[]): Promise<Response> {
  const started = Date.now();
  const path = parts.join("/");
  let owner: string | null = null;
  let status = 200;
  try {
    const result = await route(req, parts);
    owner = result.owner;
    status = result.status;
    return new Response(result.response.body, { status: result.status, headers: result.response.headers });
  } catch (error) {
    const known = error instanceof RequestError || error instanceof FunctionError;
    status = known ? (error as RequestError).status : 500;
    if (status === 500) console.warn("Unexpected control-plane request failure");
    return json({ error: known ? (error as Error).message : "Request failed" }, status);
  } finally {
    if (owner && path !== "events" && path !== "health") {
      try { record(owner, `/${path}`.slice(0, 180), status, started, req); }
      catch { console.warn("Control-plane request telemetry write failed"); }
    }
  }
}

async function route(req: Request, parts: string[]): Promise<{ response: Response; status: number; owner: string | null }> {
  const method = req.method;
  const key = `${method} ${parts.join("/")}`;
  if (method !== "GET" && method !== "HEAD") requireOrigin(req);
  if (key === "POST auth/signup") throw new RequestError(403, "Public registration is disabled. Contact your MobileCloud operator.");
  if (key === "GET health") {
    return {
      response: json({
        service: "MobileCloud",
        apiVersion: 1,
        status: "ok",
        environment: process.env.NODE_ENV ?? "development",
        time: new Date().toISOString(),
        signupEnabled: false,
        realtime: {
          transport: "websocket",
          path: "/api/realtime",
          port: realtimePort(),
          url: publicOrigin()?.replace(/^http/, "ws")?.concat("/api/realtime") ?? null,
          fallback: "/api/sync/changes",
          schemaVersion: 1,
        },
      }),
      status: 200,
      owner: null,
    };
  }
  const db = openDb();

  // Container liveness and readiness probes. Readiness is deliberately
  // fail-closed: the instance should not receive identity traffic until the
  // database, issuer configuration and signing key are all usable.
  if (key === "GET health/live") {
    return { response: json({ status: "ok" }), status: 200, owner: null };
  }
  if (key === "GET health/ready") {
    const checks = { database: false, issuer: false, signing_key: false };
    try {
      db.prepare("SELECT 1").get();
      checks.database = true;
      issuerId(originOf(req));
      checks.issuer = true;
      ensureSigningKey(db);
      checks.signing_key = true;
    } catch { /* reported through the checks below */ }
    const ready = Object.values(checks).every(Boolean);
    return {
      response: json({ status: ready ? "ready" : "not_ready", checks, at: new Date().toISOString() }, ready ? 200 : 503),
      status: ready ? 200 : 503,
      owner: null,
    };
  }

  if (key === "POST auth/login") {
    const input = await body(req, 4096);
    const email = str(input.email).toLowerCase();
    const password = str(input.password);
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+$/.test(email) || password.length < 8 || password.length > 256) {
      throw new RequestError(400, "A valid email and password are required");
    }
    throttle("login", email);
    const row = db.prepare("SELECT id, password_hash, locked_until, active FROM users WHERE email = ?").get(email) as
      { id: string; password_hash: string; locked_until: number | null; active: number } | undefined;
    // Run the same costly verifier for missing and reset-required accounts.
    const stored = row?.password_hash.includes(":") ? row.password_hash : `${"0".repeat(32)}:${"0".repeat(64)}`;
    if (!verifyPassword(password, stored) || !row || isRetiredPassword(password) || row.active !== 1) {
      logAuthEvent(db, {
        userId: row?.id ?? null,
        eventType: "auth.login.failed",
        clientType: "web",
        credentialType: "password",
        ipAddress: requestIp(req),
        userAgent: req.headers.get("user-agent")?.slice(0, 180) ?? null,
        geo: geoFor(requestIp(req)),
        outcome: "failure",
        failureReason: "invalid_credentials",
      });
      if (row) lockIfRepeatedFailures(db, row.id);
      throw new RequestError(401, "Email or password is wrong");
    }
    if (row.locked_until && row.locked_until > Date.now()) {
      throw new RequestError(429, "Too many failed attempts. Try again later.");
    }
    const risk = assessLoginRisk(db, {
      userId: row.id,
      ipAddress: requestIp(req),
      userAgent: req.headers.get("user-agent")?.slice(0, 180) ?? null,
      geo: geoFor(requestIp(req)),
      credentialType: "password",
      timezone: userTimezone(db, row.id),
    });
    if (risk.action === "block") {
      logAuthEvent(db, {
        userId: row.id,
        eventType: "auth.login.failed",
        clientType: "web",
        credentialType: "password",
        ipAddress: requestIp(req),
        geo: geoFor(requestIp(req)),
        outcome: "suspicious",
        failureReason: "risk_blocked",
        riskScore: risk.riskScore,
        metadata: { factors: risk.factors },
      });
      throw new RequestError(403, "This sign-in was blocked because it did not look like your usual sign-in.");
    }
    db.prepare("UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = ?").run(row.id);
    log(row.id, "info", "auth", "signed in");
    logAuthEvent(db, {
      userId: row.id,
      eventType: "auth.login.password",
      clientType: "web",
      credentialType: "password",
      ipAddress: requestIp(req),
      userAgent: req.headers.get("user-agent")?.slice(0, 180) ?? null,
      geo: geoFor(requestIp(req)),
      outcome: risk.action === "allow_with_notification" ? "suspicious" : "success",
      riskScore: risk.riskScore,
      metadata: { factors: risk.factors },
    });
    if (risk.action === "allow_with_notification") {
      notify(db, row.id, "auth.suspicious", "New sign-in", "A sign-in happened from a place you have not used before.");
    }
    return issueSession(db, row.id, req);
  }

  if (key === "POST auth/device/code") {
    throttle("device-code");
    const started = startDevice(db);
    return { response: json(started), status: 200, owner: null };
  }
  if (key === "POST auth/device/token") {
    const deviceCode = str((await body(req, 4096)).deviceCode);
    throttle("device-token", /^[a-f0-9]{48}$/.test(deviceCode) ? tokenHash(deviceCode) : undefined, 30);
    const result = pollDevice(db, deviceCode);
    const status = result.status === "approved" ? 200 : result.status === "expired" ? 400 : 202;
    return { response: json(result, status), status, owner: null };
  }

  // ---- QR device pairing: the scanning device's half ---------------------
  // After the first scan, only the client holding the scoped scan cookie may
  // follow or claim this ticket. A QR copy alone cannot claim that approval.
  if (parts[0] === "device" && parts[1] === "pairing" && parts[2] && !/^[a-f0-9]{32}$/.test(parts[2])) {
    throw new RequestError(404, "Pairing session not found");
  }

  if (method === "POST" && parts[0] === "device" && parts[1] === "pairing" && parts[2] && parts[3] === "scan") {
    const input = await body(req);
    const secret = str(input.secret);
    if (!secret) return { response: json({ error: "A pairing secret is required" }, 400), status: 400, owner: null };
    const device = {
      name: str(input.name) || undefined,
      platform: str(input.platform) || undefined,
      appVersion: str(input.appVersion) || undefined,
    };
    throttle("pairing-scan", parts[2].slice(0, 64));
    const proof = `scan_${randomBytes(32).toString("hex")}`;
    const result = tx(db, () => {
      const outcome = scanPairing(db, parts[2], secret, device, proof, readScanProof(req));
      if (!outcome.ok || outcome.duplicate) return outcome;
      publish(db, outcome.row.owner_id, "device.pairing.scanned", outcome.row.id, publicPairing(outcome.row));
      markAwaitingApproval(db, parts[2]);
      const row = readPairing(db, parts[2]) ?? outcome.row;
      publish(db, row.owner_id, "device.pairing.approval_requested", row.id, publicPairing(row));
      return { ...outcome, row };
    });
    if (!result.ok) {
      const status = result.reason === "unknown_session" || result.reason === "invalid_secret" ? 404 : 409;
      return { response: json({ error: pairingError(result.reason), reason: result.reason }, status), status, owner: null };
    }
    const headers = new Headers();
    if (!result.duplicate) headers.append("set-cookie", pairingCookie(req, parts[2], proof, 240));
    return { response: json({ pairing: publicPairing(result.row), duplicate: result.duplicate }, 200, headers), status: 200, owner: null };
  }

  if (method === "POST" && parts[0] === "device" && parts[1] === "pairing" && parts[2] && parts[3] === "status") {
    throttle("pairing-status", parts[2].slice(0, 64), 100);
    const secret = str((await body(req, 4096)).secret);
    const row = readPairing(db, parts[2]);
    if (!row || !secretMatches(row, secret) || (row.scan_hash && !scanProofMatches(row, readScanProof(req)))) {
      return { response: json({ error: pairingError("unknown_session"), reason: "unknown_session" }, 404), status: 404, owner: null };
    }
    return { response: json({ pairing: publicPairing(row) }), status: 200, owner: null };
  }

  if (method === "POST" && parts[0] === "device" && parts[1] === "pairing" && parts[2] && parts[3] === "claim") {
    const input = await body(req);
    const row = readPairing(db, parts[2]);
    if (!row || !secretMatches(row, str(input.secret)) || (row.scan_hash && !scanProofMatches(row, readScanProof(req)))) {
      return { response: json({ error: pairingError("unknown_session"), reason: "unknown_session" }, 404), status: 404, owner: null };
    }
    throttle("pairing-claim", parts[2].slice(0, 64));
    const claimed = tx(db, () => {
      const outcome = approvePairing(db, row, row.owner_id);
      if (!outcome.ok) return outcome;
      const pairing = publicPairing(outcome.row);
      publish(db, row.owner_id, "device.pairing.connected", row.id, pairing);
      publish(db, row.owner_id, "device.connected", outcome.device.id, {
        device_id: outcome.device.id,
        device_name: outcome.device.name,
        platform: outcome.device.platform,
        method: "qr",
      });
      const headers = startSession(db, row.owner_id, req, outcome.device.id);
      return { ...outcome, headers, pairing };
    });
    if (!claimed.ok) {
      const status = claimed.reason === "not_approved" || claimed.reason === "race" ? 409 : 410;
      return { response: json({ error: pairingError(claimed.reason), reason: claimed.reason }, status), status, owner: null };
    }
    log(row.owner_id, "info", "device", `linked ${claimed.device.name} (${claimed.device.platform}) with a QR code`);
    const { headers, pairing } = claimed;
    headers.append("set-cookie", pairingCookie(req, parts[2], "", 0));
    return {
      response: json({
        account_id: claimed.row.owner_id,
        device: {
          id: claimed.device.id,
          name: claimed.device.name,
          platform: claimed.device.platform,
          app_version: claimed.device.appVersion,
        },
        // Shown to the phone exactly once; only its hash is stored server-side.
        credential: claimed.credential,
        credential_expires_at: claimed.credentialExpiresAt ? new Date(claimed.credentialExpiresAt).toISOString() : null,
        pairing,
      }, 200, headers),
      status: 200,
      owner: claimed.row.owner_id,
    };
  }

  if (key === "POST auth/logout") {
    if (req.body && req.headers.get("content-length") !== "0") await body(req, 4096);
    const auth = authenticate(req, db);
    if (req.headers.has("authorization") && !auth) throw new RequestError(401, "Sign in required");
    requireCsrf(req, auth);
    if (auth) tx(db, () => {
      const owner = auth.user.id;
      if (auth.via === "cookie") {
        const row = db.prepare("SELECT id FROM sessions WHERE token_hash = ?").get(auth.hash) as { id: string } | undefined;
        db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(auth.hash);
        if (row) publish(db, owner, "session.revoked", row.id, { sessionId: row.id, reason: "signed_out" });
      }
      if (auth.deviceId) {
        if (revokeDevice(db, owner, auth.deviceId).ok) {
          publish(db, owner, "device.disconnected", auth.deviceId, { device_id: auth.deviceId, reason: "signed_out" });
        }
      } else if (auth.via === "bearer") {
        db.prepare("DELETE FROM access_tokens WHERE owner_id = ? AND id = ?").run(owner, auth.tokenId);
        // A refresh token outliving its access token would let a signed-out
        // client mint a fresh one, so the whole chain is retired here.
        db.prepare("UPDATE refresh_tokens SET revoked = 1 WHERE access_token_id = ?").run(auth.tokenId);
        publish(db, owner, "configuration.updated", auth.tokenId, { resource: "token", id: auth.tokenId, deleted: true });
      }
    });
    const headers = new Headers();
    if (!auth || auth.via === "cookie") {
      headers.append("set-cookie", cookieHeader(req, "", 0));
      headers.append("set-cookie", csrfCookieHeader(req, "", 0));
      headers.append("set-cookie", gateCookie("", 0, secureCookie(req)));
    }
    return { response: json({ ok: true }, 200, headers), status: 200, owner: auth?.user.id ?? null };
  }

  if (key === "GET auth/me") {
    requireOrigin(req);
    const auth = authenticate(req, db);
    const headers = new Headers();
    const csrfToken = auth?.via === "cookie" ? auth.csrf : null;
    if (csrfToken && readCookie(req, CSRF_COOKIE) !== csrfToken) {
      headers.append("set-cookie", csrfCookieHeader(req, csrfToken, WEEK / 1000));
    }
    return { response: json({ user: auth?.user ?? null, csrfToken, token: auth?.via === "bearer" ? auth.token : null }, 200, headers), status: 200, owner: auth?.user.id ?? null };
  }

  // ---- GitHub: the public half --------------------------------------------
  // The webhook receiver and the device authorization are reached by GitHub
  // and by a CLI, not by a signed-in browser, so they live before the gate.
  // Both are closed unless the operator configured the matching secret.

  if (method === "POST" && parts[0] === "github" && parts[1] === "webhook") {
    const config = githubConfig();
    if (!config?.webhookSecret) throw new RequestError(503, "GitHub webhooks are not configured on this server.");
    const raw = await rawBody(req, 1024 * 1024);
    if (!verifyWebhookSignature(config.webhookSecret, raw, req.headers.get("x-hub-signature-256"))) {
      throw new RequestError(401, "The webhook signature did not verify.");
    }
    const event = parseWebhookEvent(safeJson(raw));
    if (!event || event.kind === "ignored") return { response: json({ ok: true, ignored: true }), status: 200, owner: null };
    const owners = ownersForRepository(db, event.repositoryId);
    for (const owner of owners) {
      const repository = findRepository(db, owner, event.repositoryId);
      if (!repository) continue;
      const branch = event.branch ?? repository.defaultBranch;
      const started = startBuild(db, {
        ownerId: owner,
        projectId: repository.importedProjectId ?? null,
        projectName: repository.fullName,
        target: "repository",
        triggerSource: `github:${event.kind}`,
        repositoryId: repository.id,
        branch,
        commit: event.commit,
        note: `${event.kind} on ${event.fullName}`,
      });
      log(owner, "info", "builds", `github ${event.kind} on ${event.fullName}`);
      void started;
    }
    return { response: json({ ok: true }), status: 200, owner: null };
  }

  if (method === "POST" && parts[0] === "github" && parts[1] === "device" && parts[2] === "code") {
    const config = githubConfig();
    if (!config) throw new RequestError(503, "GitHub is not configured on this server.");
    const grant = await beginDeviceAuthorization(config);
    return { response: json(grant), status: 200, owner: null };
  }

  if (method === "POST" && parts[0] === "github" && parts[1] === "device" && parts[2] === "token") {
    const config = githubConfig();
    if (!config) throw new RequestError(503, "GitHub is not configured on this server.");
    const input = await body(req, 4096);
    const result = await pollDeviceAuthorization(config, str(input.device_code) || str(input.deviceCode));
    if (result.status !== "ok") return { response: json({ status: "pending", error: result.error ?? null }), status: 202, owner: null };
    const session = authenticate(req, db);
    if (!session) throw new RequestError(401, "Sign in before linking a GitHub account.");
    requireCsrf(req, session);
    const viewer = await fetchViewer(result.token!.accessToken);
    saveConnection(db, session.user.id, viewer, result.token!);
    return { response: json({ status: "ok", login: viewer.login }), status: 200, owner: session.user.id };
  }

  // ---- Unified authentication ---------------------------------------------
  // Passkey ceremonies, phone approved web login, and the OAuth grants the
  // CLI uses. Everything below runs before the "sign in required" gate, because
  // these endpoints are how a client signs in.

  if (method === "POST" && parts[0] === "auth" && parts[1] === "passkey" && parts[2] === "register" && parts[3] === "begin") {
    const input = await body(req, 16 * 1024);
    const deviceName = str(input.deviceName) || null;
    const devicePlatform = str(input.devicePlatform) || "android";
    const session = authenticate(req, db);
    if (session) requireCsrf(req, session);
    let userId: string;
    let email: string;
    let displayName: string;
    if (session) {
      userId = session.user.id;
      email = session.user.email;
      displayName = session.user.name;
    } else {
      // A passkey never bootstraps an account. Without a session the caller
      // proves the account with its password, once.
      const emailInput = str(input.email).toLowerCase();
      const password = str(input.password);
      if (!emailInput || !password) throw new RequestError(401, "Sign in, or prove the account with its password, to add a passkey.");
      throttle("passkey-register", emailInput, 6);
      const row = db.prepare("SELECT id, email, name, password_hash, active FROM users WHERE email = ?").get(emailInput) as
        { id: string; email: string; name: string; password_hash: string; active: number } | undefined;
      const stored = row?.password_hash.includes(":") ? row.password_hash : `${"0".repeat(32)}:${"0".repeat(64)}`;
      if (!row || !verifyPassword(password, stored) || isRetiredPassword(password) || row.active !== 1) {
        logAuthEvent(db, {
          eventType: "auth.login.failed",
          clientType: "android",
          credentialType: "password",
          ipAddress: requestIp(req),
          userAgent: req.headers.get("user-agent")?.slice(0, 180) ?? null,
          outcome: "failure",
          failureReason: "invalid_credentials",
        });
        throw new RequestError(401, "Email or password is wrong");
      }
      userId = row.id;
      email = row.email;
      displayName = row.name;
    }
    const options = beginRegistration(db, passkeyConfig(req), { userId, email, displayName, deviceName, devicePlatform });
    return { response: json(options), status: 200, owner: userId };
  }

  if (method === "POST" && parts[0] === "auth" && parts[1] === "passkey" && parts[2] === "register" && parts[3] === "finish") {
    const input = await body(req, 256 * 1024);
    throttle("passkey-register-finish");
    let registered;
    try {
      registered = finishRegistration(db, passkeyConfig(req), { challengeId: str(input.challengeId), credential: input.credential });
    } catch (error) {
      if (error instanceof PasskeyError) throw new RequestError(error.status, error.message);
      throw error;
    }
    const deviceName = str(input.deviceName) || "Android device";
    const devicePlatform = str(input.devicePlatform) || "android";
    const clientType: ClientType = devicePlatform === "web" ? "web" : "android";
    const deviceId = linkPasskeyDevice(db, registered.userId, deviceName, devicePlatform, registered.credentialId);
    const headers = startSession(db, registered.userId, req, deviceId, clientType, registered.credentialId);
    const user = db.prepare("SELECT id, email, name, role, plan FROM users WHERE id = ?").get(registered.userId);
    logAuthEvent(db, {
      userId: registered.userId,
      eventType: "auth.credential.created",
      clientType,
      credentialType: "passkey",
      deviceId,
      ipAddress: requestIp(req),
      userAgent: req.headers.get("user-agent")?.slice(0, 180) ?? null,
      geo: geoFor(requestIp(req)),
      outcome: "success",
    });
    return { response: json({ user, credential_id: registered.credentialId, device_id: deviceId }, 200, headers), status: 200, owner: registered.userId };
  }

  if (method === "POST" && parts[0] === "auth" && parts[1] === "passkey" && parts[2] === "login" && parts[3] === "begin") {
    const input = await body(req, 8 * 1024);
    const email = str(input.email).toLowerCase() || null;
    const options = beginAuthentication(db, passkeyConfig(req), {
      email,
      deviceName: str(input.deviceName) || null,
      devicePlatform: str(input.devicePlatform) || "android",
    });
    return { response: json(options), status: 200, owner: null };
  }

  if (method === "POST" && parts[0] === "auth" && parts[1] === "passkey" && parts[2] === "login" && parts[3] === "finish") {
    const input = await body(req, 256 * 1024);
    throttle("passkey-login");
    let signed;
    try {
      signed = finishAuthentication(db, passkeyConfig(req), { challengeId: str(input.challengeId), credential: input.credential });
    } catch (error) {
      if (error instanceof PasskeyError) {
        logAuthEvent(db, {
          eventType: "auth.login.failed",
          clientType: str(input.devicePlatform) || "android",
          credentialType: "passkey",
          ipAddress: requestIp(req),
          userAgent: req.headers.get("user-agent")?.slice(0, 180) ?? null,
          outcome: "failure",
          failureReason: "invalid_assertion",
        });
        throw new RequestError(error.status, error.message);
      }
      throw error;
    }
    const ip = requestIp(req);
    const geo = geoFor(ip);
    const risk = assessLoginRisk(db, {
      userId: signed.userId,
      ipAddress: ip,
      userAgent: req.headers.get("user-agent")?.slice(0, 180) ?? null,
      geo,
      credentialType: "passkey",
      timezone: userTimezone(db, signed.userId),
    });
    if (risk.action === "block") {
      logAuthEvent(db, {
        userId: signed.userId,
        eventType: "auth.login.failed",
        clientType: str(input.devicePlatform) || "android",
        credentialType: "passkey",
        ipAddress: ip,
        geo,
        outcome: "suspicious",
        failureReason: "risk_blocked",
        riskScore: risk.riskScore,
        metadata: { factors: risk.factors },
      });
      throw new RequestError(403, "This sign-in was blocked because it did not look like your usual sign-in.");
    }
    const deviceName = str(input.deviceName) || "Android device";
    const devicePlatform = str(input.devicePlatform) || "android";
    const clientType: ClientType = devicePlatform === "web" ? "web" : "android";
    const deviceId = linkPasskeyDevice(db, signed.userId, deviceName, devicePlatform, signed.credentialId);
    const headers = startSession(db, signed.userId, req, deviceId, clientType, signed.credentialId);
    const user = db.prepare("SELECT id, email, name, role, plan FROM users WHERE id = ?").get(signed.userId);
    logAuthEvent(db, {
      userId: signed.userId,
      eventType: "auth.login.passkey",
      clientType: devicePlatform,
      credentialType: "passkey",
      deviceId,
      ipAddress: ip,
      userAgent: req.headers.get("user-agent")?.slice(0, 180) ?? null,
      geo,
      outcome: risk.action === "allow_with_notification" ? "suspicious" : "success",
      riskScore: risk.riskScore,
      metadata: {
        factors: risk.factors,
        // Proof the assertion carried user verification, and the counter the
        // server accepted. No biometric data ever leaves the device.
        uv: signed.userVerified,
        signCount: signed.signCount,
        credentialId: signed.credentialId,
      },
    });
    if (risk.action === "allow_with_notification") {
      notify(db, signed.userId, "auth.suspicious", "New sign-in", "A sign-in happened from a place you have not used before.");
    }
    return { response: json({ user, device_id: deviceId }, 200, headers), status: 200, owner: signed.userId };
  }

  if (method === "POST" && parts[0] === "auth" && parts[1] === "qr-login" && parts[2] === "init") {
    const input = await body(req, 8 * 1024);
    throttle("qr-login-init");
    const browser = str(input.browser).slice(0, 180) || null;
    const created = createQrLogin(db, passkeyConfig(req), { browserInfo: browser, ipAddress: requestIp(req) });
    const qrDataUrl = await renderLoginQr(created.qrPayload);
    logAuthEvent(db, {
      eventType: "auth.login.qr_requested",
      clientType: "web",
      credentialType: "qr",
      ipAddress: requestIp(req),
      userAgent: req.headers.get("user-agent")?.slice(0, 180) ?? null,
      outcome: "success",
    });
    return {
      response: json({
        challenge_id: created.challengeId,
        verification_code: created.verificationCode,
        qr_data_url: qrDataUrl,
        // The payload is the same string the QR encodes. Returning it lets the
        // console offer "open in app" and lets tests exercise the phone half.
        qr_payload: created.qrPayload,
        poll_secret: created.pollSecret,
        expires_in_ms: created.expiresInMs,
      }),
      status: 200,
      owner: null,
    };
  }

  if (method === "POST" && parts[0] === "auth" && parts[1] === "qr-login" && parts[2] && parts[3] === "scan") {
    const input = await body(req, 8 * 1024);
    try {
      scanQrLogin(db, parts[2], { deviceName: str(input.deviceName) || null, devicePlatform: str(input.devicePlatform) || null });
    } catch (error) {
      if (error instanceof QrLoginError) throw new RequestError(error.status, error.message);
      throw error;
    }
    return { response: json({ ok: true }), status: 200, owner: null };
  }

  if (method === "POST" && parts[0] === "auth" && parts[1] === "qr-login" && parts[2] && parts[3] === "approve") {
    const input = await body(req, 256 * 1024);
    throttle("qr-login-approve");
    const challenge = str(input.challenge);
    const verificationCode = str(input.verification_code) || str(input.verificationCode);
    let userId: string;
    let credentialId: string | null = null;
    let deviceId: string | null = null;
    if (input.credential) {
      // The phone proved itself with a passkey over the browser's challenge.
      let asserted;
      try {
        asserted = verifyAssertion(db, passkeyConfig(req), { credential: input.credential, expectedChallengeHex: challenge });
      } catch (error) {
        if (error instanceof PasskeyError) throw new RequestError(error.status, error.message);
        throw error;
      }
      userId = asserted.userId;
      credentialId = asserted.credentialId;
    } else {
      // Without a passkey the phone's own signed in session stands in.
      const session = authenticate(req, db);
      if (!session) throw new RequestError(401, "Sign in on the phone before approving this request.");
      requireCsrf(req, session);
      userId = session.user.id;
      deviceId = session.deviceId;
    }
    try {
      approveQrLogin(db, { challengeId: parts[2], challenge, verificationCode, userId, credentialId, deviceId });
    } catch (error) {
      if (error instanceof QrLoginError) throw new RequestError(error.status, error.message);
      throw error;
    }
    logAuthEvent(db, {
      userId,
      eventType: "auth.login.qr_approved",
      clientType: "web",
      credentialType: credentialId ? "passkey" : "token",
      deviceId,
      ipAddress: requestIp(req),
      userAgent: req.headers.get("user-agent")?.slice(0, 180) ?? null,
      outcome: "success",
    });
    notify(db, userId, "auth.session", "Web sign-in approved", "A browser signed in to your account from your phone.");
    return { response: json({ ok: true }), status: 200, owner: userId };
  }

  if (method === "POST" && parts[0] === "auth" && parts[1] === "qr-login" && parts[2] && parts[3] === "deny") {
    try {
      denyQrLogin(db, parts[2]);
    } catch (error) {
      if (error instanceof QrLoginError) throw new RequestError(error.status, error.message);
      throw error;
    }
    return { response: json({ ok: true }), status: 200, owner: null };
  }

  if (method === "GET" && parts[0] === "auth" && parts[1] === "qr-login" && parts[2] && !parts[3]) {
    const pollSecret = new URL(req.url).searchParams.get("poll") ?? "";
    let state;
    try {
      state = qrLoginStatus(db, parts[2], pollSecret);
    } catch (error) {
      if (error instanceof QrLoginError) throw new RequestError(error.status, error.message);
      throw error;
    }
    if (state.status !== "approved" || !state.row) {
      return { response: json({ status: state.status.toUpperCase() }), status: 200, owner: null };
    }
    // The browser that started the flow now receives the session. Claiming the
    // challenge and issuing the session happen in one transaction, so two polls
    // racing cannot both walk away with a credential.
    const row = state.row;
    const headers = tx(db, () => {
      if (!consumeQrLogin(db, parts[2])) return null;
      return startSession(db, row.approved_by ?? "", req, row.device_id, "web", row.credential_id);
    });
    if (!headers) {
      return { response: json({ status: "CONSUMED" }), status: 200, owner: null };
    }
    logAuthEvent(db, {
      userId: row.approved_by,
      eventType: "auth.login.qr_approved",
      clientType: "web",
      credentialType: "qr",
      deviceId: row.device_id,
      ipAddress: requestIp(req),
      userAgent: req.headers.get("user-agent")?.slice(0, 180) ?? null,
      outcome: "success",
    });
    return { response: json({ status: "APPROVED" }, 200, headers), status: 200, owner: row.approved_by };
  }

  // ---- Passkey management and WebAuthn step-up ---------------------------

  if (method === "GET" && parts[0] === "auth" && parts[1] === "passkeys") {
    const auth = authenticate(req, db);
    if (!auth) throw new RequestError(401, "Sign in required");
    return { response: json({ passkeys: listCredentials(db, auth.user.id) }), status: 200, owner: auth.user.id };
  }

  if (method === "DELETE" && parts[0] === "auth" && parts[1] === "passkeys" && parts[2]) {
    const auth = authenticate(req, db);
    if (!auth) throw new RequestError(401, "Sign in required");
    requireCsrf(req, auth);
    const user = db.prepare("SELECT password_hash FROM users WHERE id = ?").get(auth.user.id) as { password_hash: string } | undefined;
    const hasPassword = Boolean(user?.password_hash.includes(":"));
    const remaining = Number(
      (db.prepare("SELECT COUNT(*) AS n FROM credentials WHERE user_id = ?").get(auth.user.id) as { n: number }).n,
    );
    if (remaining <= 1 && !hasPassword) {
      throw new RequestError(409, "This is the account's only passkey and there is no password fallback; add another passkey or recovery method first.");
    }
    const removed = tx(db, () => {
      if (!deleteCredential(db, auth.user.id, parts[2])) return false;
      // Sessions authenticated by that credential are no longer attributable.
      db.prepare("DELETE FROM sessions WHERE user_id = ? AND credential_id = ?").run(auth.user.id, parts[2]);
      publish(db, auth.user.id, "session.revoked", parts[2], { credentialId: parts[2], reason: "passkey_removed" });
      return true;
    });
    if (!removed) throw new RequestError(404, "Passkey not found");
    logAuthEvent(db, {
      userId: auth.user.id,
      eventType: "auth.credential.deleted",
      clientType: "web",
      credentialType: "passkey",
      ipAddress: requestIp(req),
      userAgent: req.headers.get("user-agent")?.slice(0, 180) ?? null,
      outcome: "success",
      metadata: { credentialId: parts[2] },
    });
    return { response: json({ ok: true }), status: 200, owner: auth.user.id };
  }

  if (method === "POST" && parts[0] === "auth" && parts[1] === "step-up" && parts[2] === "begin") {
    const input = await body(req, 8 * 1024);
    const session = authenticate(req, db);
    let userId: string;
    let clientId: string;
    if (session) {
      requireCsrf(req, session);
      userId = session.user.id;
      clientId = str(input.client_id) || "mobilecloud-console";
    } else {
      const basic = clientCredentials(req);
      if (!basic) throw new RequestError(401, "Client authentication is required.");
      let client;
      try {
        client = requireClient(db, basic.id, basic.secret);
      } catch (error) {
        if (error instanceof OAuthError) throw new RequestError(error.status, error.message);
        throw error;
      }
      if (client.public) throw new RequestError(403, "A public client cannot request a step-up for an account.");
      userId = str(input.user_id);
      clientId = client.id;
    }
    if (!userId) throw new RequestError(400, "A user is required.");
    try {
      const challenge = createStepUp(db, passkeyConfig(req), {
        userId,
        clientId,
        action: str(input.action),
        payload: input.payload,
      });
      return {
        response: json({
          challenge_id: challenge.challengeId,
          public_key: challenge.publicKey,
          expires_in_ms: challenge.expiresInMs,
        }),
        status: 200,
        owner: userId,
      };
    } catch (error) {
      if (error instanceof StepUpError) throw new RequestError(error.status, error.message);
      throw error;
    }
  }

  if (method === "POST" && parts[0] === "auth" && parts[1] === "step-up" && parts[2] === "verify") {
    const input = await body(req, 256 * 1024);
    const session = authenticate(req, db);
    if (session) {
      requireCsrf(req, session);
    } else {
      const basic = clientCredentials(req);
      if (!basic) throw new RequestError(401, "Client authentication is required.");
      let client;
      try {
        client = requireClient(db, basic.id, basic.secret);
      } catch (error) {
        if (error instanceof OAuthError) throw new RequestError(error.status, error.message);
        throw error;
      }
      if (client.public) throw new RequestError(403, "A public client cannot verify a step-up.");
    }
    try {
      const result = verifyStepUp(db, passkeyConfig(req), {
        challengeId: str(input.challenge_id) || str(input.challengeId),
        credential: input.credential,
        payload: input.payload,
      });
      logAuthEvent(db, {
        userId: result.userId,
        eventType: `auth.stepup.${result.action}`,
        clientType: "web",
        credentialType: "passkey",
        ipAddress: requestIp(req),
        userAgent: req.headers.get("user-agent")?.slice(0, 180) ?? null,
        outcome: "success",
        metadata: { action: result.action, credentialId: result.credentialId },
      });
      return {
        response: json({
          step_up_token: result.token,
          expires_at: result.expiresAt,
          action: result.action,
          user_id: result.userId,
        }),
        status: 200,
        owner: result.userId,
      };
    } catch (error) {
      if (error instanceof StepUpError) throw new RequestError(error.status, error.message);
      throw error;
    }
  }

  // ---- OAuth: device authorization grant and PKCE -------------------------

  if (method === "POST" && parts[0] === "oauth" && parts[1] === "device" && parts[2] === "code") {
    const input = await body(req, 8 * 1024);
    throttle("oauth-device-code");
    try {
      const grant = startDeviceGrant(db, {
        clientId: str(input.client_id) || str(input.clientId),
        scope: str(input.scope) || null,
        verificationUri: `${originOf(req)}/activate`,
      });
      return {
        response: json({
          device_code: grant.deviceCode,
          user_code: grant.userCode,
          verification_uri: grant.verificationUri,
          verification_uri_complete: grant.verificationUriComplete,
          expires_in: grant.expiresIn,
          interval: grant.interval,
        }),
        status: 200,
        owner: null,
      };
    } catch (error) {
      if (error instanceof OAuthError) throw new RequestError(error.status, error.message);
      throw error;
    }
  }

  if (method === "POST" && parts[0] === "oauth" && parts[1] === "device" && parts[2] === "verify") {
    const input = await body(req, 8 * 1024);
    const session = authenticate(req, db);
    if (!session) throw new RequestError(401, "Sign in to approve this request.");
    requireCsrf(req, session);
    const code = findDeviceCode(db, str(input.user_code) || str(input.userCode));
    if (!code || code.expires_at <= Date.now()) throw new RequestError(404, "That code is not valid.");
    if (code.approved_by) throw new RequestError(409, "That request was already approved.");
    return {
      response: json({
        id: code.id,
        user_code: code.user_code,
        client_id: code.client_id,
        scope: code.scope,
        status: code.status,
        expires_in_ms: Math.max(0, code.expires_at - Date.now()),
      }),
      status: 200,
      owner: session.user.id,
    };
  }

  if (method === "POST" && parts[0] === "oauth" && parts[1] === "device" && parts[2] && parts[3] === "approve") {
    const session = authenticate(req, db);
    if (!session) throw new RequestError(401, "Sign in to approve this request.");
    requireCsrf(req, session);
    const input = await body(req, 4096);
    try {
      approveDeviceCode(db, parts[2], session.user.id, {
        name: str(input.device_name) || str(input.deviceName) || null,
        platform: str(input.device_platform) || str(input.devicePlatform) || null,
      });
    } catch (error) {
      if (error instanceof OAuthError) throw new RequestError(error.status, error.message);
      throw error;
    }
    logAuthEvent(db, {
      userId: session.user.id,
      eventType: "auth.login.device_grant",
      clientType: "cli",
      credentialType: "device_grant",
      ipAddress: requestIp(req),
      userAgent: req.headers.get("user-agent")?.slice(0, 180) ?? null,
      outcome: "success",
    });
    notify(db, session.user.id, "auth.session", "CLI signed in", "A command line client was authorized.");
    return { response: json({ ok: true }), status: 200, owner: session.user.id };
  }

  if (method === "POST" && parts[0] === "oauth" && parts[1] === "device" && parts[2] && parts[3] === "deny") {
    const session = authenticate(req, db);
    if (!session) throw new RequestError(401, "Sign in to answer this request.");
    requireCsrf(req, session);
    try {
      denyDeviceCode(db, parts[2]);
    } catch (error) {
      if (error instanceof OAuthError) throw new RequestError(error.status, error.message);
      throw error;
    }
    return { response: json({ ok: true }), status: 200, owner: session.user.id };
  }

  if (method === "POST" && parts[0] === "oauth" && parts[1] === "token") {
    const input = await parameters(req, 16 * 1024);
    const grantType = str(input.grant_type) || str(input.grantType);
    throttle("oauth-token", undefined, 240);
    try {
      const basic = clientCredentials(req);
      const clientId = basic?.id || str(input.client_id) || str(input.clientId);
      const secret = basic?.secret ?? (str(input.client_secret) || null);
      if (grantType === "urn:ietf:params:oauth:grant-type:device_code") {
        requireClient(db, clientId, secret);
        const pair = redeemDeviceCode(db, {
          deviceCode: str(input.device_code) || str(input.deviceCode),
          clientId,
        });
        return oauthJson(pair);
      }
      if (grantType === "refresh_token") {
        // A refresh token is itself a bearer secret; a client id, when sent,
        // must still authenticate so a public client cannot impersonate a
        // confidential one.
        if (clientId) requireClient(db, clientId, secret);
        const pair = refreshTokens(db, str(input.refresh_token) || str(input.refreshToken));
        return oauthJson(pair);
      }
      if (grantType === "authorization_code") {
        const client = requireClient(db, clientId, secret);
        const pair = redeemAuthorizationCode(db, {
          code: str(input.code),
          codeVerifier: str(input.code_verifier) || str(input.codeVerifier),
          clientId: client.id,
          redirectUri: str(input.redirect_uri) || str(input.redirectUri),
          accessTtlMs: oidcAccessTtl(),
        });
        const user = db.prepare("SELECT id, email, name FROM users WHERE id = ? AND active = 1").get(pair.userId) as
          | Pick<User, "id" | "email" | "name">
          | undefined;
        if (!user) throw new OAuthError(400, "invalid_grant", "That account is no longer active.");
        const idToken = pair.scope.split(/\s+/).includes("openid")
          ? issueIdToken(db, {
              origin: originOf(req),
              client,
              user,
              scope: pair.scope,
              nonce: pair.nonce,
              authTime: pair.authTime,
            })
          : null;
        return oauthJson(pair, idToken);
      }
    } catch (error) {
      if (error instanceof OAuthError) {
        return {
          response: json({ error: error.code, error_description: error.message }, error.status),
          status: error.status,
          owner: null,
        };
      }
      throw error;
    }
    throw new RequestError(400, `That grant type is not supported: ${grantType}`);
  }

  if (method === "GET" && parts[0] === "oauth" && parts[1] === "authorize") {
    const params = new URL(req.url).searchParams;
    const clientId = params.get("client_id") ?? "";
    const redirectUri = params.get("redirect_uri") ?? "";
    const challenge = params.get("code_challenge") ?? "";
    const client = findClient(db, clientId);
    if (!client) throw new RequestError(400, "That client is not registered.");
    if (!client.redirectUris.includes(redirectUri)) throw new RequestError(400, "That redirect address is not registered.");
    if (!challenge) throw new RequestError(400, "A code challenge is required.");
    if ((params.get("code_challenge_method") ?? "S256") !== "S256") throw new RequestError(400, "Only the S256 challenge method is supported.");
    checkScope(client, params.get("scope"));
    const target = new URL("/authorize", originOf(req));
    target.search = params.toString();
    return { response: new Response(null, { status: 302, headers: { location: target.toString() } }), status: 302, owner: null };
  }

  if (method === "POST" && parts[0] === "oauth" && parts[1] === "authorize") {
    const input = await body(req, 8 * 1024);
    const session = authenticate(req, db);
    if (!session) throw new RequestError(401, "Sign in to authorize this client.");
    requireCsrf(req, session);
    const clientId = str(input.client_id) || str(input.clientId);
    const redirectUri = str(input.redirect_uri) || str(input.redirectUri);
    const challenge = str(input.code_challenge) || str(input.codeChallenge);
    const state = str(input.state);
    const nonce = str(input.nonce);
    const client = findClient(db, clientId);
    if (!client) throw new RequestError(400, "That client is not registered.");
    if (!client.redirectUris.includes(redirectUri)) throw new RequestError(400, "That redirect address is not registered.");
    if (!/^[A-Za-z0-9_-]{43}$/.test(challenge)) throw new RequestError(400, "A valid PKCE code challenge is required.");
    const scope = checkScope(client, str(input.scope) || null);
    if (str(input.decision) !== "approve") {
      const denied = new URL(redirectUri);
      denied.searchParams.set("error", "access_denied");
      if (state) denied.searchParams.set("state", state);
      const response = consentRedirect(req, denied.toString());
      return { response, status: response.status, owner: session.user.id };
    }
    const code = createAuthorizationCode(db, {
      clientId,
      userId: session.user.id,
      redirectUri,
      scope,
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
      nonce: nonce || null,
    });
    // The approval is recorded so a later consent screen can show what the
    // account already granted and the audit trail can answer why.
    recordConsent(db, session.user.id, clientId, scope);
    const target = new URL(redirectUri);
    target.searchParams.set("code", code);
    if (state) target.searchParams.set("state", state);
    logAuthEvent(db, {
      userId: session.user.id,
      eventType: client.id === "mobilecloud-cli" ? "auth.login.device_grant" : "auth.login.oidc",
      clientType: client.id === "mobilecloud-cli" ? "cli" : "web",
      credentialType: "oidc",
      ipAddress: requestIp(req),
      userAgent: req.headers.get("user-agent")?.slice(0, 180) ?? null,
      outcome: "success",
    });
    const response = consentRedirect(req, target.toString());
    return { response, status: response.status, owner: session.user.id };
  }

  // ---- Custom SSO: OIDC provider, SAML IdP and SCIM provisioning ----------

  if (method === "GET" && parts[0] === ".well-known" && parts[1] === "openid-configuration") {
    return { response: json(discovery(originOf(req))), status: 200, owner: null };
  }

  if (method === "GET" && parts[0] === ".well-known" && parts[1] === "jwks.json") {
    return { response: json(signingJwks(db)), status: 200, owner: null };
  }

  if ((method === "GET" || method === "POST") && parts[0] === "oauth" && parts[1] === "userinfo") {
    const bearer = userFromBearer(db, req.headers.get("authorization"));
    if (!bearer) {
      const headers = new Headers({ "www-authenticate": 'Bearer error="invalid_token"' });
      return {
        response: json({ error: "invalid_token", error_description: "A bearer access token is required." }, 401, headers),
        status: 401,
        owner: null,
      };
    }
    return {
      response: json({ ...userClaims(bearer.user, bearer.token.scope), role: bearer.user.role }),
      status: 200,
      owner: bearer.user.id,
    };
  }

  if (method === "POST" && parts[0] === "oauth" && parts[1] === "revoke") {
    const input = await parameters(req, 8 * 1024);
    const token = str(input.token);
    if (token) revokeOAuthToken(db, token);
    // RFC 7009: an unknown token also answers 200, so the endpoint cannot be
    // used to test whether a token exists.
    return { response: json({}), status: 200, owner: null };
  }

  if (method === "POST" && parts[0] === "oauth" && parts[1] === "introspect") {
    const input = await parameters(req, 8 * 1024);
    const basic = clientCredentials(req);
    try {
      requireClient(db, basic?.id || str(input.client_id), basic?.secret ?? (str(input.client_secret) || null));
    } catch (error) {
      if (error instanceof OAuthError) {
        return {
          response: json({ error: error.code, error_description: error.message }, error.status),
          status: error.status,
          owner: null,
        };
      }
      throw error;
    }
    const raw = str(input.token);
    if (!raw) return { response: json({ active: false }), status: 200, owner: null };
    const hash = tokenHash(raw);
    const now = Date.now();
    const access = db.prepare(
      `SELECT a.owner_id AS userId, a.scope, a.client_id AS clientId, a.created_at AS issuedAt, a.expires_at AS expiresAt,
              u.email, u.name, u.active
       FROM access_tokens a JOIN users u ON u.id = a.owner_id WHERE a.token_hash = ?`,
    ).get(hash) as { userId: string; scope: string; clientId: string | null; issuedAt: number; expiresAt: number; email: string; name: string; active: number } | undefined;
    if (access && access.expiresAt > now && access.active === 1) {
      return {
        response: json({
          active: true,
          scope: access.scope,
          client_id: access.clientId,
          token_type: "Bearer",
          exp: Math.floor(access.expiresAt / 1000),
          iat: Math.floor(access.issuedAt / 1000),
          sub: access.userId,
          username: access.email,
          name: access.name,
        }),
        status: 200,
        owner: access.userId,
      };
    }
    const refresh = db.prepare(
      `SELECT r.user_id AS userId, r.scope, r.client_id AS clientId, r.created_at AS issuedAt, r.expires_at AS expiresAt,
              r.used_at AS usedAt, r.revoked, u.email, u.name, u.active
       FROM refresh_tokens r JOIN users u ON u.id = r.user_id WHERE r.token_hash = ?`,
    ).get(hash) as { userId: string; scope: string; clientId: string | null; issuedAt: number; expiresAt: number; usedAt: number | null; revoked: number; email: string; name: string; active: number } | undefined;
    if (refresh && !refresh.usedAt && refresh.revoked === 0 && refresh.expiresAt > now && refresh.active === 1) {
      return {
        response: json({
          active: true,
          scope: refresh.scope,
          client_id: refresh.clientId,
          token_type: "refresh_token",
          exp: Math.floor(refresh.expiresAt / 1000),
          iat: Math.floor(refresh.issuedAt / 1000),
          sub: refresh.userId,
          username: refresh.email,
        }),
        status: 200,
        owner: refresh.userId,
      };
    }
    // RFC 7662: an unknown, expired or revoked token is simply inactive.
    return { response: json({ active: false }), status: 200, owner: null };
  }

  if ((method === "GET" || method === "POST") && parts[0] === "oauth" && parts[1] === "logout") {
    const input: Record<string, unknown> =
      method === "GET" ? Object.fromEntries(new URL(req.url).searchParams) : await parameters(req, 8 * 1024);
    const auth = authenticate(req, db);
    const hint = str(input.id_token_hint);
    const claims = hint ? decodeJwtPayload(hint) : null;
    const clientId = str(input.client_id) || (typeof claims?.aud === "string" ? claims.aud : "");
    const client = clientId ? findClient(db, clientId) : null;
    const redirect = str(input.post_logout_redirect_uri) || str(input.postLogoutRedirectUri);
    if (redirect && (!client || !client.postLogoutRedirectUris.includes(redirect))) {
      throw new RequestError(400, "That post-logout redirect address is not registered.");
    }
    let sessionId: string | null = null;
    if (auth) {
      if (auth.via === "cookie") {
        const row = db.prepare("SELECT id FROM sessions WHERE token_hash = ?").get(auth.hash) as { id: string | null } | undefined;
        sessionId = row?.id ?? null;
        tx(db, () => {
          db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(auth.hash);
          publish(db, auth.user.id, "session.revoked", sessionId ?? auth.hash, {
            sessionId: sessionId ?? auth.hash,
            reason: "signed_out",
          });
        });
      }
      if (str(input.all) === "1" || str(input.all) === "true") {
        tx(db, () => {
          const rows = db.prepare("SELECT id FROM sessions WHERE user_id = ?").all(auth.user.id) as { id: string }[];
          db.prepare("DELETE FROM sessions WHERE user_id = ?").run(auth.user.id);
          db.prepare("UPDATE access_tokens SET expires_at = ? WHERE owner_id = ?").run(Date.now(), auth.user.id);
          db.prepare("UPDATE refresh_tokens SET revoked = 1 WHERE user_id = ?").run(auth.user.id);
          for (const row of rows) {
            publish(db, auth.user.id, "session.revoked", row.id, { sessionId: row.id, reason: "signed_out_everywhere" });
          }
        });
      }
      const targets = client ? [client] : listClients(db).filter((candidate) => candidate.backchannelLogoutUri);
      for (const target of targets) {
        if (!target.backchannelLogoutUri) continue;
        const logoutToken = issueLogoutToken(db, { origin: originOf(req), client: target, user: auth.user, sessionId });
        // Best effort and never awaited: an offline SP must not fail a logout.
        void deliverBackchannelLogout(target, logoutToken).catch(() => undefined);
      }
      logAuthEvent(db, {
        userId: auth.user.id,
        eventType: "auth.logout",
        clientType: auth.via === "cookie" ? "web" : "cli",
        credentialType: "session",
        sessionId,
        ipAddress: requestIp(req),
        userAgent: req.headers.get("user-agent")?.slice(0, 180) ?? null,
        outcome: "success",
      });
    }
    const headers = new Headers();
    headers.append("set-cookie", cookieHeader(req, "", 0));
    headers.append("set-cookie", csrfCookieHeader(req, "", 0));
    if (redirect) {
      const target = new URL(redirect);
      if (str(input.state)) target.searchParams.set("state", str(input.state));
      headers.set("location", target.toString());
      return { response: new Response(null, { status: 302, headers }), status: 302, owner: auth?.user.id ?? null };
    }
    return { response: json({ ok: true }, 200, headers), status: 200, owner: auth?.user.id ?? null };
  }

  if (method === "GET" && parts[0] === "saml" && parts[1] === "metadata") {
    const config = samlConfig(db, originOf(req));
    const headers = new Headers({
      "content-type": "application/samlmetadata+xml; charset=utf-8",
      "cache-control": "no-store",
    });
    return { response: new Response(buildSamlMetadata(config), { status: 200, headers }), status: 200, owner: null };
  }

  if ((method === "GET" || method === "POST") && parts[0] === "saml" && parts[1] === "sso") {
    const session = authenticate(req, db);
    if (!session) {
      const url = new URL(req.url);
      // The catch-all route sees /api/saml/sso; the browser should be sent
      // back to the standards path the metadata advertises.
      const publicPath = url.pathname.replace(/^\/api\/saml\//, "/saml/");
      const next = method === "GET" ? `${publicPath}${url.search}` : "/";
      const target = new URL("/login", originOf(req));
      target.searchParams.set("next", next);
      return {
        response: new Response(null, { status: 302, headers: { location: target.toString() } }),
        status: 302,
        owner: null,
      };
    }
    const config = samlConfig(db, originOf(req));
    const input: Record<string, unknown> =
      method === "GET" ? Object.fromEntries(new URL(req.url).searchParams) : await parameters(req, 256 * 1024);
    try {
      const request = parseAuthnRequest(db, config, {
        SAMLRequest: str(input.SAMLRequest),
        RelayState: str(input.RelayState),
      });
      const provider = findServiceProvider(db, request.issuer);
      if (!provider) throw new Error("That service provider is not registered.");
      const { html } = buildSamlResponse(config, provider, session.user, request);
      return {
        response: new Response(html, {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
        }),
        status: 200,
        owner: session.user.id,
      };
    } catch (error) {
      throw new RequestError(400, error instanceof Error ? error.message : "That SAML request could not be processed.");
    }
  }

  if (parts[0] === "scim" && parts[1] === "v2") {
    const writer = authenticateScim(db, req.headers.get("authorization"));
    if (!writer) {
      return {
        response: scimResponse(scimError(401, "A SCIM bearer token is required."), 401),
        status: 401,
        owner: null,
      };
    }
    const resource = parts[2] ?? "";
    const id = parts[3] ?? "";
    const search = new URL(req.url).searchParams;
    const query = {
      filter: search.get("filter"),
      startIndex: Number(search.get("startIndex") ?? 1),
      count: Number(search.get("count") ?? 100),
    };
    if (method === "GET" && resource === "ServiceProviderConfig") {
      return { response: scimResponse(serviceProviderConfig()), status: 200, owner: writer.ownerId };
    }
    try {
      if (resource === "Users") {
        if (method === "GET" && !id) {
          return { response: scimResponse(scimList(listUsers(db, query))), status: 200, owner: writer.ownerId };
        }
        if (method === "POST" && !id) {
          const result = createUser(db, await body(req));
          return { response: scimResponse(result.body, result.status), status: result.status, owner: writer.ownerId };
        }
        if (method === "GET" && id) {
          const user = getUser(db, id);
          return user
            ? { response: scimResponse(user), status: 200, owner: writer.ownerId }
            : { response: scimResponse(scimError(404, "No such user."), 404), status: 404, owner: writer.ownerId };
        }
        if (method === "PUT" && id) {
          const result = replaceUser(db, id, await body(req));
          return { response: scimResponse(result.body, result.status), status: result.status, owner: writer.ownerId };
        }
        if (method === "PATCH" && id) {
          const result = patchUser(db, id, await body(req));
          return { response: scimResponse(result.body, result.status), status: result.status, owner: writer.ownerId };
        }
        if (method === "DELETE" && id) {
          const removed = deleteUser(db, id);
          return removed
            ? { response: scimResponse(null, 204), status: 204, owner: writer.ownerId }
            : { response: scimResponse(scimError(404, "No such user."), 404), status: 404, owner: writer.ownerId };
        }
      }
      if (resource === "Groups") {
        if (method === "GET" && !id) {
          return { response: scimResponse(scimList(listGroups(db, query))), status: 200, owner: writer.ownerId };
        }
        if (method === "POST" && !id) {
          const result = createGroup(db, await body(req));
          return { response: scimResponse(result.body, result.status), status: result.status, owner: writer.ownerId };
        }
        if (method === "GET" && id) {
          const group = getGroup(db, id);
          return group
            ? { response: scimResponse(group), status: 200, owner: writer.ownerId }
            : { response: scimResponse(scimError(404, "No such group."), 404), status: 404, owner: writer.ownerId };
        }
        if (method === "PATCH" && id) {
          const result = patchGroup(db, id, await body(req));
          return { response: scimResponse(result.body, result.status), status: result.status, owner: writer.ownerId };
        }
        if (method === "DELETE" && id) {
          const removed = deleteGroup(db, id);
          return removed
            ? { response: scimResponse(null, 204), status: 204, owner: writer.ownerId }
            : { response: scimResponse(scimError(404, "No such group."), 404), status: 404, owner: writer.ownerId };
        }
      }
    } catch (error) {
      if (error instanceof ScimError) {
        return {
          response: scimResponse(error.body, error.status),
          status: error.status,
          owner: writer.ownerId,
        };
      }
      return {
        response: scimResponse(scimError(400, error instanceof Error ? error.message : "That SCIM request was rejected."), 400),
        status: 400,
        owner: writer.ownerId,
      };
    }
    return {
      response: scimResponse(scimError(404, "That SCIM endpoint does not exist."), 404),
      status: 404,
      owner: writer.ownerId,
    };
  }

  if (method === "GET" && parts[0] === "auth" && parts[1] === "events") {
    const auth = authenticate(req, db);
    if (!auth) throw new RequestError(401, "Sign in required");
    return { response: json({ events: listAuthEvents(db, auth.user.id) }), status: 200, owner: auth.user.id };
  }

  if (method === "POST" && parts[0] === "auth" && parts[1] === "refresh") {
    const input = await body(req, 8 * 1024);
    const session = authenticate(req, db);
    if (!session) throw new RequestError(401, "Sign in required");
    requireCsrf(req, session);
    let pair;
    try {
      pair = refreshTokens(db, str(input.refresh_token) || str(input.refreshToken));
    } catch (error) {
      if (error instanceof OAuthError) throw new RequestError(error.status, error.message);
      throw error;
    }
    logAuthEvent(db, {
      userId: session.user.id,
      eventType: "auth.token.refreshed",
      clientType: "cli",
      credentialType: "token",
      ipAddress: requestIp(req),
      outcome: "success",
    });
    return {
      response: json({
        access_token: pair.accessToken,
        token_type: pair.tokenType,
        expires_in: pair.expiresIn,
        refresh_token: pair.refreshToken,
        scope: pair.scope,
      }),
      status: 200,
      owner: session.user.id,
    };
  }

  const auth = authenticate(req, db);
  if (!auth) throw new RequestError(401, "Sign in required");
  const user = auth.user;
  const owner = user.id;
  const operatorMetrics = user.role === "owner" && auth.via === "cookie" && auth.deviceId === null;
  requireCsrf(req, auth);
  if (method !== "GET" && method !== "HEAD" && !bearerMayWrite(auth, method, parts)) {
    throw new RequestError(403, "This credential may only read the account. Sign in to make changes.");
  }
  // Enforce the account role matrix. A viewer is read-only everywhere except
  // its own credentials, profile and notification preferences.
  const role = normalizeRole(user.role);
  if (method !== "GET" && method !== "HEAD" && role === "viewer" && !viewerMayMutate(parts)) {
    throw new RequestError(403, "Your role is read-only. Ask an account owner to grant write access.");
  }
  if (method !== "GET" && (parts[0] === "tokens" || parts[0] === "sessions" || parts[0] === "webhooks" || parts[0] === "devices"
    || (parts[0] === "auth" && parts[1] === "sessions") || parts[0] === "admin"
    || (parts[0] === "oauth" && parts[1] === "clients")
    || key === "POST device/approve" || (parts[0] === "device" && parts[1] === "pairing")
    || key === "POST protection" || key === "DELETE protection")) {
    requireRecentLogin(auth);
  }
  // Client scoped sessions, listed and revoked by the console and by
  // `mobilecloud sessions` / `mobilecloud revoke-session`.
  if (key === "GET auth/sessions") {
    return {
      response: json({ sessions: listAccountSessions(db, owner, auth.via === "cookie" ? auth.hash : null) }),
      status: 200,
      owner,
    };
  }
  if (method === "DELETE" && parts[0] === "auth" && parts[1] === "sessions" && parts[2]) {
    const target = db.prepare(
      "SELECT id, token_hash AS tokenHash FROM sessions WHERE user_id = ? AND (id = ? OR token_hash = ?)",
    ).get(owner, parts[2], parts[2]) as { id: string | null; tokenHash: string } | undefined;
    if (!target) {
      // A CLI or API credential has no session row; `sessions` lists it as a
      // token, and revoking it retires the token and its refresh chain.
      const token = db.prepare(
        "SELECT id, client_type AS clientType FROM access_tokens WHERE owner_id = ? AND id = ? AND expires_at > ?",
      ).get(owner, parts[2], Date.now()) as { id: string; clientType: string | null } | undefined;
      if (!token) throw new RequestError(404, "Session not found");
      const now = Date.now();
      tx(db, () => {
        db.prepare("UPDATE access_tokens SET expires_at = ? WHERE id = ?").run(now, token.id);
        db.prepare("UPDATE refresh_tokens SET revoked = 1 WHERE access_token_id = ?").run(token.id);
        publish(db, owner, "session.revoked", token.id, {
          sessionId: token.id,
          reason: "revoked_by_user",
          clientType: token.clientType ?? "cli",
        });
      });
      log(owner, "info", "auth", "revoked a client token");
      return { response: json({ ok: true }), status: 200, owner };
    }
    if (auth.via === "cookie" && target.tokenHash === auth.hash) {
      throw new RequestError(400, "That is the current browser session. Sign out instead.");
    }
    tx(db, () => {
      db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(target.tokenHash);
      publish(db, owner, "session.revoked", target.id ?? target.tokenHash, {
        sessionId: target.id ?? target.tokenHash,
        reason: "revoked_by_user",
      });
    });
    log(owner, "info", "auth", "revoked a client session");
    return { response: json({ ok: true }), status: 200, owner };
  }
  if (key === "GET auth/consents") {
    return {
      response: json({
        consents: listConsents(db, owner),
        clients: listClients(db).map(publicClient),
      }),
      status: 200,
      owner,
    };
  }
  if (method === "DELETE" && parts[0] === "auth" && parts[1] === "consents" && parts[2]) {
    const removed = revokeConsent(db, owner, parts[2]);
    if (!removed) throw new RequestError(404, "Consent not found");
    return { response: json({ ok: true }), status: 200, owner };
  }
  const blocked = inspectRequest(db, owner, req, parts.join("/"));
  if (blocked) {
    notify(db, owner, "firewall.denied", "Request blocked", blocked.error);
    return { response: json({ error: blocked.error }, blocked.status), status: blocked.status, owner };
  }

  // OAuth client management (the discovery document names /oauth/clients).
  // Registering a client is account-wide trust; only the owner may do it.
  if (parts[0] === "oauth" && parts[1] === "clients") {
    if (!hasPermission(role, "oauth.manage")) throw new RequestError(403, `Only an account ${roleFor("oauth.manage")} may manage OAuth clients.`);
    const clientId = parts[2] ?? "";
    try {
      if (method === "GET" && !clientId) {
        return { response: json({ clients: listClients(db).map(publicClient) }), status: 200, owner };
      }
      if (method === "POST" && !clientId) {
        const input = await body(req, 16 * 1024);
        const created = createClient(db, {
          clientId: str(input.client_id) || null,
          name: str(input.name),
          redirectUris: stringArray(input.redirect_uris),
          postLogoutRedirectUris: stringArray(input.post_logout_redirect_uris),
          scopes: Array.isArray(input.scopes) ? stringArray(input.scopes) : undefined,
          grantTypes: Array.isArray(input.grant_types) ? stringArray(input.grant_types) : undefined,
          public: input.public !== false,
          backchannelLogoutUri: str(input.backchannel_logout_uri) || null,
        });
        log(owner, "info", "auth", `registered OAuth client ${created.client.id}`);
        return {
          response: json({ client: publicClient(created.client), client_secret: created.secret }, 201),
          status: 201,
          owner,
        };
      }
      if (method === "GET" && clientId) {
        const client = findClient(db, clientId);
        if (!client) throw new RequestError(404, "Client not found");
        return { response: json({ client: publicClient(client) }), status: 200, owner };
      }
      if (method === "PATCH" && clientId) {
        const input = await body(req, 16 * 1024);
        const updated = updateClient(db, clientId, {
          name: str(input.name) || undefined,
          redirectUris: Array.isArray(input.redirect_uris) ? stringArray(input.redirect_uris) : undefined,
          postLogoutRedirectUris: Array.isArray(input.post_logout_redirect_uris) ? stringArray(input.post_logout_redirect_uris) : undefined,
          scopes: Array.isArray(input.scopes) ? stringArray(input.scopes) : undefined,
          backchannelLogoutUri:
            input.backchannel_logout_uri === undefined ? undefined : str(input.backchannel_logout_uri) || null,
        });
        log(owner, "info", "auth", `updated OAuth client ${clientId}`);
        return { response: json({ client: publicClient(updated) }), status: 200, owner };
      }
      if (method === "DELETE" && clientId) {
        if (!deleteClient(db, clientId)) throw new RequestError(404, "Client not found");
        log(owner, "warn", "auth", `deleted OAuth client ${clientId}`);
        return { response: json({ ok: true }), status: 200, owner };
      }
    } catch (error) {
      if (error instanceof OAuthError) throw new RequestError(error.status, error.message);
      throw error;
    }
    throw new RequestError(405, "That method is not supported for OAuth clients.");
  }

  // ---- SSO administration (owner only) ------------------------------------
  // Registering an application that can receive identity claims is an
  // account-wide trust decision, so it is limited to the owner role.
  if (parts[0] === "admin") {
    if (!hasPermission(role, "sso.manage")) throw new RequestError(403, `Only an account ${roleFor("sso.manage")} may manage SSO.`);
    const resource = parts[1] ?? "";
    const id = parts[2] ?? "";
    if (resource === "signing-keys") {
      if (method === "GET" && !id) {
        const keys = db.prepare("SELECT kid, alg, active, created_at AS createdAt FROM signing_keys WHERE alg = 'RS256' ORDER BY created_at DESC").all();
        return { response: json({ keys }), status: 200, owner };
      }
      if (method === "POST" && id === "rotate") {
        try {
          const rotated = rotateSigningKey(db);
          log(owner, "warn", "auth", `rotated the OIDC signing key to ${rotated.kid}`);
          return { response: json({ ok: true, ...rotated }), status: 200, owner };
        } catch (error) {
          throw new RequestError(409, error instanceof Error ? error.message : "The signing key could not be rotated.");
        }
      }
    }
    if (resource === "sso" && method === "GET") {
      return {
        response: json({
          issuer: originOf(req),
          clients: listClients(db).map(publicClient),
          serviceProviders: listServiceProviders(db),
          signingKey: ensureSigningKey(db).kid,
        }),
        status: 200,
        owner,
      };
    }
    if (resource === "oidc-clients") {
      if (method === "GET" && !id) {
        return { response: json({ clients: listClients(db).map(publicClient) }), status: 200, owner };
      }
      if (method === "POST" && !id) {
        const input = await body(req, 16 * 1024);
        try {
          const created = createClient(db, {
            clientId: str(input.client_id) || null,
            name: str(input.name),
            redirectUris: stringArray(input.redirect_uris),
            postLogoutRedirectUris: stringArray(input.post_logout_redirect_uris),
            scopes: Array.isArray(input.scopes) ? stringArray(input.scopes) : undefined,
            grantTypes: Array.isArray(input.grant_types) ? stringArray(input.grant_types) : undefined,
            public: input.public !== false,
            backchannelLogoutUri: str(input.backchannel_logout_uri) || null,
          });
          log(owner, "info", "auth", `registered OIDC client ${created.client.id}`);
          return {
            response: json({ client: publicClient(created.client), client_secret: created.secret }, 201),
            status: 201,
            owner,
          };
        } catch (error) {
          if (error instanceof OAuthError) throw new RequestError(error.status, error.message);
          throw error;
        }
      }
      if (method === "DELETE" && id) {
        if (!deleteClient(db, id)) throw new RequestError(404, "Client not found");
        log(owner, "warn", "auth", `deleted OIDC client ${id}`);
        return { response: json({ ok: true }), status: 200, owner };
      }
    }
    if (resource === "saml-sps") {
      if (method === "GET" && !id) {
        return { response: json({ service_providers: listServiceProviders(db) }), status: 200, owner };
      }
      if (method === "POST" && !id) {
        const input = await body(req, 64 * 1024);
        try {
          const provider = createServiceProvider(db, {
            entityId: str(input.entity_id) || str(input.entityId),
            acsUrl: str(input.acs_url) || str(input.acsUrl),
            sloUrl: str(input.slo_url) || str(input.sloUrl) || null,
            certificatePem: str(input.certificate_pem) || str(input.certificatePem) || null,
            nameIdFormat: str(input.name_id_format) || str(input.nameIdFormat) || null,
          });
          log(owner, "info", "auth", `registered SAML SP ${provider.entityId}`);
          return { response: json({ service_provider: provider }, 201), status: 201, owner };
        } catch (error) {
          throw new RequestError(400, error instanceof Error ? error.message : "That service provider was rejected.");
        }
      }
      if (method === "DELETE" && id) {
        if (!deleteServiceProvider(db, id)) throw new RequestError(404, "Service provider not found");
        return { response: json({ ok: true }), status: 200, owner };
      }
    }
    if (resource === "scim-tokens") {
      if (method === "GET" && !id) {
        return { response: json({ tokens: listScimTokens(db, owner) }), status: 200, owner };
      }
      if (method === "POST" && !id) {
        const input = await body(req, 8 * 1024);
        const created = createScimToken(db, owner, str(input.name) || "SCIM provisioning");
        log(owner, "info", "auth", "issued a SCIM token");
        return { response: json(created, 201), status: 201, owner };
      }
      if (method === "DELETE" && id) {
        if (!revokeScimToken(db, owner, id)) throw new RequestError(404, "Token not found");
        return { response: json({ ok: true }), status: 200, owner };
      }
    }
    throw new RequestError(404, "Unknown SSO administration endpoint");
  }

  // Authorized catch-up feed. A client that was offline (or whose socket
  // dropped) replays from its last cursor and receives every change it missed,
  // scoped to its own account. Returns the new cursor to persist.
  if (key === "GET sync/changes") {
    const params = new URL(req.url).searchParams;
    const rawCursor = Number(params.get("cursor") ?? 0);
    const cursor = Number.isSafeInteger(rawCursor) && rawCursor > 0 ? rawCursor : 0;
    const rawLimit = Number(params.get("limit") ?? 500);
    const limit = Number.isSafeInteger(rawLimit) && rawLimit > 0 ? Math.min(1000, rawLimit) : 500;
    const page = snapshot(db, () => changesSince(db, owner, cursor, limit));
    return { response: json({ ...page, account_id: owner }), status: 200, owner };
  }

  if (key === "GET overview") {
    const result = snapshot(db, () => ({
      cursor: latestSeq(db, owner),
      user: db.prepare("SELECT id, email, name, role, plan FROM users WHERE id = ?").get(owner) ?? user,
      projects: listProjects(owner),
      deployments: listDeployments(owner),
      domains: listDomains(owner),
      databases: listDatabases(owner),
      functions: listFunctions(owner),
      objects: listObjects(owner),
      logs: listLogs(owner),
      team: listTeam(owner),
      settings: listSettings(owner),
      metrics: collectMetrics(db, owner, operatorMetrics),
      host: collectHost(operatorMetrics),
      billing: billing(user),
      usage: collectUsage(db, owner, user.plan),
      firewall: { rules: listRules(db, owner), events: listFirewallEvents(db, owner), traffic: trafficSummary(db, owner) },
      observability: collectObservability(db, owner),
      vitals: summarizeVitals(db, owner),
      builds: listAccountBuilds(db, owner),
      workflows: listWorkflows(db, owner),
      drives: listDrives(db, owner),
      capabilities: capabilities(),
      notifications: listNotifications(db, owner),
      sessions: listSessions(db, owner, auth.via === "cookie" ? auth.hash : null),
      tokens: listTokens(db, owner),
      webhooks: listWebhooks(db, owner),
      webhookDeliveries: listDeliveries(db, owner, 25),
      por: porState(db, owner),
      protection: protectionStatus(db, owner, readGate(req)),
      identity: identityProviders(),
    }));
    return { response: json(result), status: 200, owner };
  }

  if (key === "GET health/subsystems") {
    // The global health banner. Each entry is a check this process really
    // performed; a subsystem that is not deployed is reported as
    // `unconfigured`, never as a failure.
    const report = await collectSubsystems(db, {
      realtimeUrl: process.env.MOBILECLOUD_REALTIME_URL ?? `http://127.0.0.1:${realtimePort()}`,
      engineUrl: process.env.MOBILECLOUD_ENGINE ?? null,
      dnsApiUrl: process.env.MOBILECLOUD_DNS_API ?? null,
    });
    return { response: json(report), status: 200, owner };
  }
  if (key === "GET metrics") return { response: json(collectMetrics(db, owner, operatorMetrics)), status: 200, owner };
  if (key === "GET host") return { response: json(collectHost(operatorMetrics)), status: 200, owner };
  if (key === "GET usage") return { response: json(collectUsage(db, owner, user.plan)), status: 200, owner };
  if (key === "GET por") return { response: json(porState(db, owner)), status: 200, owner };
  if (key === "POST por") {
    // Ingestion for the (external) attestor: it publishes the por-kernel output
    // verbatim. The control plane never computes a reserve ratio itself.
    const validated = validateAttestation(await body(req));
    if (!validated.ok) return { response: json({ error: validated.error }, 400), status: 400, owner };
    const attestation = tx(db, () => {
      const row = insertAttestation(db, owner, validated.value);
      publish(db, owner, "por.attested", row.id, { status: row.status, reserveRatioBps: row.reserveRatioBps });
      return row;
    });
    return { response: json({ ok: true, attestation }, 201), status: 201, owner };
  }
  if (key === "GET webhook-deliveries") {
    return { response: json({ deliveries: listDeliveries(db, owner, 100) }), status: 200, owner };
  }
  if (parts[0] === "analytics" && method === "GET") {
    const range = (new URL(req.url).searchParams.get("range") ?? "24h") as RangeKey;
    if (!["1h", "24h", "7d", "30d"].includes(range)) return { response: json({ error: "Unknown range" }, 400), status: 400, owner };
    return { response: json(collectAnalytics(db, owner, range)), status: 200, owner };
  }
  if (key === "GET search") {
    const q = `%${(new URL(req.url).searchParams.get("q") ?? "").trim().toLowerCase()}%`;
    const projects = db.prepare("SELECT id, name FROM projects WHERE owner_id = ? AND name LIKE ? LIMIT 8").all(owner, q);
    return { response: json({ projects }), status: 200, owner };
  }
  if (key === "POST events") {
    const input = await body(req);
    if (listSettings(owner).recordPageViews === false) return { response: json({ skipped: true }), status: 200, owner };
    const page = str(input.path).slice(0, 120) || "/";
    log(owner, "info", "nav", `opened ${page}`);
    return { response: json({ ok: true }), status: 200, owner };
  }

  if (key === "POST projects") {
    const input = await body(req);
    const name = safeSlug(str(input.name), "Project name");
    const framework = str(input.framework) || "Next.js";
    if (!["Next.js", "Vite", "Astro", "Nuxt", "Remix", "React"].includes(framework)) {
      return { response: json({ error: "Unknown framework" }, 400), status: 400, owner };
    }
    const repoUrl = str(input.repoUrl);
    if (repoUrl && !isGitUrl(repoUrl)) {
      return { response: json({ error: "Enter an HTTPS repository URL without embedded credentials, query, or fragment" }, 400), status: 400, owner };
    }
    const id = newId();
    tx(db, () => {
      db.prepare(
        "INSERT INTO projects (id, owner_id, name, framework, target, repo_url, created_at) VALUES (?, ?, ?, ?, 'production', ?, ?)",
      ).run(id, owner, name, framework, repoUrl || null, Date.now());
      publish(db, owner, "project.created", id, { id, name, framework, target: "production", repoUrl: repoUrl || null });
    });
    log(owner, "info", "projects", `created ${name}`);
    return { response: json({ ok: true, id, repoUrl: repoUrl || null }), status: 201, owner };
  }
  if (method === "PATCH" && parts[0] === "projects" && parts.length === 2) {
    const input = await body(req);
    if (input.repoUrl !== null && typeof input.repoUrl !== "string") throw new RequestError(400, "Provide a repository URL or null");
    const repoUrl = str(input.repoUrl) || null;
    if (repoUrl && !isGitUrl(repoUrl)) throw new RequestError(400, "Enter an HTTPS repository URL without embedded credentials, query, or fragment");
    tx(db, () => {
      const changed = db.prepare("UPDATE projects SET repo_url = ? WHERE owner_id = ? AND id = ?").run(repoUrl, owner, parts[1]);
      if (!changed.changes) throw new RequestError(404, "Project not found");
      publish(db, owner, "project.updated", parts[1], { id: parts[1], repoUrl });
    });
    return { response: json({ ok: true, id: parts[1], repoUrl }), status: 200, owner };
  }
  if (method === "DELETE" && parts[0] === "projects" && parts[1]) {
    const existing = db.prepare("SELECT name FROM projects WHERE owner_id = ? AND id = ?").get(owner, parts[1]) as
      | { name: string }
      | undefined;
    if (!existing) return { response: json({ error: "Project not found" }, 404), status: 404, owner };
    tx(db, () => {
      db.prepare("DELETE FROM deployments WHERE owner_id = ? AND project_id = ?").run(owner, parts[1]);
      db.prepare("DELETE FROM domains WHERE owner_id = ? AND project_id = ?").run(owner, parts[1]);
      db.prepare("DELETE FROM projects WHERE owner_id = ? AND id = ?").run(owner, parts[1]);
      publish(db, owner, "project.deleted", parts[1], { id: parts[1], name: existing.name });
    });
    log(owner, "warn", "projects", `deleted ${parts[1]}`);
    return { response: json({ ok: true }), status: 200, owner };
  }

  if (key === "POST deployments") {
    const input = await body(req);
    const project = db.prepare("SELECT id, name, repo_url AS repoUrl FROM projects WHERE owner_id = ? AND id = ?")
      .get(owner, str(input.projectId)) as { id: string; name: string; repoUrl: string | null } | undefined;
    if (!project) return { response: json({ error: "Project not found" }, 404), status: 404, owner };

    const override = str(input.repoUrl);
    if (override && !isGitUrl(override)) {
      return { response: json({ error: "Enter an HTTPS repository URL without embedded credentials, query, or fragment" }, 400), status: 400, owner };
    }
    if (override && override !== project.repoUrl) {
      tx(db, () => {
        db.prepare("UPDATE projects SET repo_url = ? WHERE owner_id = ? AND id = ?").run(override, owner, project.id);
        publish(db, owner, "project.updated", project.id, { id: project.id, name: project.name, repoUrl: override });
      });
    }
    const repoUrl = override || project.repoUrl || "";

    if (!repoUrl) {
      recordDeployment(db, owner, project, "blocked", NO_REPO_NOTE);
      log(owner, "warn", "builder", `${project.name}: ${NO_REPO_NOTE}`);
      notify(db, owner, "deployment.blocked", "Deployment not built", `${project.name}: ${NO_REPO_NOTE}`);
      return { response: json({ ok: true, status: "blocked", note: NO_REPO_NOTE }), status: 403, owner };
    }

    const builder = builderConfig();
    if (!builder.enabled) {
      recordDeployment(db, owner, project, "blocked", BUILDER_DISABLED);
      log(owner, "warn", "builder", `${project.name}: ${BUILDER_DISABLED}`);
      return { response: json({ ok: true, status: "blocked", note: BUILDER_DISABLED }), status: 403, owner };
    }
    // The engine is the authority: it re-validates the project, clone URL and
    // ref, and refuses anything it was not configured for.
    const dispatched = await dispatchDeploy(builder, { project: project.name, cloneUrl: repoUrl, branch: str(input.branch) || "main", commit: str(input.commit) || undefined });
    if (!dispatched.ok) {
      recordDeployment(db, owner, project, "failed", dispatched.note);
      log(owner, "error", "builder", `${project.name}: ${dispatched.note}`);
      notify(db, owner, "deployment.failed", "Deployment dispatch failed", `${project.name}: ${dispatched.note}`);
      return { response: json({ ok: false, status: "failed", note: dispatched.note }), status: 502, owner };
    }
    const deployId = recordDeployment(db, owner, project, "queued", dispatched.note);
    log(owner, "info", "builder", `${project.name}: ${dispatched.note}`);
    notify(db, owner, "deployment.queued", "Deployment queued", `${project.name}: ${dispatched.note}`);
    return { response: json({ ok: true, status: "queued", deploymentId: deployId, note: dispatched.note }), status: 202, owner };
  }

  if (method === "POST" && parts[0] === "deployments" && parts[2] === "rollback") {
    const input = await body(req);
    const deployId = str(input.deployId);
    const project = db.prepare("SELECT id, name FROM projects WHERE owner_id = ? AND id = ?")
      .get(owner, str(input.projectId)) as { id: string; name: string } | undefined;
    const builder = builderConfig();
    if (!builder.enabled) return { response: json({ ok: false, status: "blocked", note: BUILDER_DISABLED }), status: 503, owner };
    if (!project || !deployId) return { response: json({ error: "A project and a deployment id are required" }, 400), status: 400, owner };
    const rolled = await dispatchRollback(builder, project.name, deployId);
    if (!rolled.ok) {
      log(owner, "error", "builder", `${project.name}: rollback failed: ${rolled.note}`);
      return { response: json({ ok: false, status: "failed", note: rolled.note }), status: 502, owner };
    }
    recordDeployment(db, owner, project, "rolled_back", rolled.note);
    log(owner, "warn", "builder", `${project.name}: rolled back to ${deployId}`);
    notify(db, owner, "deployment.rolled_back", "Deployment rolled back", `${project.name}: ${deployId}`);
    return { response: json({ ok: true, status: "rolled_back", note: rolled.note }), status: 200, owner };
  }

  if (key === "GET builder") {
    const builder = builderConfig();
    const reachable = builder.enabled ? await probeBuilder(builder) : false;
    return {
      response: json({
        enabled: builder.enabled,
        baseUrl: builder.url,
        reachable,
        detail: builder.enabled
          ? reachable ? "The engine is reachable." : "The engine is configured but did not answer its health probe."
          : BUILDER_DISABLED,
      }),
      status: 200,
      owner,
    };
  }
  if (method === "GET" && parts[0] === "builder" && parts[1] === "deployments" && parts[2]) {
    const builder = builderConfig();
    if (!builder.enabled) throw new RequestError(503, BUILDER_DISABLED);
    const project = db.prepare("SELECT name FROM projects WHERE owner_id = ? AND id = ?").get(owner, parts[2]) as { name: string } | undefined;
    if (!project) return { response: json({ error: "Project not found" }, 404), status: 404, owner };
    try {
      const upstream = await fetch(`${builder.url}/api/v1/deployments/${encodeURIComponent(project.name)}`, {
        headers: { authorization: `Bearer ${builder.token}` },
        signal: AbortSignal.timeout(10_000),
      });
      return { response: new Response(await upstream.text(), { status: upstream.status, headers: { "content-type": "application/json" } }), status: upstream.status, owner };
    } catch (error) {
      throw new RequestError(503, `Engine unreachable: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }

  // ---- Domain configuration lifecycle -------------------------------------
  //
  // Adding a domain only stores intent plus the DNS instructions the operator
  // must follow; nothing here claims DNS, SSL or health has succeeded. Those
  // three signals are updated solely by verification (and, in Phase 2, the
  // Cloudflare integration), and the lifecycle status is always *derived* from
  // them, never written as a fixed string.

  if (key === "POST domains/detect-provider") {
    const input = await body(req, 8 * 1024);
    const check = validateHostname(str(input.domain));
    if (!check.ok) return { response: json({ error: check.error }, 400), status: 400, owner };
    const detection = await detectDnsProvider(check.host);
    return {
      response: json({
        detected: detection.detected,
        domain: check.host,
        provider: detection.provider
          ? { id: detection.provider.id, name: detection.provider.name, logo: detection.provider.logo, autoConfig: detection.provider.autoConfig, zoneConnected: false, zoneId: null }
          : null,
        nameservers: detection.nameservers,
        existingRecords: [],
        error: detection.error,
        note: detection.provider?.autoConfig
          ? "Automatic record configuration is not enabled in this build. Add the records shown, then verify."
          : "Add the DNS records shown for this domain, then run verification.",
      }),
      status: 200,
      owner,
    };
  }

  if (key === "GET domains") {
    return { response: json({ domains: listDomains(owner) }), status: 200, owner };
  }

  if (key === "POST domains") {
    const input = await body(req);
    const existing = (db.prepare("SELECT host FROM domains WHERE owner_id = ?").all(owner) as { host: string }[]).map((row) => row.host);
    const check = validateHostname(str(input.host), existing);
    if (!check.ok) return { response: json({ error: check.error }, 400), status: 400, owner };
    const project = db.prepare("SELECT id FROM projects WHERE owner_id = ? AND name = ?").get(owner, str(input.project)) as { id: string } | undefined;
    if (!project) return { response: json({ error: "Project not found" }, 404), status: 404, owner };

    const requestedMethod = str(input.verificationMethod);
    const verificationMethod: VerificationMethod = (["cname", "txt", "http", "auto"] as const).includes(requestedMethod as VerificationMethod)
      ? (requestedMethod as VerificationMethod)
      : "cname";

    const detection = await detectDnsProvider(check.host);
    const tunnelTarget = domainTunnelTarget();
    const verificationToken = `mc-verify=${randomBytes(9).toString("hex")}`;
    const detail = tunnelTarget
      ? `Add a CNAME for ${check.host} pointing at ${tunnelTarget}, then verify.`
      : "Saved. This deployment has not published a tunnel target, so the CNAME value is not known yet.";
    const id = newId();
    const now = Date.now();
    tx(db, () => {
      db.prepare(
        `INSERT INTO domains (id, owner_id, project_id, host, status, detail, created_at, dns_provider, dns_status, ssl_status, health_status, tunnel_target, verification_token, verification_method, updated_at)
         VALUES (?, ?, ?, ?, 'pending_dns', ?, ?, ?, 'pending', 'none', 'unknown', ?, ?, ?, ?)`,
      ).run(id, owner, project.id, check.host, detail, now, detection.provider?.id ?? null, tunnelTarget, verificationToken, verificationMethod, now);
      publish(db, owner, "domain.created", id, { domainId: id, host: check.host, project: str(input.project) });
    });
    log(owner, "info", "domains", `added ${check.host}`);
    const created = readDomain(db, owner, id);
    return { response: json({ ok: true, domain: created ? rowToDomain(created) : null }), status: 201, owner };
  }

  if (method === "GET" && parts[0] === "domains" && parts[1] && parts.length === 2) {
    const row = readDomain(db, owner, parts[1]);
    if (!row) return { response: json({ error: "Domain not found" }, 404), status: 404, owner };
    return { response: json({ domain: rowToDomain(row) }), status: 200, owner };
  }

  if (method === "GET" && parts[0] === "domains" && parts[1] && parts[2] === "certificate") {
    const row = readDomain(db, owner, parts[1]);
    if (!row) return { response: json({ error: "Domain not found" }, 404), status: 404, owner };
    const domain = rowToDomain(row);
    return {
      response: json({
        host: domain.host,
        sslStatus: domain.sslStatus,
        sslExpiresAt: domain.sslExpiresAt,
        sslIssuer: domain.sslIssuer,
        tunnelTarget: domain.tunnelTarget,
        note: domain.sslStatus === "none" ? "No certificate has been issued for this host yet." : null,
      }),
      status: 200,
      owner,
    };
  }

  if (method === "GET" && parts[0] === "domains" && parts[1] && parts[2] === "propagation") {
    const row = readDomain(db, owner, parts[1]);
    if (!row) return { response: json({ error: "Domain not found" }, 404), status: 404, owner };
    return { response: json({ propagation: parseDomainJson<DomainPropagation>(row.propagation) }), status: 200, owner };
  }

  if (method === "PUT" && parts[0] === "domains" && parts[1] && parts.length === 2) {
    const row = readDomain(db, owner, parts[1]);
    if (!row) return { response: json({ error: "Domain not found" }, 404), status: 404, owner };
    const input = await body(req);
    const projectName = str(input.project);
    let projectId: string | null = null;
    if (projectName) {
      const project = db.prepare("SELECT id FROM projects WHERE owner_id = ? AND name = ?").get(owner, projectName) as { id: string } | undefined;
      if (!project) return { response: json({ error: "Project not found" }, 404), status: 404, owner };
      projectId = project.id;
    }
    const requestedMethod = str(input.verificationMethod);
    const verificationMethod = (["cname", "txt", "http", "auto"] as const).includes(requestedMethod as VerificationMethod)
      ? requestedMethod
      : null;
    if (!projectId && !verificationMethod) return { response: json({ error: "Nothing to update" }, 400), status: 400, owner };
    const now = Date.now();
    tx(db, () => {
      if (projectId) db.prepare("UPDATE domains SET project_id = ?, updated_at = ? WHERE owner_id = ? AND id = ?").run(projectId, now, owner, row.id);
      if (verificationMethod) db.prepare("UPDATE domains SET verification_method = ?, updated_at = ? WHERE owner_id = ? AND id = ?").run(verificationMethod, now, owner, row.id);
    });
    const updated = readDomain(db, owner, row.id);
    return { response: json({ ok: true, domain: updated ? rowToDomain(updated) : null }), status: 200, owner };
  }

  if (method === "POST" && parts[0] === "domains" && parts[1] && parts[2] === "verify") {
    const row = readDomain(db, owner, parts[1]);
    if (!row) return { response: json({ error: "Domain not found" }, 404), status: 404, owner };
    const domain = rowToDomain(row);

    let dnsStatus: DnsSignal;
    let detail: string;
    let lastError: DomainLastError | null = null;

    const useTxt = domain.verificationMethod === "txt" || (domain.verificationMethod === "auto" && !domain.tunnelTarget);
    if (useTxt) {
      if (!domain.verificationToken) {
        dnsStatus = "pending";
        detail = "This domain has no verification token yet.";
      } else {
        const check = await checkTxtToken(domain.host, domain.verificationToken);
        dnsStatus = check.status;
        detail = dnsStatus === "verified"
          ? "Ownership token found. DNS is verified."
          : dnsStatus === "misconfigured"
            ? `A TXT record exists but does not carry the expected token (found ${check.found.length}).`
            : "No ownership TXT record was found yet.";
        if (dnsStatus === "misconfigured") lastError = { code: "CNAME_WRONG_TARGET", message: detail, at: Date.now() };
      }
    } else {
      const check = await checkCname(domain.host, domain.tunnelTarget);
      dnsStatus = check.status;
      if (dnsStatus === "verified") {
        detail = "CNAME points at the tunnel. DNS is verified.";
      } else if (dnsStatus === "misconfigured") {
        if (check.conflict) {
          detail = `An ${check.conflict} record exists for this hostname. Remove it before adding a CNAME.`;
          lastError = { code: "A_RECORD_CONFLICT", message: detail, at: Date.now() };
        } else {
          detail = `CNAME points to ${check.found ?? "an unknown target"}, expected ${check.expected ?? "the tunnel target"}.`;
          lastError = { code: "CNAME_WRONG_TARGET", message: detail, at: Date.now() };
        }
      } else if (dnsStatus === "missing") {
        detail = check.expected ? `No CNAME record found. Add a CNAME pointing at ${check.expected}.` : "No CNAME record found yet.";
        lastError = check.expected ? { code: "CNAME_MISSING", message: detail, at: Date.now() } : null;
      } else {
        detail = "DNS lookup is still pending; no record was visible yet.";
      }
    }

    const now = Date.now();
    const verifiedAt = dnsStatus === "verified" ? now : row.dns_verified_at;
    const healthStatus = (row.health_status || "unknown") as HealthSignal;
    const sslStatus = (row.ssl_status || "none") as SslSignal;
    const status = deriveStatus({ dnsStatus, sslStatus, healthStatus, sslExpiresAt: row.ssl_expires_at, now, suspended: row.status === "suspended", deleting: false });
    const propagation: DomainPropagation = { regions: [{ name: "public-resolver", resolved: dnsStatus === "verified" }], lastCheckedAt: now };
    tx(db, () => {
      db.prepare(
        "UPDATE domains SET dns_status = ?, detail = ?, status = ?, dns_verified_at = ?, propagation = ?, last_error = ?, updated_at = ? WHERE owner_id = ? AND id = ?",
      ).run(dnsStatus, detail, status, verifiedAt, JSON.stringify(propagation), lastError ? JSON.stringify(lastError) : null, now, owner, row.id);
      if (dnsStatus === "verified") publish(db, owner, "domain.dns_verified", row.id, { domainId: row.id, verifiedAt: now });
      else if (dnsStatus === "misconfigured") publish(db, owner, "domain.dns_failed", row.id, { domainId: row.id, error: detail });
      else publish(db, owner, "domain.dns_pending", row.id, { domainId: row.id });
    });
    const updated = readDomain(db, owner, row.id);
    return { response: json({ ok: true, domain: updated ? rowToDomain(updated) : null }), status: 200, owner };
  }

  if (method === "DELETE" && parts[0] === "domains" && parts[1]) {
    const existing = db.prepare("SELECT host FROM domains WHERE owner_id = ? AND id = ?").get(owner, parts[1]) as
      | { host: string }
      | undefined;
    if (!existing) return { response: json({ error: "Domain not found" }, 404), status: 404, owner };
    tx(db, () => {
      db.prepare("DELETE FROM domains WHERE owner_id = ? AND id = ?").run(owner, parts[1]);
      publish(db, owner, "domain.deleted", parts[1], { domainId: parts[1] });
    });
    log(owner, "info", "domains", `removed ${existing.host}`);
    return { response: json({ ok: true }), status: 200, owner };
  }

  if (key === "POST databases") {
    const name = safeSlug(str((await body(req)).name), "Database name");
    const dir = join(dataRoot(), "databases", owner);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${name}.sqlite`);
    writeFileSync(file, "", { flag: "wx" });
    const id = newId();
    tx(db, () => {
      db.prepare("INSERT INTO db_files (id, owner_id, name, path, created_at) VALUES (?, ?, ?, ?, ?)").run(id, owner, name, file, Date.now());
      publish(db, owner, "configuration.updated", id, { resource: "database", id, name });
    });
    log(owner, "info", "databases", `created ${name}.sqlite`);
    return { response: json({ ok: true, bytes: statSync(file).size }), status: 201, owner };
  }

  if (key === "POST functions") {
    if (!runtimeEnabled()) throw new RequestError(503, RUNTIME_DISABLED);
    const input = await body(req);
    const name = safeSlug(str(input.name), "Function name");
    const routePath = str(input.route);
    if (!routePath.startsWith("/")) return { response: json({ error: "Route must start with /" }, 400), status: 400, owner };
    const source = validateSource(input.source);
    const id = newId();
    tx(db, () => {
      db.prepare(
        "INSERT INTO functions (id, owner_id, name, route, source, invocations, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)",
      ).run(id, owner, name, routePath, source, Date.now());
      publish(db, owner, "configuration.updated", id, { resource: "function", id, name, route: routePath });
    });
    log(owner, "info", "functions", `registered ${name} with ${Buffer.byteLength(source, "utf8")} bytes of handler source`);
    return { response: json({ ok: true, hasSource: true }), status: 201, owner };
  }
  if (method === "POST" && parts[0] === "functions" && parts[2] === "invoke") {
    if (!runtimeEnabled()) throw new RequestError(503, RUNTIME_DISABLED);
    const row = db.prepare("SELECT id, name, route, source FROM functions WHERE owner_id = ? AND id = ?")
      .get(owner, parts[1]) as { id: string; name: string; route: string; source: string | null } | undefined;
    if (!row) return { response: json({ error: "Function not found" }, 404), status: 404, owner };
    if (!row.source) {
      log(owner, "error", "functions", `${row.name} was not invoked: no handler source is stored`);
      return { response: json({ error: "No handler source is stored for this function, so it was not executed." }, 409), status: 409, owner };
    }
    const cap = quotaBreach(db, owner, "function_invocations");
    if (cap) {
      log(owner, "warn", "functions", `${row.name} was blocked by the invocation spend cap (${cap.used}/${cap.limit})`);
      throw new RequestError(429, quotaMessage(cap));
    }
    const input = await body(req);
    const url = new URL(req.url);
    const result = executeFunction(row.source, {
      method: "POST",
      path: row.route,
      query: Object.fromEntries(url.searchParams),
      headers: { "content-type": "application/json" },
      body: input,
    });
    tx(db, () => {
      db.prepare("UPDATE functions SET invocations = invocations + 1 WHERE owner_id = ? AND id = ?").run(owner, row.id);
      recordUsage(db, owner, "function_invocations", 1, row.id);
      publish(db, owner, "configuration.updated", row.id, { resource: "function_invocation", id: row.id, name: row.name, status: result.status, durationMs: result.durationMs });
    });
    log(owner, "info", "functions", `${row.name} returned ${result.status} in ${result.durationMs} ms`);
    return { response: json(result, result.status), status: result.status, owner };
  }

  if (key === "POST storage") {
    const input = await body(req, 1_350_000);
    const bucket = safeSlug(str(input.bucket), "Bucket");
    const keyName = str(input.key);
    if (keyName.length > 240 || !keyName.split("/").every((part) => /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,79}$/.test(part))) {
      throw new RequestError(400, "Object key is invalid");
    }
    const content = str(input.contentBase64);
    if (!content || content.length > 1_333_336) throw new RequestError(400, "Provide base64 content up to 1 MB");
    const bytes = Buffer.from(content, "base64");
    if (bytes.length > 1_000_000 || bytes.toString("base64") !== content) throw new RequestError(400, "Provide base64 content up to 1 MB");
    const id = newId();
    const dir = join(dataRoot(), "objects", owner, "opaque");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${id}.blob`);
    const temporary = join(dir, `${id}.tmp`);
    let staged = false;
    let promoted = false;
    try {
      tx(db, () => {
        if (db.prepare("SELECT 1 FROM objects WHERE owner_id = ? AND bucket = ? AND key = ? LIMIT 1").get(owner, bucket, keyName)) {
          throw new RequestError(409, "An object with this key already exists");
        }
        const usage = db.prepare("SELECT COALESCE(SUM(bytes), 0) AS bytes FROM objects WHERE owner_id = ?").get(owner) as { bytes: number };
        if (usage.bytes + bytes.length > 100_000_000) throw new RequestError(413, "Account object storage limit reached");
        writeFileSync(temporary, bytes, { flag: "wx" });
        staged = true;
        renameSync(temporary, file);
        promoted = true;
        db.prepare("INSERT INTO objects (id, owner_id, bucket, key, path, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run(id, owner, bucket, keyName, file, bytes.length, Date.now());
        publish(db, owner, "configuration.updated", id, { resource: "object", id, bucket, key: keyName, bytes: bytes.length });
      });
    } catch (error) {
      if (staged) try { rmSync(promoted ? file : temporary, { force: true }); } catch { /* Leave orphan for maintenance. */ }
      throw error;
    }
    log(owner, "info", "storage", `wrote ${bucket}/${keyName} (${bytes.length} bytes)`);
    return { response: json({ ok: true, bytes: bytes.length }), status: 201, owner };
  }

  if (key === "POST team") {
    if (!hasPermission(role, "team.manage")) throw new RequestError(403, `Only an account ${roleFor("team.manage")} may manage the team.`);
    const input = await body(req);
    const email = str(input.email).toLowerCase();
    const name = str(input.name);
    if (!email.includes("@") || !name) return { response: json({ error: "Name and email are required" }, 400), status: 400, owner };
    const requested = input.role === undefined ? "member" : str(input.role).toLowerCase();
    if (!(ROLES as readonly string[]).includes(requested)) {
      return { response: json({ error: "role must be one of owner, member, viewer" }, 400), status: 400, owner };
    }
    if (requested === "owner") return { response: json({ error: "An invite cannot grant the owner role. Promote the member after they join." }, 400), status: 400, owner };
    const id = newId();
    tx(db, () => {
      db.prepare(
        "INSERT INTO invites (id, owner_id, email, name, role, email_sent, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)",
      ).run(id, owner, email, name, requested, Date.now());
      publish(db, owner, "configuration.updated", id, { resource: "invite", id, email, name, role: requested });
    });
    log(owner, "info", "team", `saved invite for ${email} as ${requested}. SMTP is not configured, so no email was sent.`);
    return { response: json({ ok: true, emailSent: false, role: requested }), status: 201, owner };
  }

  // Role changes for an existing user or a pending invite. The last active
  // owner cannot be demoted, so an account can never lock itself out.
  if (method === "PATCH" && parts[0] === "team" && parts[1]) {
    if (!hasPermission(role, "team.manage")) throw new RequestError(403, `Only an account ${roleFor("team.manage")} may manage the team.`);
    const input = await body(req);
    const requested = str(input.role).toLowerCase();
    if (!(ROLES as readonly string[]).includes(requested)) {
      return { response: json({ error: "role must be one of owner, member, viewer" }, 400), status: 400, owner };
    }
    const target = parts[1];
    const member = db.prepare("SELECT id, name, email, role FROM users WHERE id = ?")
      .get(target) as { id: string; name: string; email: string; role: string } | undefined;
    if (member) {
      if (member.role === "owner" && requested !== "owner") {
        const owners = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'owner' AND active = 1").get() as { n: number };
        if (owners.n <= 1) return { response: json({ error: "The account must keep at least one owner." }, 400), status: 400, owner };
      }
      tx(db, () => {
        db.prepare("UPDATE users SET role = ? WHERE id = ?").run(requested, member.id);
        publish(db, owner, "configuration.updated", member.id, { resource: "member", id: member.id, role: requested });
      });
      log(owner, "warn", "team", `set ${member.email} to ${requested}`);
      return { response: json({ ok: true, role: requested }), status: 200, owner };
    }
    const invite = db.prepare("SELECT id, email FROM invites WHERE owner_id = ? AND id = ?")
      .get(owner, target) as { id: string; email: string } | undefined;
    if (!invite) return { response: json({ error: "Team member not found" }, 404), status: 404, owner };
    if (requested === "owner") return { response: json({ error: "An invite cannot grant the owner role." }, 400), status: 400, owner };
    tx(db, () => {
      db.prepare("UPDATE invites SET role = ? WHERE owner_id = ? AND id = ?").run(requested, owner, invite.id);
      publish(db, owner, "configuration.updated", invite.id, { resource: "invite", id: invite.id, role: requested });
    });
    log(owner, "info", "team", `set invite ${invite.email} to ${requested}`);
    return { response: json({ ok: true, role: requested }), status: 200, owner };
  }

  if (method === "DELETE" && parts[0] === "team" && parts[1]) {
    if (!hasPermission(role, "team.manage")) throw new RequestError(403, `Only an account ${roleFor("team.manage")} may manage the team.`);
    const target = parts[1];
    if (target === owner) return { response: json({ error: "You cannot remove your own account." }, 400), status: 400, owner };
    const invite = db.prepare("SELECT id, email FROM invites WHERE owner_id = ? AND id = ?")
      .get(owner, target) as { id: string; email: string } | undefined;
    if (invite) {
      tx(db, () => {
        db.prepare("DELETE FROM invites WHERE owner_id = ? AND id = ?").run(owner, invite.id);
        publish(db, owner, "configuration.updated", invite.id, { resource: "invite", id: invite.id, removed: true });
      });
      log(owner, "warn", "team", `removed invite ${invite.email}`);
      return { response: json({ ok: true }), status: 200, owner };
    }
    const member = db.prepare("SELECT id, email, role FROM users WHERE id = ?")
      .get(target) as { id: string; email: string; role: string } | undefined;
    if (!member) return { response: json({ error: "Team member not found" }, 404), status: 404, owner };
    if (member.role === "owner") {
      const owners = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'owner' AND active = 1").get() as { n: number };
      if (owners.n <= 1) return { response: json({ error: "The account must keep at least one owner." }, 400), status: 400, owner };
    }
    tx(db, () => {
      db.prepare("UPDATE users SET active = 0 WHERE id = ?").run(member.id);
      publish(db, owner, "configuration.updated", member.id, { resource: "member", id: member.id, active: false });
    });
    log(owner, "warn", "team", `deactivated ${member.email}`);
    return { response: json({ ok: true }), status: 200, owner };
  }

  if (key === "POST settings") {
    const input = await body(req);
    if (typeof input.recordPageViews !== "boolean") return { response: json({ error: "recordPageViews must be boolean" }, 400), status: 400, owner };
    tx(db, () => {
      db.prepare(
        "INSERT INTO settings (owner_id, key, value) VALUES (?, 'recordPageViews', ?) ON CONFLICT(owner_id, key) DO UPDATE SET value = excluded.value",
      ).run(owner, input.recordPageViews ? "1" : "0");
      publish(db, owner, "configuration.updated", owner, { resource: "settings", recordPageViews: input.recordPageViews });
    });
    return { response: json({ ok: true }), status: 200, owner };
  }

  if (method === "DELETE" && parts[0] === "sessions" && parts[1]) {
    const current = readCookie(req) ? tokenHash(readCookie(req) as string) : "";
    const target = db.prepare("SELECT id, token_hash AS tokenHash FROM sessions WHERE user_id = ? AND (id = ? OR token_hash = ?)").get(owner, parts[1], parts[1]) as
      | { id: string | null; tokenHash: string }
      | undefined;
    if (!target || target.tokenHash === current) {
      return { response: json({ error: "Session not found, or it is the current browser session. Use sign out for this one." }, 404), status: 404, owner };
    }
    tx(db, () => {
      db.prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash = ?").run(owner, target.tokenHash);
      publish(db, owner, "session.revoked", target.id ?? target.tokenHash, { sessionId: target.id ?? target.tokenHash, reason: "revoked_by_user" });
    });
    return { response: json({ ok: true }), status: 200, owner };
  }

  if (key === "POST tokens") {
    const input = await body(req);
    const name = str(input.name);
    const days = Number(input.days ?? 30);
    if (!name) return { response: json({ error: "Name is required" }, 400), status: 400, owner };
    if (![7, 30, 90].includes(days)) return { response: json({ error: "Expiry must be 7, 30, or 90 days" }, 400), status: 400, owner };
    const issued = tx(db, () => {
      const credential = createToken(db, owner, name, days);
      publish(db, owner, "configuration.updated", credential.id, { resource: "token", id: credential.id, name: name.slice(0, 60) });
      return { token: credential.token, expiresAt: credential.expiresAt };
    });
    return { response: json(issued), status: 201, owner };
  }

  if (method === "DELETE" && parts[0] === "tokens" && parts[1]) {
    const existing = db.prepare("SELECT name FROM access_tokens WHERE owner_id = ? AND id = ?").get(owner, parts[1]) as
      | { name: string }
      | undefined;
    if (!existing) return { response: json({ error: "Token not found" }, 404), status: 404, owner };
    tx(db, () => {
      db.prepare("DELETE FROM access_tokens WHERE owner_id = ? AND id = ?").run(owner, parts[1]);
      publish(db, owner, "configuration.updated", parts[1], { resource: "token", id: parts[1], name: existing.name, deleted: true });
    });
    return { response: json({ ok: true }), status: 200, owner };
  }

  if (key === "POST device/approve") {
    const code = str((await body(req)).userCode);
    throttle("device-approve", owner);
    tx(db, () => {
      if (!approveDevice(db, owner, code)) throw new RequestError(404, "Code is unknown, expired, or already used");
      publish(db, owner, "configuration.updated", null, { resource: "device", approved: true });
      notify(db, owner, "auth.device", "Device approved", "Approved a device code");
    });
    return { response: json({ ok: true }), status: 200, owner };
  }

  // ---- QR device pairing: the signed-in browser's half -------------------

  // Starts a pairing session and returns the rendered QR. Any session this
  // account already had open is superseded, so a screenshot of an old code can
  // never be reused.
  if (key === "POST device/pairing") {
    throttle("pairing-create", owner);
    const input = await body(req, 4096);
    const origin = originOf(req);
    const { created, row } = tx(db, () => {
      const created = createPairing(db, owner, {
        name: str(input.name) || undefined,
        platform: str(input.platform) || undefined,
        userAgent: req.headers.get("user-agent") ?? undefined,
      });
      const row = readPairing(db, created.id);
      if (!row) throw new Error("Pairing insert not found");
      publish(db, owner, "device.pairing.created", created.id, publicPairing(row));
      return { created, row };
    });
    const payload = encodePairingTicket({ api: origin, id: created.id, secret: created.secret, code: created.verificationCode });
    const qr = await renderPairingQr(payload);
    log(owner, "info", "device", "started a QR pairing session");
    // The secret and the PNG are returned once, to the browser that asked for
    // them. It is the only moment the secret exists outside the QR image.
    return { response: json({ pairing: publicPairing(row), payload, qr_data_url: qr }), status: 201, owner };
  }

  // The browser polls this while the QR is on screen.
  if (method === "GET" && parts[0] === "device" && parts[1] === "pairing" && parts[2]) {
    const row = tx(db, () => {
      for (const stale of expireStale(db, owner)) {
        publish(db, owner, "device.pairing.expired", stale.id, { pairing_id: stale.id, status: "EXPIRED" });
      }
      return readPairing(db, parts[2]);
    });
    if (!row || row.owner_id !== owner) return { response: json({ error: "Pairing session not found" }, 404), status: 404, owner };
    return { response: json({ pairing: publicPairing(row) }), status: 200, owner };
  }

  // Approve a scanned device. Only the session's own account can approve, and
  // only after a device has actually scanned the code.
  if (method === "POST" && parts[0] === "device" && parts[1] === "pairing" && parts[2] && parts[3] === "approve") {
    const row = readPairing(db, parts[2]);
    if (!row || row.owner_id !== owner) return { response: json({ error: "Pairing session not found" }, 404), status: 404, owner };
    const approved = tx(db, () => {
      if (!approveFromBrowser(db, parts[2], owner)) return null;
      const updated = readPairing(db, parts[2]) ?? row;
      publish(db, owner, "device.pairing.approved", parts[2], publicPairing(updated));
      notify(db, owner, "auth.device", "Device approved", `Approved ${updated.scan_device_name ?? "a device"} over QR`);
      return updated;
    });
    if (!approved) return { response: json({ error: pairingError("not_approved"), reason: "not_approved" }, 409), status: 409, owner };
    log(owner, "info", "device", `approved QR pairing for ${approved.scan_device_name ?? "a device"}`);
    return { response: json({ pairing: publicPairing(approved) }), status: 200, owner };
  }

  // Cancel (or deny) an open pairing, from any non-terminal state.
  if (method === "DELETE" && parts[0] === "device" && parts[1] === "pairing" && parts[2]) {
    const row = readPairing(db, parts[2]);
    if (!row || row.owner_id !== owner) return { response: json({ error: "Pairing session not found" }, 404), status: 404, owner };
    tx(db, () => {
      if (closePairing(db, parts[2], "cancelled")) {
        publish(db, owner, "device.pairing.revoked", parts[2], { pairing_id: parts[2], reason: "cancelled" });
      }
    });
    return { response: json({ ok: true }), status: 200, owner };
  }

  if (key === "GET devices") {
    return { response: json({ devices: listDevices(db, owner) }), status: 200, owner };
  }

  if (method === "PATCH" && parts[0] === "devices" && parts[1]) {
    const name = str((await body(req)).name);
    if (!name) return { response: json({ error: "A device name is required" }, 400), status: 400, owner };
    tx(db, () => {
      if (!renameDevice(db, owner, parts[1], name)) throw new RequestError(404, "Device not found");
      publish(db, owner, "device.updated", parts[1], { device_id: parts[1], name: name.slice(0, 60) });
    });
    return { response: json({ ok: true }), status: 200, owner };
  }

  if (method === "DELETE" && parts[0] === "devices" && parts[1]) {
    const revoked = tx(db, () => {
      const changed = revokeDevice(db, owner, parts[1]);
      if (!changed.ok) throw new RequestError(404, "Device not found");
      publish(db, owner, "device.disconnected", parts[1], { device_id: parts[1], name: changed.device?.name ?? null, reason: "revoked" });
      return changed;
    });
    log(owner, "info", "device", `revoked ${revoked.device?.name ?? "a device"}`);
    return { response: json({ ok: true }), status: 200, owner };
  }

  if (key === "POST protection") {
    const input = await body(req, 4096);
    const password = typeof input.password === "string" ? input.password : "";
    if (password.length < 8 || password.length > 256) throw new RequestError(400, "Password must be 8–256 characters");
    const gate = tx(db, () => {
      if (!protectionStatus(db, owner, readGate(req)).unlocked) throw new RequestError(403, "Unlock screen privacy before changing its password");
      const token = setProtection(db, owner, password);
      publish(db, owner, "configuration.updated", owner, { resource: "protection", required: true });
      return token;
    });
    const headers = new Headers();
    headers.append("set-cookie", gateCookie(gate, WEEK / 1000, secureCookie(req)));
    return { response: json({ ok: true }, 200, headers), status: 200, owner };
  }

  if (key === "POST protection/unlock") {
    throttle("protection", owner);
    const input = await body(req, 4096);
    const password = typeof input.password === "string" ? input.password : "";
    const gate = password.length <= 256 ? unlockProtection(db, owner, password) : null;
    if (!gate) return { response: json({ error: "Password does not match" }, 401), status: 401, owner };
    const headers = new Headers();
    headers.append("set-cookie", gateCookie(gate, WEEK / 1000, secureCookie(req)));
    return { response: json({ ok: true }, 200, headers), status: 200, owner };
  }

  if (key === "DELETE protection") {
    tx(db, () => {
      if (!protectionStatus(db, owner, readGate(req)).unlocked) throw new RequestError(403, "Unlock screen privacy before removing its password");
      clearProtection(db, owner);
      publish(db, owner, "configuration.updated", owner, { resource: "protection", required: false });
    });
    const headers = new Headers();
    headers.append("set-cookie", gateCookie("", 0, secureCookie(req)));
    return { response: json({ ok: true }, 200, headers), status: 200, owner };
  }

  if (key === "POST webhooks") {
    const input = await body(req);
    const url = str(input.url);
    try {
      const target = new URL(url);
      if (url.length > 2048 || target.protocol !== "https:" || target.username || target.password || target.hash || target.search) throw new Error();
    } catch {
      throw new RequestError(400, "Enter an HTTPS webhook URL without credentials, query, or fragment");
    }
    const events = subscription(input.events);
    const secret = randomBytes(16).toString("hex");
    const id = newId();
    tx(db, () => {
      db.prepare("INSERT INTO webhooks (id, owner_id, url, secret, events, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
        id, owner, url, secret, events, Date.now(),
      );
      publish(db, owner, "configuration.updated", id, { resource: "webhook", id, url });
    });
    log(owner, "info", "webhooks", `registered ${new URL(url).host} for ${events}`);
    return { response: json({ secret, deliveryEnabled: true, events, deliverable: deliverableHost(url) }, 201), status: 201, owner };
  }

  if (method === "DELETE" && parts[0] === "webhooks" && parts[1]) {
    const existing = db.prepare("SELECT url FROM webhooks WHERE owner_id = ? AND id = ?").get(owner, parts[1]) as
      | { url: string }
      | undefined;
    if (!existing) return { response: json({ error: "Webhook not found" }, 404), status: 404, owner };
    tx(db, () => {
      db.prepare("DELETE FROM webhooks WHERE owner_id = ? AND id = ?").run(owner, parts[1]);
      publish(db, owner, "configuration.updated", parts[1], { resource: "webhook", id: parts[1], url: existing.url, deleted: true });
    });
    return { response: json({ ok: true }), status: 200, owner };
  }

  if (method === "PATCH" && parts[0] === "notifications" && parts[1]) {
    tx(db, () => {
      const result = db.prepare("UPDATE notifications SET read = 1 WHERE owner_id = ? AND id = ?").run(owner, parts[1]);
      if (!result.changes) throw new RequestError(404, "Notification not found");
      publish(db, owner, "notification.read", parts[1], { id: parts[1], read: true });
    });
    return { response: json({ ok: true }), status: 200, owner };
  }

  if (key === "POST billing") {
    const plan = str((await body(req)).plan);
    if (!["community", "mesh", "hardware"].includes(plan)) return { response: json({ error: "Unknown plan" }, 400), status: 400, owner };
    tx(db, () => {
      db.prepare("UPDATE users SET plan = ? WHERE id = ?").run(plan, owner);
      publish(db, owner, "account.updated", owner, { id: owner, plan });
    });
    log(owner, "info", "billing", `plan preference set to ${plan}. No payment provider is configured, so nothing was charged.`);
    return { response: json({ ok: true, charged: false }), status: 200, owner };
  }

  if (key === "POST profile") {
    const name = str((await body(req)).name);
    if (name.length < 1 || name.length > 80) return { response: json({ error: "Name is required" }, 400), status: 400, owner };
    tx(db, () => {
      db.prepare("UPDATE users SET name = ? WHERE id = ?").run(name, owner);
      publish(db, owner, "account.updated", owner, { id: owner, name });
    });
    return { response: json({ ok: true }), status: 200, owner };
  }

  if (key === "POST vitals") {
    const input = await body(req);
    const metric = str(input.metric);
    const value = Number(input.value);
    const page = str(input.path).slice(0, 120) || "/";
    if (!["LCP", "INP", "CLS", "FCP", "TTFB"].includes(metric) || !Number.isFinite(value) || value < 0) {
      return { response: json({ error: "Vital metric or value is invalid" }, 400), status: 400, owner };
    }
    db.prepare("INSERT INTO vitals (id, owner_id, metric, value, path, at) VALUES (?, ?, ?, ?, ?, ?)").run(newId(), owner, metric, value, page, Date.now());
    return { response: json({ ok: true }), status: 201, owner };
  }

  if (key === "POST firewall") {
    const input = await body(req);
    const name = str(input.name).slice(0, 80);
    const action = str(input.action);
    const matchKey = str(input.matchKey);
    const matchOp = str(input.matchOp);
    const matchValue = str(input.matchValue).slice(0, 200);
    if (!name || !matchValue) return { response: json({ error: "Name and match value are required" }, 400), status: 400, owner };
    if (!["deny", "log", "rate_limit"].includes(action)) return { response: json({ error: "Unknown action" }, 400), status: 400, owner };
    if (!["path", "ip", "header", "ja4", "user_agent", "host"].includes(matchKey) || !["equals", "starts_with", "contains"].includes(matchOp)) {
      return { response: json({ error: "Unknown match" }, 400), status: 400, owner };
    }
    const limitCount = action === "rate_limit" ? Math.min(10000, Math.max(1, Number(input.limitCount) || 60)) : null;
    const windowSec = action === "rate_limit" ? Math.min(86400, Math.max(1, Number(input.windowSec) || 60)) : null;
    const id = newId();
    tx(db, () => {
      db.prepare(
        "INSERT INTO firewall_rules (id, owner_id, name, action, match_key, match_op, match_value, header_name, limit_count, window_sec, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)",
      ).run(id, owner, name, action, matchKey, matchOp, matchValue, str(input.headerName) || null, limitCount, windowSec, Date.now());
      publish(db, owner, "configuration.updated", id, { resource: "firewall_rule", id, name, action, matchKey, matchOp, matchValue });
    });
    log(owner, "info", "firewall", `saved rule ${name}`);
    return { response: json({ ok: true }), status: 201, owner };
  }
  if (method === "DELETE" && parts[0] === "firewall" && parts[1]) {
    const existing = db.prepare("SELECT name FROM firewall_rules WHERE owner_id = ? AND id = ?").get(owner, parts[1]) as
      | { name: string }
      | undefined;
    if (!existing) return { response: json({ error: "Rule not found" }, 404), status: 404, owner };
    tx(db, () => {
      db.prepare("DELETE FROM firewall_rules WHERE owner_id = ? AND id = ?").run(owner, parts[1]);
      publish(db, owner, "configuration.updated", parts[1], { resource: "firewall_rule", id: parts[1], name: existing.name, deleted: true });
    });
    return { response: json({ ok: true }), status: 200, owner };
  }

  if (key === "POST builds") {
    const input = await body(req);
    const target = str(input.target);
    if (!["android", "web", "repository"].includes(target)) {
      return { response: json({ error: "Target must be android, web or repository" }), status: 400, owner };
    }
    if (target === "repository") {
      const repository = findRepository(db, owner, str(input.repositoryId) || str(input.repository_id));
      if (!repository) return { response: json({ error: "Repository not found" }), status: 404, owner };
      const connection = readConnection(db, owner);
      if (!connection) return { response: json({ error: "Connect GitHub first" }), status: 409, owner };
      const [repoOwner, repoName] = String(repository.fullName).split("/");
      const branch = str(input.branch) || String(repository.defaultBranch);
      const tree = await fetchTree(connection.accessToken, repoOwner, repoName, branch);
      const files = await Promise.all(
        tree.slice(0, 200).map(async (entry) => ({
          path: entry.path,
          content: await fetchFile(connection.accessToken, repoOwner, repoName, branch, entry.path),
        })),
      );
      let manifest: unknown = null;
      const manifestEntry = files.find((file) => file.path === "package.json");
      if (manifestEntry) manifest = safeJson(manifestEntry.content);
      const started = startBuild(db, {
        ownerId: owner,
        projectId: repository.importedProjectId ?? null,
        projectName: String(repository.fullName),
        target: "repository",
        triggerSource: "console",
        repositoryId: String(repository.id),
        branch,
        commit: str(input.commit) || null,
        note: `Analysis of ${repository.fullName}@${branch}`,
        files,
        manifest,
      });
      return { response: json({ ok: true, buildId: started.id }), status: 202, owner };
    }
    const project = db.prepare("SELECT id, name, repo_url AS repoUrl FROM projects WHERE owner_id = ? AND id = ?")
      .get(owner, str(input.projectId)) as { id: string; name: string; repoUrl: string | null } | undefined;
    if (!project) return { response: json({ error: "Project not found" }), status: 404, owner };
    const started = startBuild(db, {
      ownerId: owner,
      projectId: project.id,
      projectName: project.name,
      target: target as "web" | "android",
      triggerSource: "console",
      note: `${project.name} ${target}`,
    });
    return { response: json({ ok: true, buildId: started.id }), status: 202, owner };
  }

  if (method === "GET" && parts[0] === "builds" && !parts[1]) {
    return { response: json({ builds: listAccountBuilds(db, owner) }), status: 200, owner };
  }

  if (method === "GET" && parts[0] === "builds" && parts[1]) {
    const detail = readBuild(db, owner, parts[1]);
    if (!detail) return { response: json({ error: "Build not found" }), status: 404, owner };
    const after = Number(new URL(req.url).searchParams.get("after") ?? 0);
    return {
      response: json({ ...detail, events: readBuildEvents(db, parts[1], Number.isFinite(after) ? after : 0) }),
      status: 200,
      owner,
    };
  }

  if (method === "POST" && parts[0] === "github" && parts[1] === "connection") {
    const session = authenticate(req, db);
    if (!session) throw new RequestError(401, "Sign in to connect GitHub.");
    requireCsrf(req, session);
    const config = githubConfig();
    if (!config) throw new RequestError(503, "GitHub is not configured on this server.");
    const state = beginAuthorization(db, session.user.id);
    return {
      response: new Response(null, { status: 302, headers: { location: authorizationUrl(config, state) } }),
      status: 302,
      owner: session.user.id,
    };
  }

  if (method === "GET" && parts[0] === "github" && parts[1] === "callback") {
    const config = githubConfig();
    if (!config) throw new RequestError(503, "GitHub is not configured on this server.");
    const params = new URL(req.url).searchParams;
    const code = str(params.get("code"));
    const state = str(params.get("state"));
    if (!code || !state) throw new RequestError(400, "GitHub did not return a code.");
    const owner = consumeAuthorization(db, state);
    if (!owner) throw new RequestError(400, "That authorization has expired. Start again.");
    const token = await exchangeCode(config, code);
    const viewer = await fetchViewer(token.accessToken);
    saveConnection(db, owner, viewer, token);
    syncRepositories(db, owner, await fetchRepositories(token.accessToken));
    log(owner, "info", "github", `connected ${viewer.login}`);
    const target = new URL("/github", originOf(req));
    return { response: new Response(null, { status: 302, headers: { location: target.toString() } }), status: 302, owner };
  }

  if (method === "GET" && parts[0] === "github" && parts[1] === "status") {
    const connection = readConnection(db, owner);
    return {
      response: json({
        connected: Boolean(connection),
        login: connection?.login ?? null,
        avatarUrl: connection?.avatarUrl ?? null,
        scopes: connection?.scopes ?? null,
        repositories: listRepositories(db, owner).length,
      }),
      status: 200,
      owner,
    };
  }

  if (method === "GET" && parts[0] === "github" && parts[1] === "repos") {
    return { response: json({ repositories: listRepositories(db, owner) }), status: 200, owner };
  }

  if (method === "POST" && parts[0] === "github" && parts[1] === "sync") {
    const connection = readConnection(db, owner);
    if (!connection) return { response: json({ error: "Connect GitHub first" }), status: 409, owner };
    syncRepositories(db, owner, await fetchRepositories(connection.accessToken));
    return { response: json({ repositories: listRepositories(db, owner) }), status: 200, owner };
  }

  if (method === "GET" && parts[0] === "github" && parts[1] === "tree") {
    const connection = readConnection(db, owner);
    if (!connection) return { response: json({ error: "Connect GitHub first" }), status: 409, owner };
    const params = new URL(req.url).searchParams;
    const repository = findRepository(db, owner, params.get("repository") ?? "");
    if (!repository) return { response: json({ error: "Repository not found" }), status: 404, owner };
    const [repoOwner, repoName] = String(repository.fullName).split("/");
    const tree = await fetchTree(connection.accessToken, repoOwner, repoName, params.get("ref") || String(repository.defaultBranch));
    return { response: json({ files: tree }), status: 200, owner };
  }

  if (method === "GET" && parts[0] === "github" && parts[1] === "file") {
    const connection = readConnection(db, owner);
    if (!connection) return { response: json({ error: "Connect GitHub first" }), status: 409, owner };
    const params = new URL(req.url).searchParams;
    const repository = findRepository(db, owner, params.get("repository") ?? "");
    if (!repository) return { response: json({ error: "Repository not found" }), status: 404, owner };
    const path = params.get("path") ?? "";
    if (!path || path.length > 512) return { response: json({ error: "A file path is required" }), status: 400, owner };
    const [repoOwner, repoName] = String(repository.fullName).split("/");
    const content = await fetchFile(connection.accessToken, repoOwner, repoName, params.get("ref") || String(repository.defaultBranch), path);
    return { response: json({ path, content }), status: 200, owner };
  }

  if (method === "POST" && parts[0] === "github" && parts[1] === "import") {
    const input = await body(req, 8192);
    const repository = findRepository(db, owner, str(input.repositoryId) || str(input.repository_id));
    if (!repository) return { response: json({ error: "Repository not found" }), status: 404, owner };
    if (repository.importedProjectId) {
      return { response: json({ ok: true, projectId: repository.importedProjectId, alreadyImported: true }), status: 200, owner };
    }
    const name = safeSlug(str(input.name) || String(repository.name), "Project name");
    const projectId = newId();
    tx(db, () => {
      db.prepare(
        "INSERT INTO projects (id, owner_id, name, framework, target, repo_url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(
        projectId,
        owner,
        name,
        str(input.framework) || String(repository.language ?? "unknown").toLowerCase(),
        "web",
        String(repository.url ?? `https://github.com/${repository.fullName}`),
        Date.now(),
      );
      db.prepare("UPDATE repositories SET imported_project_id = ? WHERE id = ?").run(projectId, repository.id);
    });
    publish(db, owner, "configuration.updated", projectId, { resource: "project", id: projectId, name, imported: true });
    log(owner, "info", "github", `imported ${repository.fullName} as ${name}`);
    return { response: json({ ok: true, projectId }), status: 200, owner };
  }

  if (method === "DELETE" && parts[0] === "github" && parts[1] === "connection") {
    deleteConnection(db, owner);
    log(owner, "info", "github", "disconnected");
    return { response: json({ ok: true }), status: 200, owner };
  }

  if (key === "POST workflows") {
    if (!runtimeEnabled()) throw new RequestError(503, RUNTIME_DISABLED);
    const input = await body(req);
    const name = safeSlug(str(input.name), "Workflow name");
    const steps = parseSteps(input.steps);
    const id = newId();
    tx(db, () => {
      db.prepare("INSERT INTO workflows (id, owner_id, name, steps, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(id, owner, name, JSON.stringify(steps), Date.now());
      publish(db, owner, "configuration.updated", id, { resource: "workflow", id, name, steps: steps.length });
    });
    log(owner, "info", "workflows", `saved ${name} with ${steps.length} step${steps.length === 1 ? "" : "s"}`);
    return { response: json({ ok: true, steps: steps.length }), status: 201, owner };
  }
  if (method === "POST" && parts[0] === "workflows" && parts[2] === "run") {
    if (!runtimeEnabled()) throw new RequestError(503, RUNTIME_DISABLED);
    const row = db.prepare("SELECT id, name, steps FROM workflows WHERE owner_id = ? AND id = ?")
      .get(owner, parts[1]) as { id: string; name: string; steps: string | null } | undefined;
    if (!row) return { response: json({ error: "Workflow not found" }, 404), status: 404, owner };
    const cap = quotaBreach(db, owner, "workflow_runs");
    if (cap) {
      log(owner, "warn", "workflows", `${row.name} was blocked by the run spend cap (${cap.used}/${cap.limit})`);
      throw new RequestError(429, quotaMessage(cap));
    }
    const outcome = runWorkflow(db, owner, row);
    const id = newId();
    tx(db, () => {
      db.prepare(
        "INSERT INTO workflow_runs (id, owner_id, workflow_id, status, note, at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(id, owner, row.id, outcome.status, outcome.note, Date.now());
      recordUsage(db, owner, "workflow_runs", 1, row.id);
      publish(db, owner, "configuration.updated", row.id, { resource: "workflow_run", id, workflowId: row.id, workflow: row.name, status: outcome.status, note: outcome.note });
    });
    log(owner, outcome.status === "succeeded" ? "info" : "warn", "workflows", `${row.name}: ${outcome.note}`);
    return { response: json({ ok: outcome.status === "succeeded", status: outcome.status, note: outcome.note, steps: outcome.steps }), status: 200, owner };
  }

  if (key === "POST drives") {
    const name = safeSlug(str((await body(req)).name), "Drive name");
    const dir = join(dataRoot(), "drives", owner, name);
    mkdirSync(dir, { recursive: true });
    const id = newId();
    tx(db, () => {
      db.prepare("INSERT INTO drives (id, owner_id, name, path, created_at) VALUES (?, ?, ?, ?, ?)").run(id, owner, name, dir, Date.now());
      publish(db, owner, "configuration.updated", id, { resource: "drive", id, name });
    });
    log(owner, "info", "drives", `created local directory ${name}`);
    return { response: json({ ok: true }), status: 201, owner };
  }

  if (key === "POST shell") {
    const command = str((await body(req)).command);
    const [bin, arg] = command.split(/\s+/);
    let output = "";
    if (bin === "help") output = "help, whoami, projects, deployments, metrics";
    else if (bin === "whoami") output = `${user.name} <${user.email}> ${user.role}`;
    else if (bin === "projects") {
      const rows = listProjects(owner);
      output = rows.length ? rows.map((p) => p.name).join("\n") : "no projects";
    } else if (bin === "deployments") {
      const rows = listDeployments(owner);
      output = rows.length ? rows.map((d) => `${d.project} ${d.status}`).join("\n") : "no deployments";
    } else if (bin === "metrics") {
      const m = collectMetrics(db, owner, operatorMetrics);
      output = `uptime ${m.processUptimeSec}s\nmemory ${m.memoryUsedPct ?? "n/a"}%\nresponse ${m.responseAvgMs ?? "n/a"} ms (${m.responseSamples} samples)`;
    } else if (bin === "deploy" && arg) {
      output = "refused: deploy from the shell is not wired to a build runner";
    } else output = `unknown command: ${bin || "(empty)"}`;
    log(owner, "info", "shell", `$ ${command || "(empty)"}`);
    return { response: json({ output }), status: 200, owner };
  }

  return { response: json({ error: "Not found" }, 404), status: 404, owner };
}

/**
 * The relying party a passkey ceremony is bound to.
 *
 * The relying party id is the host of the console, and the origin is the
 * console's public address. Both come from the server's own configuration
 * when there is one, so a request cannot talk the server into accepting a
 * passkey for somebody else's site.
 */
function passkeyConfig(req: Request): { rpId: string; rpName: string; origin: string } {
  const origin = publicOrigin() ?? originOf(req);
  const url = new URL(origin);
  const configured = process.env.MOBILECLOUD_WEBAUTHN_RP_ID?.trim();
  let rpId = url.hostname;
  if (configured) {
    if (url.hostname !== configured && !url.hostname.endsWith(`.${configured}`)) {
      throw new RequestError(503, "MOBILECLOUD_WEBAUTHN_RP_ID must be the console hostname or one of its parent domains.");
    }
    rpId = configured;
  }
  return { rpId, rpName: "MobileCloud", origin };
}

/** The address a request came from, when the deployment can be trusted for it. */
function requestIp(req: Request): string | null {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first && first.length <= 64) return first;
  }
  return req.headers.get("x-real-ip")?.slice(0, 64) ?? null;
}

/**
 * Locks an account after a run of failed password attempts.
 *
 * Ten failures inside fifteen minutes close the account for fifteen minutes.
 * The account, not the address, is what gets locked, so a shared address
 * cannot lock an account out and a distributed attempt cannot spread over it.
 */
function lockIfRepeatedFailures(db: DatabaseSync, userId: string): void {
  const failures = db.prepare(
    "SELECT COUNT(*) AS n FROM auth_events WHERE user_id = ? AND event_type = 'auth.login.failed' AND created_at > ?",
  ).get(userId, Date.now() - 15 * 60_000) as { n: number };
  if (Number(failures?.n ?? 0) < 10) return;
  db.prepare("UPDATE users SET failed_attempts = failed_attempts + 1, locked_until = ? WHERE id = ?").run(Date.now() + 15 * 60_000, userId);
  logAuthEvent(db, {
    userId,
    eventType: "auth.suspicious.brute_force",
    clientType: "web",
    credentialType: "password",
    outcome: "suspicious",
    riskScore: "critical",
    failureReason: "account_locked",
  });
  notify(db, userId, "auth.suspicious", "Account locked", "Too many failed sign-in attempts. The account was locked for 15 minutes.");
}

/** The timezone an account records, used by the unusual hour risk factor. */
function userTimezone(db: DatabaseSync, userId: string): string | null {
  const row = db.prepare("SELECT timezone FROM users WHERE id = ?").get(userId) as { timezone: string | null } | undefined;
  return row?.timezone ?? null;
}

/**
 * Records the device a passkey belongs to.
 *
 * A phone that registers a passkey becomes a linked device with its own
 * durable credential, so it can be listed and revoked like any other device.
 */
function linkPasskeyDevice(db: DatabaseSync, userId: string, name: string, platform: string, credentialId: string): string {
  const existing = db.prepare(
    "SELECT id FROM connected_devices WHERE owner_id = ? AND platform = ? AND revoked = 0 AND method = 'passkey' ORDER BY created_at DESC LIMIT 1",
  ).get(userId, platform) as { id: string } | undefined;
  const now = Date.now();
  if (existing) {
    db.prepare("UPDATE connected_devices SET name = ?, last_active = ? WHERE id = ?").run(name.slice(0, 60), now, existing.id);
    return existing.id;
  }
  const issued = createToken(db, userId, `device: ${name}`.slice(0, 60), 30);
  const deviceId = newId();
  db.prepare(
    `INSERT INTO connected_devices (id, owner_id, token_id, name, platform, method, created_at, paired_at, last_active, revoked)
     VALUES (?, ?, ?, ?, ?, 'passkey', ?, ?, ?, 0)`,
  ).run(deviceId, userId, issued.id, name.slice(0, 60), platform, now, now, now);
  db.prepare("UPDATE credentials SET device_name = ? WHERE id = ? AND user_id = ?").run(name.slice(0, 60), credentialId, userId);
  return deviceId;
}

/** Caller holds the transaction for credential issuance and its outbox rows. */
function startSession(
  db: DatabaseSync,
  userId: string,
  req: Request,
  deviceId: string | null = null,
  clientType: ClientType = "web",
  credentialId: string | null = null,
): Headers {
  const build = () => {
    const created = createSession(db, {
      userId,
      clientType,
      userAgent: req.headers.get("user-agent") ?? "unknown",
      deviceId,
      credentialId,
      ipAddress: requestIp(req),
    });
    const maxAge = Math.max(1, Math.floor((created.expiresAt - Date.now()) / 1000));
    notify(db, userId, "auth.session", "New session", req.headers.get("user-agent") ?? "unknown");
    const headers = new Headers();
    headers.append("set-cookie", cookieHeader(req, created.token, maxAge));
    headers.append("set-cookie", csrfCookieHeader(req, created.csrf, maxAge));
    return headers;
  };
  // The session row and the event that announces it belong together.
  return db.isTransaction ? build() : tx(db, build);
}

function issueSession(db: DatabaseSync, userId: string, req: Request) {
  const headers = tx(db, () => startSession(db, userId, req));
  const user = db.prepare("SELECT id, email, name, role, plan FROM users WHERE id = ?").get(userId);
  return { response: json({ user }, 200, headers), status: 200, owner: userId };
}

function listProjects(owner: string) {
  return openDb().prepare(
    "SELECT id, name, framework, target, repo_url AS repoUrl, created_at AS createdAt FROM projects WHERE owner_id = ? ORDER BY created_at DESC",
  ).all(owner);
}

function listDeployments(owner: string) {
  return openDb().prepare(
    `SELECT d.id, d.project_id AS projectId, p.name AS project, d.status, d.note, d.created_at AS createdAt
     FROM deployments d JOIN projects p ON p.id = d.project_id
     WHERE d.owner_id = ? ORDER BY d.created_at DESC LIMIT 100`,
  ).all(owner);
}

type DomainRow = {
  id: string;
  owner_id: string;
  host: string;
  project: string;
  detail: string;
  status: string;
  dns_provider: string | null;
  dns_status: string | null;
  ssl_status: string | null;
  health_status: string | null;
  dns_verified_at: number | null;
  ssl_expires_at: number | null;
  ssl_issuer: string | null;
  tunnel_target: string | null;
  verification_token: string | null;
  verification_method: string | null;
  propagation: string | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
};

/** The Cloudflare Tunnel target the platform routes through, when configured. */
function domainTunnelTarget(): string | null {
  const id = process.env.CLOUDFLARE_TUNNEL_ID?.trim();
  return id ? `${id}.cfargotunnel.com` : null;
}

function parseDomainJson<T>(value: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

/**
 * Projects a database row onto the public `Domain` contract.
 *
 * The lifecycle `status` is always *derived* from the three independent signals
 * so a stale stored value can never make the clients report a false success.
 */
function rowToDomain(row: DomainRow): Domain {
  const now = Date.now();
  const dnsStatus = (row.dns_status || "pending") as DnsSignal;
  const sslStatus = (row.ssl_status || "none") as SslSignal;
  const healthStatus = (row.health_status || "unknown") as HealthSignal;
  return {
    id: row.id,
    host: row.host,
    project: row.project,
    status: deriveStatus({
      dnsStatus,
      sslStatus,
      healthStatus,
      sslExpiresAt: row.ssl_expires_at,
      now,
      suspended: row.status === "suspended",
      deleting: row.status === "deleting",
    }),
    detail: row.detail,
    dnsProvider: row.dns_provider,
    dnsStatus,
    sslStatus,
    healthStatus,
    dnsVerifiedAt: row.dns_verified_at,
    sslExpiresAt: row.ssl_expires_at,
    sslIssuer: row.ssl_issuer,
    tunnelTarget: row.tunnel_target,
    verificationToken: row.verification_token,
    verificationMethod: (row.verification_method || "cname") as VerificationMethod,
    propagation: parseDomainJson<DomainPropagation>(row.propagation),
    lastError: parseDomainJson<DomainLastError>(row.last_error),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const DOMAIN_COLUMNS = `d.id, d.owner_id, d.host, p.name AS project, d.detail, d.status,
  d.dns_provider, d.dns_status, d.ssl_status, d.health_status,
  d.dns_verified_at, d.ssl_expires_at, d.ssl_issuer, d.tunnel_target,
  d.verification_token, d.verification_method, d.propagation, d.last_error,
  d.created_at, d.updated_at`;

function readDomain(db: DatabaseSync, owner: string, id: string): DomainRow | undefined {
  return db.prepare(
    `SELECT ${DOMAIN_COLUMNS} FROM domains d JOIN projects p ON p.id = d.project_id WHERE d.owner_id = ? AND d.id = ?`,
  ).get(owner, id) as DomainRow | undefined;
}

function listDomains(owner: string): Domain[] {
  const rows = openDb().prepare(
    `SELECT ${DOMAIN_COLUMNS} FROM domains d JOIN projects p ON p.id = d.project_id WHERE d.owner_id = ? ORDER BY d.created_at DESC`,
  ).all(owner) as DomainRow[];
  return rows.map(rowToDomain);
}

function listDatabases(owner: string) {
  const rows = openDb().prepare("SELECT id, name, path, created_at AS createdAt FROM db_files WHERE owner_id = ?").all(owner) as { id: string; name: string; path: string; createdAt: number }[];
  return rows.map((row) => {
    let bytes: number | null = null;
    try {
      bytes = statSync(row.path).size;
    } catch {
      bytes = null;
    }
    return { id: row.id, name: row.name, engine: "sqlite" as const, path: row.path, bytes };
  });
}

function listFunctions(owner: string) {
  return openDb().prepare(
    "SELECT id, name, route, invocations, source IS NOT NULL AS hasSource FROM functions WHERE owner_id = ? ORDER BY created_at DESC",
  ).all(owner).map((row) => {
    const item = row as { id: string; name: string; route: string; invocations: number; hasSource: number };
    return { ...item, hasSource: item.hasSource === 1 };
  });
}

function listObjects(owner: string) {
  return openDb().prepare(
    "SELECT id, bucket, key, bytes FROM objects WHERE owner_id = ? ORDER BY created_at DESC",
  ).all(owner);
}

function listLogs(owner: string) {
  return openDb().prepare(
    "SELECT id, level, source, message, at FROM logs WHERE owner_id = ? ORDER BY at DESC LIMIT 100",
  ).all(owner);
}

function listTeam(owner: string) {
  const self = openDb().prepare("SELECT id, name, email, role FROM users WHERE id = ?").get(owner) as { id: string; name: string; email: string; role: string };
  const invites = openDb().prepare(
    "SELECT id, name, email, role, email_sent AS emailSent FROM invites WHERE owner_id = ? ORDER BY created_at DESC",
  ).all(owner) as { id: string; name: string; email: string; role: string; emailSent: number }[];
  return [
    { ...self, emailSent: true },
    ...invites.map((row) => ({ ...row, emailSent: row.emailSent === 1 })),
  ];
}

function listSettings(owner: string) {
  const row = openDb().prepare("SELECT value FROM settings WHERE owner_id = ? AND key = 'recordPageViews'").get(owner) as { value: string } | undefined;
  return { recordPageViews: row ? row.value === "1" : true };
}

function billing(user: User) {
  return {
    plan: user.plan,
    provider: null,
    charged: false,
    detail: "No payment provider is configured. Changing the plan only stores a preference and does not bill a card.",
  };
}
