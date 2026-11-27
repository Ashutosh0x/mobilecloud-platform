import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { newId } from "./db.ts";
import { b64url, issueStepUpToken } from "./oidc.ts";
import { findClient } from "./oauth.ts";
import { verifyAssertion, type PasskeyConfig } from "./passkey.ts";

/**
 * WebAuthn step-up for financial and security-sensitive actions.
 *
 * The RP creates a challenge bound to one action and one exact payload, the
 * browser signs it with a passkey (user verification required by the existing
 * verifier), and only then is a short-lived, action-bound step-up token issued.
 * Verifying a token is the sole proof FurlPay may accept; an ordinary SSO
 * session never produces one.
 */

export const STEP_UP_ACTIONS = [
  "payment.initiate",
  "transfer.create",
  "withdrawal.create",
  "wallet.sign",
  "card.manage",
  "agent.spend",
  "limits.change",
  "security.change",
] as const;

export type StepUpAction = (typeof STEP_UP_ACTIONS)[number];

export class StepUpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Deterministic JSON so the same payload always produces the same hash. */
export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

export function payloadHash(payload: unknown): string {
  return createHash("sha256").update(stableJson(payload)).digest("hex");
}

export function isStepUpAction(value: string): value is StepUpAction {
  return (STEP_UP_ACTIONS as readonly string[]).includes(value);
}

export type StepUpChallenge = {
  challengeId: string;
  publicKey: Record<string, unknown>;
  expiresInMs: number;
};

/** Starts a step-up ceremony for an authenticated user and client. */
export function createStepUp(
  db: DatabaseSync,
  config: PasskeyConfig,
  input: { userId: string; clientId: string; action: string; payload: unknown },
): StepUpChallenge {
  if (!isStepUpAction(input.action)) throw new StepUpError(400, "That action cannot be step-up authorized.");
  if (input.clientId !== "mobilecloud-console" && !findClient(db, input.clientId)) {
    throw new StepUpError(400, "That client is not registered.");
  }
  const credentials = db.prepare("SELECT id FROM credentials WHERE user_id = ?").all(input.userId) as { id: string }[];
  if (!credentials.length) throw new StepUpError(409, "This account has no passkey. Register one in FurlPay first.");
  const raw = randomBytes(32);
  const now = Date.now();
  const id = newId();
  const ttl = 5 * 60_000;
  db.prepare(
    `INSERT INTO step_up_challenges (id, user_id, client_id, action, payload_hash, challenge_hex, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, input.userId, input.clientId, input.action, payloadHash(input.payload), raw.toString("hex"), now, now + ttl);
  return {
    challengeId: id,
    expiresInMs: ttl,
    publicKey: {
      challenge: b64url(raw),
      rpId: config.rpId,
      timeout: ttl,
      userVerification: "required",
      allowCredentials: credentials.map((credential) => ({ type: "public-key", id: credential.id })),
    },
  };
}

export type StepUpResult = {
  token: string;
  expiresAt: number;
  action: StepUpAction;
  userId: string;
  credentialId: string;
};

/** Verifies the assertion against the challenge, payload and account. */
export function verifyStepUp(
  db: DatabaseSync,
  config: PasskeyConfig,
  input: { challengeId: string; credential: unknown; payload: unknown },
): StepUpResult {
  const row = db.prepare(
    "SELECT id, user_id, client_id, action, payload_hash, challenge_hex, expires_at, used_at FROM step_up_challenges WHERE id = ?",
  ).get(input.challengeId) as
    | {
        id: string;
        user_id: string;
        client_id: string;
        action: string;
        payload_hash: string;
        challenge_hex: string;
        expires_at: number;
        used_at: number | null;
      }
    | undefined;
  if (!row) throw new StepUpError(404, "That step-up request is unknown.");
  if (row.used_at) throw new StepUpError(409, "That step-up request was already used.");
  if (row.expires_at <= Date.now()) throw new StepUpError(410, "That step-up request expired.");
  if (payloadHash(input.payload) !== row.payload_hash) {
    throw new StepUpError(400, "The approved payload does not match what is being executed.");
  }

  let asserted;
  try {
    asserted = verifyAssertion(db, config, { credential: input.credential, expectedChallengeHex: row.challenge_hex });
  } catch (error) {
    throw new StepUpError(401, error instanceof Error ? error.message : "The passkey assertion did not verify.");
  }
  if (asserted.userId !== row.user_id) {
    throw new StepUpError(403, "That passkey belongs to a different account.");
  }

  const consumed = db.prepare("UPDATE step_up_challenges SET used_at = ? WHERE id = ? AND used_at IS NULL").run(Date.now(), row.id);
  if (Number(consumed.changes) !== 1) throw new StepUpError(409, "That step-up request was already used.");

  const issued = issueStepUpToken(db, {
    origin: config.origin,
    clientId: row.client_id,
    userId: row.user_id,
    action: row.action,
    payloadHash: row.payload_hash,
    credentialId: asserted.credentialId,
  });
  return {
    token: issued.token,
    expiresAt: issued.expiresAt,
    action: row.action as StepUpAction,
    userId: row.user_id,
    credentialId: asserted.credentialId,
  };
}
