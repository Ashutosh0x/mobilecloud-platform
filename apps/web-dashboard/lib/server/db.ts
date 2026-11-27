import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { assertRuntimeConfig } from "./config.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'community',
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  framework TEXT NOT NULL,
  target TEXT NOT NULL,
  repo_url TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(owner_id, name)
);
CREATE TABLE IF NOT EXISTS deployments (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  status TEXT NOT NULL,
  note TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS domains (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  host TEXT NOT NULL,
  status TEXT NOT NULL,
  detail TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS db_files (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(owner_id, name)
);
CREATE TABLE IF NOT EXISTS functions (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  route TEXT NOT NULL,
  invocations INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS objects (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  bucket TEXT NOT NULL,
  key TEXT NOT NULL,
  path TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS logs (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  level TEXT NOT NULL,
  source TEXT NOT NULL,
  message TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  email_sent INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  owner_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (owner_id, key)
);
CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY,
  owner_id TEXT,
  path TEXT NOT NULL,
  status INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  at INTEGER NOT NULL,
  user_agent TEXT,
  host TEXT,
  ja4 TEXT
);
CREATE TABLE IF NOT EXISTS firewall_rules (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  action TEXT NOT NULL,
  match_key TEXT NOT NULL,
  match_op TEXT NOT NULL,
  match_value TEXT NOT NULL,
  header_name TEXT,
  limit_count INTEGER,
  window_sec INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS firewall_events (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  rule_id TEXT,
  action TEXT NOT NULL,
  path TEXT NOT NULL,
  ip TEXT NOT NULL,
  at INTEGER NOT NULL,
  user_agent TEXT,
  host TEXT,
  ja4 TEXT
);
CREATE TABLE IF NOT EXISTS vitals (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  metric TEXT NOT NULL,
  value REAL NOT NULL,
  path TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS builds (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  target TEXT NOT NULL,
  status TEXT NOT NULL,
  note TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS workflow_runs (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  status TEXT NOT NULL,
  note TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS drives (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS access_tokens (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  token_hash TEXT UNIQUE NOT NULL,
  prefix TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  last_used INTEGER
);
CREATE TABLE IF NOT EXISTS device_codes (
  id TEXT PRIMARY KEY,
  device_hash TEXT UNIQUE NOT NULL,
  user_code TEXT NOT NULL,
  owner_id TEXT,
  status TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
-- Short-lived, single-use QR pairing sessions. A signed-in browser creates one
-- and renders its secrets as a QR code; an Android device scans it and
-- explicitly approves. Only the SHA-256 hash of the pairing secret is stored,
-- and the row is consumed exactly once (see lib/server/pairing.ts).
CREATE TABLE IF NOT EXISTS pairing_sessions (
  id TEXT PRIMARY KEY,
  secret_hash TEXT UNIQUE NOT NULL,
  user_code TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  status TEXT NOT NULL,
  method TEXT NOT NULL DEFAULT 'qr',
  browser_name TEXT,
  browser_platform TEXT,
  browser_user_agent TEXT,
  browser_ip TEXT,
  scan_device_name TEXT,
  scan_device_platform TEXT,
  scan_app_version TEXT,
  fail_reason TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  scanned_at INTEGER,
  approved_at INTEGER,
  connected_at INTEGER,
  device_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_pairing_owner ON pairing_sessions (owner_id, created_at);
-- Devices that have been linked through QR pairing. Each row references the
-- durable access token that was issued at approval time, so bearer
-- authentication continues to flow through the existing access_tokens table.
CREATE TABLE IF NOT EXISTS connected_devices (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  token_id TEXT,
  pairing_id TEXT,
  name TEXT NOT NULL,
  platform TEXT NOT NULL,
  app_version TEXT,
  method TEXT NOT NULL DEFAULT 'qr',
  created_at INTEGER NOT NULL,
  paired_at INTEGER NOT NULL,
  last_active INTEGER,
  last_ip TEXT,
  revoked INTEGER NOT NULL DEFAULT 0,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_devices_owner ON connected_devices (owner_id, revoked);
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  read INTEGER NOT NULL DEFAULT 0,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS webhooks (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  url TEXT NOT NULL,
  secret TEXT NOT NULL,
  events TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
-- Outbound webhook delivery queue. A row is enqueued inside the same
-- transaction as the event it describes (see lib/server/webhook.ts), so a
-- crash cannot lose an event and a redelivery cannot double-send because the
-- (webhook_id, event_id) pair is unique.
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  webhook_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  response_status INTEGER,
  last_error TEXT,
  next_attempt_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(webhook_id, event_id)
);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_due ON webhook_deliveries (status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_owner ON webhook_deliveries (owner_id, created_at);
-- Append-only usage counters. The metering engine writes one row per billable
-- operation (function invocation, workflow run, webhook delivery, bytes
-- written) inside the same transaction as the operation, and reports the sum
-- per meter over the current period. Storage is a gauge read from the object
-- and database tables, not a counter.
CREATE TABLE IF NOT EXISTS usage_events (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  meter TEXT NOT NULL,
  qty INTEGER NOT NULL,
  resource_id TEXT,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_events_meter ON usage_events (owner_id, meter, at);
-- Proof-of-reserve attestations. The reconciliation math lives in the Rust
-- por-kernel crate (the single source of financial truth); the control plane
-- only stores the output of that kernel and serves it read-only. Base-unit
-- amounts are decimal strings because they are u128 values that exceed JS integers.
CREATE TABLE IF NOT EXISTS por_attestations (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  status TEXT NOT NULL,
  reserve_ratio_bps INTEGER NOT NULL,
  total_backing_base TEXT NOT NULL,
  total_liabilities_base TEXT NOT NULL,
  net_difference_base TEXT NOT NULL,
  evidence_age_sec INTEGER NOT NULL,
  ledger_sequence INTEGER,
  digest TEXT,
  quorum TEXT,
  observed_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_por_attestations_owner ON por_attestations (owner_id, created_at);
-- Durable event outbox. Every mutation appends one row inside the same
-- transaction as the write it describes, so a dropped WebSocket frame can
-- never lose a change: clients recover by reading this table through
-- GET /api/sync/changes?cursor=N. The seq column is the global, monotonically
-- increasing ordering token used for cursor sync and duplicate detection.
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT UNIQUE NOT NULL,
  owner_id TEXT NOT NULL,
  type TEXT NOT NULL,
  resource_id TEXT,
  schema_version INTEGER NOT NULL DEFAULT 1,
  actor TEXT,
  payload TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_owner_seq ON events (owner_id, seq);
CREATE TABLE IF NOT EXISTS event_cursors (
  consumer TEXT PRIMARY KEY,
  seq INTEGER NOT NULL,
  at INTEGER NOT NULL
);
-- ============================================================================
-- UNIFIED AUTHENTICATION (schema v5)
-- ============================================================================
-- WebAuthn / passkey credentials. The public key is stored as the COSE_Key
-- bytes the authenticator produced, so verification never re-encodes it.
CREATE TABLE IF NOT EXISTS credentials (
  id              TEXT    PRIMARY KEY,              -- credential id (base64url)
  user_id         TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_type TEXT    NOT NULL DEFAULT 'passkey', -- passkey | recovery
  public_key      BLOB    NOT NULL,                 -- COSE_Key bytes
  sign_count      INTEGER NOT NULL DEFAULT 0,      -- authenticator counter
  transports      TEXT,                             -- internal,hybrid,ble,...
  aaguid          TEXT,                             -- authenticator model GUID
  device_name     TEXT,                             -- user-visible label
  backed_up       INTEGER NOT NULL DEFAULT 0,      -- 1 when the passkey syncs
  created_at      INTEGER NOT NULL,
  last_used_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_credentials_user ON credentials(user_id);
-- In-flight WebAuthn ceremonies. The challenge is stored hashed and expires in
-- five minutes; a replayed challenge can never be redeemed twice.
CREATE TABLE IF NOT EXISTS webauthn_challenges (
  id              TEXT    PRIMARY KEY,
  challenge_hash  TEXT    NOT NULL UNIQUE,          -- SHA-256 of the challenge bytes
  kind            TEXT    NOT NULL,                 -- register | authenticate
  user_id         TEXT    REFERENCES users(id) ON DELETE CASCADE,
  email           TEXT,
  display_name    TEXT,
  rp_id           TEXT    NOT NULL,
  origin          TEXT    NOT NULL,
  credential_ids  TEXT,                             -- JSON array (authenticate)
  device_name     TEXT,
  device_platform TEXT,
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL
);
-- Rotating refresh tokens. Only the SHA-256 of the token is stored, and a
-- replayed token revokes the whole family (see lib/server/oauth.ts).
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id              TEXT    PRIMARY KEY,
  user_id         TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash      TEXT    NOT NULL UNIQUE,
  session_id      TEXT,
  access_token_id TEXT,
  client_type     TEXT    NOT NULL,                 -- android | cli | api
  scope           TEXT    NOT NULL DEFAULT 'cli:full',
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  used_at         INTEGER,                          -- set on rotation
  replaced_by     TEXT,                             -- next token in the chain
  revoked         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_session ON refresh_tokens(session_id);
-- RFC 8628 device authorization codes. The device code is stored hashed; the
-- user code is what a human types into the console.
CREATE TABLE IF NOT EXISTS oauth_device_codes (
  id              TEXT    PRIMARY KEY,
  device_code_hash TEXT   NOT NULL UNIQUE,          -- SHA-256 of device_code
  user_code       TEXT    NOT NULL UNIQUE,          -- ABCD-1234
  client_id       TEXT    NOT NULL,                 -- mobilecloud-cli
  scope           TEXT    NOT NULL DEFAULT 'cli:full',
  approved_by     TEXT    REFERENCES users(id),
  status          TEXT    NOT NULL DEFAULT 'pending', -- pending|approved|denied|consumed|expired
  device_name     TEXT,
  device_platform TEXT,
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  interval_sec    INTEGER NOT NULL DEFAULT 5
);
-- OAuth 2.1 authorization codes with PKCE. Single use, five minute lifetime.
CREATE TABLE IF NOT EXISTS oauth_authorization_codes (
  id                  TEXT    PRIMARY KEY,
  code_hash           TEXT    NOT NULL UNIQUE,
  client_id           TEXT    NOT NULL,
  user_id             TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  redirect_uri        TEXT    NOT NULL,
  scope               TEXT    NOT NULL,
  nonce               TEXT,
  code_challenge      TEXT    NOT NULL,
  code_challenge_method TEXT  NOT NULL DEFAULT 'S256',
  used                INTEGER NOT NULL DEFAULT 0,
  created_at          INTEGER NOT NULL,
  expires_at          INTEGER NOT NULL
);
-- ============================================================================
-- CUSTOM SSO (schema v6): OIDC clients, signing keys, SAML SPs, SCIM
-- ============================================================================
-- A public client has no secret (SPA, mobile, PKCE CLI); a confidential client
-- authenticates at the token endpoint. Redirect lists are JSON arrays and are
-- matched exactly, never by prefix.
CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  secret_hash TEXT,
  redirect_uris TEXT NOT NULL DEFAULT '[]',
  post_logout_redirect_uris TEXT NOT NULL DEFAULT '[]',
  scopes TEXT NOT NULL DEFAULT 'openid profile email',
  grant_types TEXT NOT NULL DEFAULT 'authorization_code refresh_token',
  public INTEGER NOT NULL DEFAULT 1,
  backchannel_logout_uri TEXT,
  created_at INTEGER NOT NULL
);
-- JWT and SAML signing material. Rotation is explicit: a new row becomes
-- active and the old one stays published until its overlap window ends.
CREATE TABLE IF NOT EXISTS signing_keys (
  id TEXT PRIMARY KEY,
  kid TEXT NOT NULL UNIQUE,
  alg TEXT NOT NULL,
  private_pem TEXT NOT NULL,
  public_jwk TEXT NOT NULL,
  certificate_pem TEXT,
  created_at INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS saml_service_providers (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL UNIQUE,
  acs_url TEXT NOT NULL,
  slo_url TEXT,
  certificate_pem TEXT,
  name_id_format TEXT NOT NULL DEFAULT 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS scim_tokens (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used INTEGER
);
CREATE INDEX IF NOT EXISTS idx_scim_tokens_owner ON scim_tokens(owner_id);
CREATE TABLE IF NOT EXISTS scim_groups (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  external_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS scim_group_members (
  group_id TEXT NOT NULL REFERENCES scim_groups(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (group_id, user_id)
);
-- ============================================================================
-- IDENTITY EXTENSIONS (schema v7): consent and federated identity links
-- ============================================================================
-- What an account approved for a client, so consent can be shown once and
-- audited later. Scope changes require a new consent.
CREATE TABLE IF NOT EXISTS identity_consents (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(user_id, client_id)
);
CREATE INDEX IF NOT EXISTS idx_identity_consents_user ON identity_consents(user_id);
-- A federated identity is unique by (provider, issuer, subject). Email is
-- stored for display and recovery only; it is never the linking key.
CREATE TABLE IF NOT EXISTS external_identity_links (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  email TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(provider, issuer, subject)
);
CREATE INDEX IF NOT EXISTS idx_external_links_user ON external_identity_links(user_id);
-- Short-lived, action-bound WebAuthn challenges for payment/security step-up.
-- A step-up token is only issued after the assertion verifies against the
-- credential and the payload hash still matches the approved action.
CREATE TABLE IF NOT EXISTS step_up_challenges (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  action TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  challenge_hex TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_step_up_challenges_user ON step_up_challenges(user_id, created_at);
-- "Login with MobileCloud": the browser shows a QR code and the phone approves
-- it. poll_secret_hash proves the request came from the browser that started
-- the flow, so only that browser can claim the resulting session.
CREATE TABLE IF NOT EXISTS qr_login_challenges (
  id              TEXT    PRIMARY KEY,
  challenge_hash  TEXT    NOT NULL UNIQUE,          -- SHA-256 of the challenge bytes
  poll_secret_hash TEXT   NOT NULL UNIQUE,          -- SHA-256 of the browser poll secret
  verification_code TEXT  NOT NULL,                 -- 6 characters shown on both screens
  browser_info    TEXT,
  ip_address      TEXT,
  status          TEXT    NOT NULL DEFAULT 'waiting', -- waiting|scanned|approved|denied|expired|consumed
  approved_by     TEXT    REFERENCES users(id),
  device_id       TEXT,
  credential_id   TEXT,
  session_id      TEXT,
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  scanned_at      INTEGER,
  approved_at     INTEGER
);
-- Structured authentication audit trail (see lib/server/audit.ts).
CREATE TABLE IF NOT EXISTS auth_events (
  id              TEXT    PRIMARY KEY,
  user_id         TEXT    REFERENCES users(id),
  event_type      TEXT    NOT NULL,                 -- auth.login.passkey, auth.login.failed, ...
  client_type     TEXT,                             -- android | web | cli | api
  credential_type TEXT,                             -- passkey | password | token | qr
  session_id      TEXT,
  device_id       TEXT,
  ip_address      TEXT,
  user_agent      TEXT,
  geo_location    TEXT,                             -- JSON {country,lat,lon}
  outcome         TEXT    NOT NULL,                 -- success | failure | suspicious
  failure_reason  TEXT,
  risk_score      TEXT    NOT NULL DEFAULT 'low',   -- low | medium | high | critical
  metadata        TEXT,                             -- JSON context
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_events_user ON auth_events(user_id);
CREATE INDEX IF NOT EXISTS idx_auth_events_type ON auth_events(event_type);
CREATE INDEX IF NOT EXISTS idx_auth_events_created ON auth_events(created_at);
`;

let singleton: DatabaseSync | null = null;

export function resetDb() {
  singleton?.close();
  singleton = null;
}

export function openDb(file?: string): DatabaseSync {
  if (!file && singleton) return singleton;
  if (!file) assertRuntimeConfig();
  const target = file ?? process.env.MOBILECLOUD_DB ?? join(dataRoot(), "mobilecloud.db");
  mkdirSync(dirname(target), { recursive: true });
  const db = new DatabaseSync(target);
  try {
    db.exec("PRAGMA busy_timeout = 4000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL;");
    db.exec("BEGIN IMMEDIATE");
    db.exec(SCHEMA);
    migrate(db);
    ensureConfiguredClients(db);
    if (!file) ensureOperator(db);
    db.exec("COMMIT");
    if (!file) singleton = db;
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function migrate(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS control_plane_migrations (version INTEGER PRIMARY KEY);`);
  if (!db.prepare("SELECT 1 FROM control_plane_migrations WHERE version = 1").get()) migrateCredentialBindings(db);
  if (!db.prepare("SELECT 1 FROM control_plane_migrations WHERE version = 2").get()) {
    db.exec(`
      ALTER TABLE pairing_sessions ADD COLUMN scan_hash TEXT;
      UPDATE pairing_sessions SET status = 'REVOKED', fail_reason = 'credential_upgrade'
        WHERE status IN ('SCANNED','AWAITING_APPROVAL','APPROVED');
      INSERT INTO control_plane_migrations (version) VALUES (2);
    `);
  }
  if (!db.prepare("SELECT 1 FROM control_plane_migrations WHERE version = 3").get()) {
    db.prepare(`UPDATE access_tokens SET expires_at = MIN(expires_at, ?)
      WHERE id IN (SELECT token_id FROM connected_devices WHERE token_id IS NOT NULL)`).run(Date.now() + 30 * 86_400_000);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_objects_key ON objects (owner_id, bucket, key);
      CREATE INDEX IF NOT EXISTS idx_requests_time ON requests (at);
      INSERT INTO control_plane_migrations (version) VALUES (3);
    `);
  }
  // v4 gives functions a stored handler source, lets workflows persist their
  // step list, so both can actually run instead of only being recorded.
  if (!db.prepare("SELECT 1 FROM control_plane_migrations WHERE version = 4").get()) {
    addColumns(db, "functions", { source: "TEXT" });
    addColumns(db, "workflows", { steps: "TEXT" });
    db.exec("INSERT INTO control_plane_migrations (version) VALUES (4)");
  }
  // v5 is the unified authentication system: passkey credentials, client-scoped
  // sessions, rotating refresh tokens, device grants and an audit trail. The
  // new tables are created by the schema above; only the ALTERs live here.
  if (!db.prepare("SELECT 1 FROM control_plane_migrations WHERE version = 5").get()) {
    addColumns(db, "sessions", {
      client_type: "TEXT DEFAULT 'web'",
      credential_id: "TEXT",
      ip_address: "TEXT",
      geo_location: "TEXT",
      last_active_at: "INTEGER",
    });
    addColumns(db, "access_tokens", {
      scope: "TEXT DEFAULT 'api:read'",
      client_type: "TEXT DEFAULT 'api'",
      session_id: "TEXT",
    });
    addColumns(db, "connected_devices", {
      hardware_public_key: "TEXT",
      hardware_security_level: "TEXT",
      push_token: "TEXT",
      push_platform: "TEXT",
    });
    addColumns(db, "users", {
      locked_until: "INTEGER",
      failed_attempts: "INTEGER NOT NULL DEFAULT 0",
      timezone: "TEXT",
    });
    // A passkey-only account has no password. The column is NOT NULL, so it
    // stores an explicit sentinel instead of a hash that could ever match.
    db.prepare("UPDATE users SET password_hash = ? WHERE password_hash = ''").run(NO_PASSWORD);
    db.exec("INSERT INTO control_plane_migrations (version) VALUES (5)");
  }
  // v6 turns the control plane into a standards-based identity provider: OIDC
  // clients and signing keys, SAML service providers, SCIM provisioning tokens,
  // and an active flag that deprovisions an account without erasing history.
  if (!db.prepare("SELECT 1 FROM control_plane_migrations WHERE version = 6").get()) {
    addColumns(db, "users", { active: "INTEGER NOT NULL DEFAULT 1" });
    addColumns(db, "oauth_authorization_codes", { nonce: "TEXT" });
    db.prepare(
      `INSERT INTO oauth_clients (client_id, name, secret_hash, redirect_uris, post_logout_redirect_uris,
         scopes, grant_types, public, backchannel_logout_uri, created_at)
       VALUES (?, ?, NULL, ?, '[]', ?, ?, 1, NULL, ?) ON CONFLICT(client_id) DO NOTHING`,
    ).run(
      "mobilecloud-cli",
      "MobileCloud CLI",
      JSON.stringify(["http://127.0.0.1/callback", "http://localhost/callback"]),
      "cli:full",
      "authorization_code refresh_token urn:ietf:params:oauth:grant-type:device_code",
      Date.now(),
    );
    db.exec("INSERT INTO control_plane_migrations (version) VALUES (6)");
  }
  // v7 records which client an access/refresh token was issued to (needed for
  // introspection and audience checks) and adds consent and federated links.
  if (!db.prepare("SELECT 1 FROM control_plane_migrations WHERE version = 7").get()) {
    addColumns(db, "access_tokens", { client_id: "TEXT" });
    addColumns(db, "refresh_tokens", { client_id: "TEXT" });
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_access_tokens_client ON access_tokens(client_id);
      CREATE INDEX IF NOT EXISTS idx_refresh_tokens_client ON refresh_tokens(client_id);
      INSERT INTO control_plane_migrations (version) VALUES (7);
    `);
  }
  // v8 makes the auth audit trail append-only at the database layer. The
  // application never deletes an event; this trigger proves it even if a future
  // query forgets. `UPDATE ... SET user_id = NULL` remains allowed for account
  // deletion, because the row's history must survive while the subject is gone.
  if (!db.prepare("SELECT 1 FROM control_plane_migrations WHERE version = 8").get()) {
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS auth_events_no_delete
      BEFORE DELETE ON auth_events
      BEGIN
        SELECT RAISE(ABORT, 'auth_events is append-only');
      END;
      INSERT INTO control_plane_migrations (version) VALUES (8);
    `);
  }
}

/** Adds a column only when the table does not already have it. */
function addColumns(db: DatabaseSync, table: string, columns: Record<string, string>) {
  const present = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
  for (const [name, type] of Object.entries(columns)) {
    if (!present.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
  }
}

function migrateCredentialBindings(db: DatabaseSync) {
  for (const [table, columns] of Object.entries({
    sessions: { id: "TEXT", user_agent: "TEXT", created_at: "INTEGER", csrf: "TEXT", device_id: "TEXT" },
    requests: { user_agent: "TEXT", host: "TEXT", ja4: "TEXT" },
    firewall_events: { user_agent: "TEXT", host: "TEXT", ja4: "TEXT" },
    projects: { repo_url: "TEXT" },
  })) {
    const present = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
    for (const [name, type] of Object.entries(columns)) {
      if (!present.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
    }
  }
  // Older sessions cannot be reliably attributed to a linked device. Require
  // every such session to sign in again, and retire in-flight legacy codes.
  db.exec(`
    DELETE FROM sessions;
    DELETE FROM device_codes;
    UPDATE pairing_sessions SET status = 'REVOKED', fail_reason = 'credential_upgrade'
      WHERE status IN ('WAITING_FOR_SCAN','SCANNED','AWAITING_APPROVAL','APPROVED');
    DELETE FROM access_tokens WHERE expires_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_sessions_device ON sessions (device_id);
    CREATE INDEX IF NOT EXISTS idx_requests_owner_at ON requests (owner_id, at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_device_codes_display ON device_codes (user_code);
  `);
  // Conservatively retire the old publicly seeded account, without embedding
  // its former password. An operator may recover it with explicit bootstrap env.
  const legacy = db.prepare("SELECT id FROM users WHERE email = ?").get("ashutosh@gmail.com") as { id: string } | undefined;
  if (legacy) {
    db.prepare("UPDATE users SET password_hash = 'reset-required' WHERE id = ?").run(legacy.id);
    db.prepare("DELETE FROM access_tokens WHERE owner_id = ?").run(legacy.id);
    db.prepare("UPDATE connected_devices SET revoked = 1, revoked_at = ? WHERE owner_id = ?").run(Date.now(), legacy.id);
    db.prepare("DELETE FROM webhooks WHERE owner_id = ?").run(legacy.id);
  }
  db.exec("INSERT INTO control_plane_migrations (version) VALUES (1)");
}

/**
 * Registers the first external relying party from configuration.
 *
 * FurlPay is an OIDC client, not a special code path: the environment only
 * supplies its id, exact redirect URI, scopes and logout endpoints. When the
 * switch is off nothing is written. Invalid configuration fails startup rather
 * than silently running without the integration.
 */
function ensureConfiguredClients(db: DatabaseSync) {
  if (!/^(1|true|yes|on)$/i.test((process.env.FURLPAY_OIDC_ENABLED ?? "").trim())) return;
  const redirect = (process.env.FURLPAY_OIDC_REDIRECT_URI ?? "").trim();
  if (!redirect || !isConfiguredRedirect(redirect)) {
    throw new Error("FURLPAY_OIDC_REDIRECT_URI must be an HTTPS URL (loopback HTTP is allowed in development)");
  }
  const clientId = (process.env.FURLPAY_OIDC_CLIENT_ID ?? "furlpay").trim() || "furlpay";
  if (!/^[A-Za-z0-9._-]{3,64}$/.test(clientId)) throw new Error("FURLPAY_OIDC_CLIENT_ID is not a valid client id");
  const secret = (process.env.FURLPAY_OIDC_CLIENT_SECRET ?? "").trim() || null;
  const scopes = (process.env.FURLPAY_OIDC_SCOPES ?? "openid profile email").trim();
  for (const scope of scopes.split(/\s+/)) {
    if (!/^[A-Za-z0-9:._-]{1,64}$/.test(scope)) throw new Error(`FURLPAY_OIDC_SCOPES contains an invalid scope: ${scope}`);
  }
  const postLogout = (process.env.FURLPAY_OIDC_POST_LOGOUT_REDIRECT_URI ?? "").trim();
  if (postLogout && !isConfiguredRedirect(postLogout)) {
    throw new Error("FURLPAY_OIDC_POST_LOGOUT_REDIRECT_URI must be an HTTPS URL");
  }
  const backchannel = (process.env.FURLPAY_OIDC_BACKCHANNEL_LOGOUT_URI ?? "").trim();
  if (backchannel && !/^https:\/\//.test(backchannel)) {
    throw new Error("FURLPAY_OIDC_BACKCHANNEL_LOGOUT_URI must be an HTTPS URL");
  }
  const now = Date.now();
  db.prepare(
    `INSERT INTO oauth_clients (client_id, name, secret_hash, redirect_uris, post_logout_redirect_uris,
       scopes, grant_types, public, backchannel_logout_uri, created_at)
     VALUES (?, 'FurlPay', ?, ?, ?, ?, 'authorization_code refresh_token', ?, ?, ?)
     ON CONFLICT(client_id) DO UPDATE SET
       name = excluded.name,
       secret_hash = excluded.secret_hash,
       redirect_uris = excluded.redirect_uris,
       post_logout_redirect_uris = excluded.post_logout_redirect_uris,
       scopes = excluded.scopes,
       public = excluded.public,
       backchannel_logout_uri = excluded.backchannel_logout_uri`,
  ).run(
    clientId,
    secret ? tokenHash(secret) : null,
    JSON.stringify([redirect]),
    JSON.stringify(postLogout ? [postLogout] : []),
    scopes,
    secret ? 0 : 1,
    backchannel || null,
    now,
  );
}

function isConfiguredRedirect(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.hash) return false;
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

/** Local operator provisioning only. No remotely callable setup and no password logs. */
function ensureOperator(db: DatabaseSync) {  const password = process.env.MOBILECLOUD_BOOTSTRAP_PASSWORD?.trim();
  if (!password) return;
  const email = (process.env.MOBILECLOUD_BOOTSTRAP_EMAIL?.trim() || "owner@mobilecloud.local").toLowerCase();
  if (!/^[^\s@]+@[^\s@]+$/.test(email) || email.length > 254 || password.length < 12 || password.length > 256 || isRetiredPassword(password)) {
    throw new Error("Invalid operator bootstrap configuration");
  }
  const reset = db.prepare("SELECT id FROM users WHERE email = ? AND password_hash = 'reset-required'").get(email) as { id: string } | undefined;
  if (reset) {
    db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hashPassword(password), reset.id);
  } else if (!db.prepare("SELECT 1 FROM users LIMIT 1").get()) {
    db.prepare("INSERT INTO users (id, email, name, password_hash, role, plan, created_at) VALUES (?, ?, 'Owner', ?, 'owner', 'community', ?)")
      .run(newId(), email, hashPassword(password), Date.now());
  }
}

/**
 * Sentinel stored in `users.password_hash` for accounts that authenticate with a
 * passkey only. It is not a hash and can never match a verifier result.
 */
export const NO_PASSWORD = "!";

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 32).toString("hex");
  return `${salt}:${hash}`;
}

export function isRetiredPassword(password: string): boolean {
  return tokenHash(password) === "477b79e5e6c6faff2f40c818304100c8e4d235cb0f2ba9551ce8cc79359227dc";
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const next = scryptSync(password, salt, 32);
  const prev = Buffer.from(hash, "hex");
  if (next.length !== prev.length) return false;
  return timingSafeEqual(next, prev);
}

export function newId(): string {
  return randomBytes(16).toString("hex");
}

export function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function dataRoot(): string {
  const root = process.env.MOBILECLOUD_DATA_ROOT
    ? resolve(process.env.MOBILECLOUD_DATA_ROOT)
    : process.env.MOBILECLOUD_DB ? dirname(resolve(process.env.MOBILECLOUD_DB)) : join(process.cwd(), "data");
  if (!existsSync(root)) mkdirSync(root, { recursive: true });
  return root;
}
