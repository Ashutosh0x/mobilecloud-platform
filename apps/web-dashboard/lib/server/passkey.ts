import { createHash, createPublicKey, randomBytes, verify as cryptoVerify } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { CborMap, cborDecode, type CborValue } from "./cbor.ts";
import { newId, tokenHash } from "./db.ts";
import { tx } from "./events.ts";

/**
 * The WebAuthn relying party for MobileCloud.
 *
 * A passkey is the primary credential: the authenticator holds the private
 * key, the account holds only the public key, and every login is a signed
 * challenge. This module owns the two ceremonies (registration and
 * authentication) and the challenge store that binds them together.
 *
 * What is verified on every assertion:
 *   1. `clientDataJSON.type` is the expected ceremony;
 *   2. `clientDataJSON.challenge` hashes to the challenge issued for this
 *      ceremony (a replayed assertion can never be redeemed twice);
 *   3. `clientDataJSON.origin` is this relying party — or the Android
 *      `android:apk-key-hash:` form an app attestation produces;
 *   4. `authenticatorData.rpIdHash` is the SHA-256 of the relying party id;
 *   5. the user-present and user-verified flags are set;
 *   6. the signature over `authenticatorData || SHA-256(clientDataJSON)`
 *      verifies against the stored public key.
 */

const CHALLENGE_TTL_MS = 5 * 60_000;
const CHALLENGE_BYTES = 32;

/** COSE algorithm identifiers this relying party advertises and accepts. */
const ES256 = -7;
const RS256 = -257;
const EDDSA = -8;

export type PasskeyConfig = {
  /** Relying party id, e.g. `console.example.com`. */
  rpId: string;
  /** Human readable relying party name shown by the authenticator. */
  rpName: string;
  /** Expected `clientDataJSON.origin`, e.g. `https://console.example.com`. */
  origin: string;
};

export type RegistrationOptions = {
  challenge_id: string;
  publicKey: Record<string, unknown>;
};

export type AuthenticationOptions = {
  challenge_id: string;
  publicKey: Record<string, unknown>;
};

export type RegistrationResult = {
  userId: string;
  credentialId: string;
  aaguid: string | null;
  transports: string[];
  backedUp: boolean;
};

export type AuthenticationResult = {
  userId: string;
  credentialId: string;
  signCount: number;
  userVerified: boolean;
};

export class PasskeyError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function sha256(value: Buffer): Buffer {
  return createHash("sha256").update(value).digest();
}

function b64url(value: Buffer): string {
  return value.toString("base64url");
}

function fromB64url(value: string): Buffer {
  return Buffer.from(value, "base64url");
}

/** The random per-ceremony challenge. Only its hash is persisted. */
function newChallenge(): { raw: Buffer; hash: string } {
  const raw = randomBytes(CHALLENGE_BYTES);
  return { raw, hash: tokenHash(b64url(raw)) };
}

/**
 * Stores an in-flight ceremony. The challenge is stored hashed, so a database
 * leak cannot be replayed against the server.
 */
