import { randomBytes } from "node:crypto";
import type { FederatedIdentity } from "./linking.ts";

/**
 * FurlPay's own application session.
 *
 * It is created after the federated identity is resolved, and it is owned by
 * FurlPay. The IdP tokens are not the session and are not used for financial
 * authorization. A FurlPay session can be ended without touching the user's
 * MobileCloud session, and vice versa.
 */

export type FurlPaySession = {
  id: string;
  accountId: string;
  authentication: "federated";
  identity: { issuer: string; subject: string };
  createdAt: number;
  expiresAt: number;
  /** Financial operations always require a separate FurlPay step-up. */
  financialStepUp: false;
};

export function createFurlPaySession(
  accountId: string,
  identity: FederatedIdentity,
  options: { ttlMs?: number; now?: () => number } = {},
): FurlPaySession {
  const now = options.now ?? (() => Date.now());
  const ttlMs = options.ttlMs ?? 8 * 3_600_000;
  const createdAt = now();
  return {
    id: randomBytes(32).toString("base64url"),
    accountId,
    authentication: "federated",
    identity: { issuer: identity.issuer, subject: identity.subject },
    createdAt,
    expiresAt: createdAt + ttlMs,
    financialStepUp: false,
  };
}