function storeChallenge(
  db: DatabaseSync,
  row: {
    kind: "register" | "authenticate";
    challengeHash: string;
    userId: string | null;
    email?: string | null;
    displayName?: string | null;
    rpId: string;
    origin: string;
    credentialIds?: string[];
    deviceName?: string | null;
    devicePlatform?: string | null;
  },
): string {
  const id = newId();
  db.prepare(
    `INSERT INTO webauthn_challenges (id, challenge_hash, kind, user_id, email, display_name, rp_id, origin,
       credential_ids, device_name, device_platform, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    row.challengeHash,
    row.kind,
    row.userId,
    row.email ?? null,
    row.displayName ?? null,
    row.rpId,
    row.origin,
    row.credentialIds ? JSON.stringify(row.credentialIds) : null,
    row.deviceName ?? null,
    row.devicePlatform ?? null,
    Date.now(),
    Date.now() + CHALLENGE_TTL_MS,
  );
  return id;
}

/** Reads and consumes an in-flight ceremony. A challenge is single use. */
function takeChallenge(
  db: DatabaseSync,
  id: string,
  kind: "register" | "authenticate",
): {
  challengeHash: string;
  userId: string | null;
  email: string | null;
  displayName: string | null;
  rpId: string;
  origin: string;
  credentialIds: string[];
  deviceName: string | null;
  devicePlatform: string | null;
} | null {
  return tx(db, () => {
    const row = db.prepare(
      "SELECT challenge_hash, kind, user_id, email, display_name, rp_id, origin, credential_ids, device_name, device_platform, expires_at FROM webauthn_challenges WHERE id = ?",
    ).get(id) as {
      challenge_hash: string;
      kind: string;
      user_id: string | null;
      email: string | null;
      display_name: string | null;
      rp_id: string;
      origin: string;
      credential_ids: string | null;
      device_name: string | null;
      device_platform: string | null;
      expires_at: number;
    } | undefined;
    if (!row) return null;
    db.prepare("DELETE FROM webauthn_challenges WHERE id = ?").run(id);
    if (row.kind !== kind) throw new PasskeyError(400, "That request does not match this challenge.");
    if (row.expires_at <= Date.now()) throw new PasskeyError(400, "That challenge expired. Start again.");
    let credentialIds: string[] = [];
    if (row.credential_ids) {
      try {
        const parsed = JSON.parse(row.credential_ids);
        if (Array.isArray(parsed)) credentialIds = parsed.filter((entry) => typeof entry === "string");
      } catch { /* an unreadable list means "no restriction" */ }
    }
    return {
      challengeHash: row.challenge_hash,
      userId: row.user_id,
      email: row.email,
      displayName: row.display_name,
      rpId: row.rp_id,
      origin: row.origin,
      credentialIds,
      deviceName: row.device_name,
      devicePlatform: row.device_platform,
    };
  });
}

/**
 * Turn `clientDataJSON` into the bytes the authenticator actually signed.
 *
 * In the WebAuthn JSON serialization — what browsers and Android Credential
 * Manager send — `clientDataJSON` is base64url of a UTF-8 JSON document, not
 * the document itself. A native caller may also hand over the decoded text.
 * Both forms are accepted, but a value that is neither is rejected, and the
 * signature is always checked over the decoded bytes.
 */
function decodeClientData(raw: string): Buffer {
  const value = raw.trim();
  if (value.startsWith("{")) return Buffer.from(value, "utf8");
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(value)) {
    throw new PasskeyError(400, "The authenticator returned malformed client data.");
  }
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length === 0 || bytes[0] !== 0x7b) {
    throw new PasskeyError(400, "The authenticator returned malformed client data.");
  }
  return bytes;
}

/** Reads the `clientDataJSON` envelope and checks type, challenge and origin. */
function verifyClientData(
  raw: string,
  expectedType: "webauthn.create" | "webauthn.get",
  expectedChallengeHash: string,
  expectedOrigin: string,
): Buffer {
  const bytes = decodeClientData(raw);
  let parsed: { type?: unknown; challenge?: unknown; origin?: unknown };
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new PasskeyError(400, "The authenticator returned malformed client data.");
  }
  if (parsed.type !== expectedType) throw new PasskeyError(400, "The authenticator returned the wrong ceremony.");
  if (typeof parsed.challenge !== "string") throw new PasskeyError(400, "The authenticator returned no challenge.");
  if (tokenHash(parsed.challenge) !== expectedChallengeHash) {
    throw new PasskeyError(400, "That challenge does not match this request.");
  }
  if (typeof parsed.origin !== "string") throw new PasskeyError(400, "The authenticator returned no origin.");
  // An Android app calling Credential Manager reports an app attestation
  // origin instead of the web origin. Anything else must match exactly.
  const androidOrigin = parsed.origin.startsWith("android:apk-key-hash:");
  if (!androidOrigin && parsed.origin !== expectedOrigin) {
    throw new PasskeyError(400, "That request came from a different origin.");
  }
  return sha256(bytes);
}

/** The authenticator data: relying party hash, flags, counter and attested key. */
type AuthenticatorData = {
  rpIdHash: Buffer;
  userPresent: boolean;
  userVerified: boolean;
  attested: boolean;
  backedUp: boolean;
  signCount: number;
  aaguid: Buffer | null;
  credentialId: Buffer | null;
  coseKey: CborMap | null;
};

function parseAuthenticatorData(data: Buffer): AuthenticatorData {
  if (data.length < 37) throw new PasskeyError(400, "The authenticator returned truncated data.");
  const flags = data[32];
  const result: AuthenticatorData = {
    rpIdHash: data.subarray(0, 32),
    userPresent: (flags & 0x01) !== 0,
    userVerified: (flags & 0x04) !== 0,
    attested: (flags & 0x40) !== 0,
    // A credential is "backed up" only when it is eligible and currently backed up.
    backedUp: (flags & 0x08) !== 0 && (flags & 0x10) !== 0,
    signCount: data.readUInt32BE(33),
    aaguid: null,
    credentialId: null,
    coseKey: null,
  };
  if ((flags & 0x80) !== 0) {
    throw new PasskeyError(400, "The authenticator returned unsupported extension data.");
  }
  if (result.attested) {
    if (data.length < 55) throw new PasskeyError(400, "The authenticator returned truncated attested data.");
    const aaguid = data.subarray(37, 53);
    const idLength = data.readUInt16BE(53);
    if (data.length < 55 + idLength) throw new PasskeyError(400, "The authenticator returned a truncated credential id.");
    const credentialId = data.subarray(55, 55 + idLength);
    const keyBytes = data.subarray(55 + idLength);
    const decoded = cborDecode(keyBytes);
    if (!(decoded instanceof CborMap)) throw new PasskeyError(400, "The authenticator returned an invalid public key.");
    result.aaguid = aaguid;
    result.credentialId = credentialId;
    result.coseKey = decoded;
  }
  return result;
}

/** Converts a COSE_Key into a JWK this runtime can verify with. */
function coseToJwk(key: CborMap): { jwk: Record<string, unknown>; alg: number } {
  const kty = key.positive(1);
  const alg = key.positive(3);
  if (typeof alg !== "number") throw new PasskeyError(400, "The authenticator returned an unsigned public key.");
  if (kty === 2) {
    const crv = key.negative(1);
    const x = key.negative(2);
    const y = key.negative(3);
    if (crv !== 1 || !(x instanceof Buffer) || !(y instanceof Buffer)) {
      throw new PasskeyError(400, "The authenticator returned an unsupported elliptic curve.");
    }
    return { jwk: { kty: "EC", crv: "P-256", x: b64url(x), y: b64url(y) }, alg };
  }
  if (kty === 3) {
    const n = key.negative(1);
    const e = key.negative(2);
    if (!(n instanceof Buffer) || !(e instanceof Buffer)) {
      throw new PasskeyError(400, "The authenticator returned an invalid RSA key.");
    }
    return { jwk: { kty: "RSA", n: b64url(n), e: b64url(e) }, alg };
  }
  if (kty === 1) {
    const crv = key.negative(1);
    const x = key.negative(2);
    if (crv !== 6 || !(x instanceof Buffer)) {
      throw new PasskeyError(400, "The authenticator returned an unsupported key type.");
    }
    return { jwk: { kty: "OKP", crv: "Ed25519", x: b64url(x) }, alg };
  }
  throw new PasskeyError(400, "The authenticator returned an unsupported key type.");
}

/** Verifies a WebAuthn signature with the algorithm the credential advertises. */
function verifySignature(alg: number, jwk: Record<string, unknown>, data: Buffer, signature: Buffer): boolean {
  let key;
  try {
    key = createPublicKey({ key: jwk as never, format: "jwk" });
  } catch {
    throw new PasskeyError(400, "The stored public key could not be read.");
  }
  try {
    if (alg === ES256) {
      // WebAuthn transmits ECDSA signatures in DER, which is also Node's default.
      return cryptoVerify("sha256", data, { key, dsaEncoding: "der" }, signature);
    }
    if (alg === RS256) return cryptoVerify("sha256", data, key, signature);
    if (alg === EDDSA) return cryptoVerify(null, data, key, signature);
  } catch {
    return false;
  }
  throw new PasskeyError(400, "The authenticator used an unsupported signature algorithm.");
}

/** The credential material a client sends back, in the shape Credential Manager uses. */
export type CredentialResponse = {
  id: string;
  type?: string;
  response: {
    clientDataJSON: string;
    authenticatorData?: string;
    attestationObject?: string;
    signature?: string;
    userHandle?: string | null;
    transports?: string[];
  };
};

function readCredential(input: unknown): CredentialResponse {
  const value = input as CredentialResponse | undefined;
  if (!value || typeof value !== "object" || typeof value.id !== "string" || !value.response) {
    throw new PasskeyError(400, "The authenticator returned no credential.");
  }
  return value;
}

/**
 * Starts a registration ceremony.
 *
 * The caller must already know which account the passkey belongs to: either
 * the request carries an authenticated session, or it proves the account with
 * its password. A passkey never bootstraps an account on its own.
 */
export function beginRegistration(
  db: DatabaseSync,
  config: PasskeyConfig,
  input: { userId: string; email: string; displayName: string; deviceName?: string | null; devicePlatform?: string | null },
): RegistrationOptions {
  const { raw, hash } = newChallenge();
  const challengeId = storeChallenge(db, {
    kind: "register",
    challengeHash: hash,
    userId: input.userId,
    email: input.email,
    displayName: input.displayName,
    rpId: config.rpId,
    origin: config.origin,
    deviceName: input.deviceName ?? null,
    devicePlatform: input.devicePlatform ?? null,
  });
  return {
    challenge_id: challengeId,
    publicKey: {
      challenge: b64url(raw),
      rp: { id: config.rpId, name: config.rpName },
      user: {
        id: b64url(Buffer.from(input.userId, "hex")),
        name: input.email,
        displayName: input.displayName,
      },
      pubKeyCredParams: [
        { type: "public-key", alg: ES256 },
        { type: "public-key", alg: RS256 },
        { type: "public-key", alg: EDDSA },
      ],
      timeout: CHALLENGE_TTL_MS,
      authenticatorSelection: {
        residentKey: "required",
        requireResidentKey: true,
        userVerification: "required",
      },
      attestation: "none",
    },
  };
}

/**
 * Completes a registration ceremony and stores the credential.
 *
 * The authenticator data is parsed for the credential id and the COSE public
 * key. The attestation statement itself is not trusted: this relying party
 * asks for `attestation: "none"`, so it stores no attestation chain.
 */
export function finishRegistration(
  db: DatabaseSync,
  config: PasskeyConfig,
  input: { challengeId: string; credential: unknown },
): RegistrationResult {
  const challenge = takeChallenge(db, input.challengeId, "register");
  if (!challenge) throw new PasskeyError(400, "That challenge is unknown. Start again.");
  if (!challenge.userId) throw new PasskeyError(400, "That challenge is not bound to an account.");

  const credential = readCredential(input.credential);
  const clientDataJSON = credential.response.clientDataJSON;
  if (typeof clientDataJSON !== "string") throw new PasskeyError(400, "The authenticator returned no client data.");
  const clientDataHash = verifyClientData(clientDataJSON, "webauthn.create", challenge.challengeHash, challenge.origin);

  const attestationObject = credential.response.attestationObject;
  if (typeof attestationObject !== "string") throw new PasskeyError(400, "The authenticator returned no attestation.");
  let attestation: CborValue;
  try {
    attestation = cborDecode(Buffer.from(attestationObject, "base64url"));
  } catch {
    throw new PasskeyError(400, "The authenticator returned a malformed attestation object.");
  }
  if (!(attestation instanceof CborMap)) throw new PasskeyError(400, "The authenticator returned a malformed attestation object.");
  const authData = attestation.get("authData");
  if (!(authData instanceof Buffer)) throw new PasskeyError(400, "The authenticator returned no authenticator data.");

  const parsed = parseAuthenticatorData(authData);
  if (!parsed.rpIdHash.equals(sha256(Buffer.from(config.rpId)))) {
    throw new PasskeyError(400, "That credential belongs to a different site.");
  }
  if (!parsed.userPresent) throw new PasskeyError(400, "The authenticator did not confirm a user was present.");
  if (!parsed.attested || !parsed.credentialId || !parsed.coseKey) {
    throw new PasskeyError(400, "The authenticator returned no credential to store.");
  }

  const { jwk, alg } = coseToJwk(parsed.coseKey);
  if (![ES256, RS256, EDDSA].includes(alg)) throw new PasskeyError(400, "The authenticator used an unsupported algorithm.");
  // The algorithm travels with the key, so verification never has to guess it.
  const storedKey = { ...jwk, alg };
  // Prove the key is usable before storing it, so a broken credential is
  // rejected at registration instead of at the first login.
  try {
    createPublicKey({ key: jwk as never, format: "jwk" });
  } catch {
    throw new PasskeyError(400, "The authenticator returned an unusable public key.");
  }

  const credentialId = b64url(parsed.credentialId);
  const aaguid = b64url(parsed.aaguid ?? Buffer.alloc(16));
  const transports = Array.isArray(credential.response.transports)
    ? credential.response.transports.filter((entry) => typeof entry === "string").slice(0, 8)
    : [];

  tx(db, () => {
    db.prepare(
      `INSERT INTO credentials (id, user_id, credential_type, public_key, sign_count, transports, aaguid, device_name, backed_up, created_at)
       VALUES (?, ?, 'passkey', ?, 0, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET user_id = excluded.user_id, public_key = excluded.public_key,
         transports = excluded.transports, aaguid = excluded.aaguid, device_name = excluded.device_name,
         backed_up = excluded.backed_up, last_used_at = NULL`,
    ).run(
      credentialId,
      challenge.userId,
      Buffer.from(JSON.stringify(storedKey)),
      transports.join(","),
      aaguid,
      challenge.deviceName ?? null,
      parsed.backedUp ? 1 : 0,
      Date.now(),
    );
  });

  return {
    userId: challenge.userId,
    credentialId,
    aaguid,
    transports,
    backedUp: parsed.backedUp,
  };
}

/**
 * Starts an authentication ceremony.
 *
 * With no email the ceremony is discoverable: the authenticator offers any
 * passkey it holds for this relying party. With an email the ceremony names
 * the account's credentials, which avoids a passkey belonging to another
 * account being accepted here.
 */
export function beginAuthentication(
  db: DatabaseSync,
  config: PasskeyConfig,
  input: { userId?: string | null; email?: string | null; deviceName?: string | null; devicePlatform?: string | null },
): AuthenticationOptions {
  const { raw, hash } = newChallenge();
  let userId = input.userId ?? null;
  if (!userId && input.email) {
    const row = db.prepare("SELECT id FROM users WHERE email = ?").get(input.email.toLowerCase()) as { id: string } | undefined;
    userId = row?.id ?? null;
  }
  const credentialIds = userId
    ? (db.prepare("SELECT id FROM credentials WHERE user_id = ?").all(userId) as { id: string }[]).map((row) => row.id)
    : [];
  const challengeId = storeChallenge(db, {
    kind: "authenticate",
    challengeHash: hash,
    userId,
    email: input.email ?? null,
    rpId: config.rpId,
    origin: config.origin,
    credentialIds,
    deviceName: input.deviceName ?? null,
    devicePlatform: input.devicePlatform ?? null,
  });
  const allowCredentials = credentialIds.map((id) => ({ type: "public-key", id }));
  return {
    challenge_id: challengeId,
    publicKey: {
      challenge: b64url(raw),
      rpId: config.rpId,
      timeout: CHALLENGE_TTL_MS,
      userVerification: "required",
      ...(allowCredentials.length ? { allowCredentials } : {}),
    },
  };
}

/**
 * Completes an authentication ceremony.
 *
 * The stored credential must belong to the account the ceremony was started
 * for, so a passkey from one account can never authenticate another.
 */
export function finishAuthentication(
  db: DatabaseSync,
  config: PasskeyConfig,
  input: { challengeId: string; credential: unknown },
): AuthenticationResult {
  const challenge = takeChallenge(db, input.challengeId, "authenticate");
  if (!challenge) throw new PasskeyError(400, "That challenge is unknown. Start again.");

  const credential = readCredential(input.credential);
  const clientDataJSON = credential.response.clientDataJSON;
  const authenticatorData = credential.response.authenticatorData;
  const signature = credential.response.signature;
  if (typeof clientDataJSON !== "string" || typeof authenticatorData !== "string" || typeof signature !== "string") {
    throw new PasskeyError(400, "The authenticator returned an incomplete assertion.");
  }
  const clientDataHash = verifyClientData(clientDataJSON, "webauthn.get", challenge.challengeHash, challenge.origin);

  const authData = Buffer.from(authenticatorData, "base64url");
  const parsed = parseAuthenticatorData(authData);
  if (!parsed.rpIdHash.equals(sha256(Buffer.from(config.rpId)))) {
    throw new PasskeyError(400, "That assertion belongs to a different site.");
  }
  if (!parsed.userPresent) throw new PasskeyError(400, "The authenticator did not confirm a user was present.");
  if (!parsed.userVerified) throw new PasskeyError(400, "The authenticator did not verify the user.");

  const credentialId = credential.id;
  const stored = db.prepare(
    "SELECT id, user_id, public_key, sign_count FROM credentials WHERE id = ?",
  ).get(credentialId) as { id: string; user_id: string; public_key: string | Buffer; sign_count: number } | undefined;
  if (!stored) throw new PasskeyError(400, "That credential is not registered.");
  if (challenge.userId && stored.user_id !== challenge.userId) {
    throw new PasskeyError(400, "That credential belongs to a different account.");
  }
  if (challenge.credentialIds.length && !challenge.credentialIds.includes(credentialId)) {
    throw new PasskeyError(400, "That credential was not offered for this request.");
  }

  let jwk: Record<string, unknown>;
  try {
    jwk = JSON.parse(Buffer.from(stored.public_key as Buffer).toString("utf8"));
  } catch {
    throw new PasskeyError(400, "The stored credential could not be read.");
  }
  const signed = Buffer.concat([authData, clientDataHash]);
  if (!verifySignature((jwk.alg as number) ?? ES256, jwk, signed, Buffer.from(signature, "base64url"))) {
    throw new PasskeyError(401, "That signature did not verify.");
  }

  // A counter that moves backwards means a cloned authenticator. Counters that
  // stay at zero are ignored, because some authenticators never increment it.
  if (stored.sign_count > 0 && parsed.signCount > 0 && parsed.signCount <= stored.sign_count) {
    throw new PasskeyError(401, "That credential was already used. Sign in again.");
  }

  tx(db, () => {
    db.prepare("UPDATE credentials SET sign_count = ?, last_used_at = ? WHERE id = ?").run(parsed.signCount, Date.now(), credentialId);
  });

  return {
    userId: stored.user_id,
    credentialId,
    signCount: parsed.signCount,
    userVerified: parsed.userVerified,
  };
}

/**
 * Verifies a passkey assertion against a challenge this caller owns.
 *
 * The QR login flow needs this: the browser generated the challenge, the
 * phone signed it with a passkey, and the server has no ceremony of its own
 * to redeem. The account is the one the passkey belongs to, so the credential
 * itself names the account that is signing in.
 */
export function verifyAssertion(
  db: DatabaseSync,
  config: PasskeyConfig,
  input: { credential: unknown; expectedChallengeHex: string; expectedOrigin?: string },
): { userId: string; credentialId: string; signCount: number } {
  const credential = readCredential(input.credential);
  const clientDataJSON = credential.response.clientDataJSON;
  const authenticatorData = credential.response.authenticatorData;
  const signature = credential.response.signature;
  if (typeof clientDataJSON !== "string" || typeof authenticatorData !== "string" || typeof signature !== "string") {
    throw new PasskeyError(400, "The authenticator returned an incomplete assertion.");
  }

  // The challenge travels as base64url in client data and as hex in the QR
  // code, so both forms are compared against the same bytes.
  const clientDataBytes = decodeClientData(clientDataJSON);
  let parsed: { type?: unknown; challenge?: unknown; origin?: unknown };
  try {
    parsed = JSON.parse(clientDataBytes.toString("utf8"));
  } catch {
    throw new PasskeyError(400, "The authenticator returned malformed client data.");
  }
  if (parsed.type !== "webauthn.get") throw new PasskeyError(400, "The authenticator returned the wrong ceremony.");
  if (typeof parsed.challenge !== "string") throw new PasskeyError(400, "The authenticator returned no challenge.");
  if (fromB64url(parsed.challenge).toString("hex") !== input.expectedChallengeHex.toLowerCase()) {
    throw new PasskeyError(400, "That assertion was made for a different request.");
  }
  const origin = input.expectedOrigin ?? config.origin;
  if (typeof parsed.origin !== "string") throw new PasskeyError(400, "The authenticator returned no origin.");
  if (!parsed.origin.startsWith("android:apk-key-hash:") && parsed.origin !== origin) {
    throw new PasskeyError(400, "That request came from a different origin.");
  }

  const authData = Buffer.from(authenticatorData, "base64url");
  const parsedAuth = parseAuthenticatorData(authData);
  if (!parsedAuth.rpIdHash.equals(sha256(Buffer.from(config.rpId)))) {
    throw new PasskeyError(400, "That assertion belongs to a different site.");
  }
  if (!parsedAuth.userPresent) throw new PasskeyError(400, "The authenticator did not confirm a user was present.");
  if (!parsedAuth.userVerified) throw new PasskeyError(400, "The authenticator did not verify the user.");

  const stored = db.prepare("SELECT id, user_id, public_key, sign_count FROM credentials WHERE id = ?").get(credential.id) as {
    id: string;
    user_id: string;
    public_key: string | Buffer;
    sign_count: number;
  } | undefined;
  if (!stored) throw new PasskeyError(400, "That credential is not registered.");

  let jwk: Record<string, unknown>;
  try {
    jwk = JSON.parse(Buffer.from(stored.public_key as Buffer).toString("utf8"));
  } catch {
    throw new PasskeyError(400, "The stored credential could not be read.");
  }
  const clientDataHash = sha256(clientDataBytes);
  const signed = Buffer.concat([authData, clientDataHash]);
  if (!verifySignature((jwk.alg as number) ?? ES256, jwk, signed, Buffer.from(signature, "base64url"))) {
    throw new PasskeyError(401, "That signature did not verify.");
  }
  if (stored.sign_count > 0 && parsedAuth.signCount > 0 && parsedAuth.signCount <= stored.sign_count) {
    throw new PasskeyError(401, "That credential was already used. Sign in again.");
  }
  tx(db, () => {
    db.prepare("UPDATE credentials SET sign_count = ?, last_used_at = ? WHERE id = ?").run(parsedAuth.signCount, Date.now(), credential.id);
  });
  return { userId: stored.user_id, credentialId: stored.id, signCount: parsedAuth.signCount };
}

/** Lists the passkeys registered for an account. */
export function listCredentials(db: DatabaseSync, userId: string) {
  return db.prepare(
    "SELECT id, device_name AS deviceName, transports, aaguid, backed_up AS backedUp, created_at AS createdAt, last_used_at AS lastUsedAt FROM credentials WHERE user_id = ? ORDER BY created_at DESC",
  ).all(userId);
}

/** Removes a passkey. The account keeps its other credentials. */
export function deleteCredential(db: DatabaseSync, userId: string, credentialId: string): boolean {
  const result = db.prepare("DELETE FROM credentials WHERE id = ? AND user_id = ?").run(credentialId, userId);
  return Number(result.changes) > 0;
}
