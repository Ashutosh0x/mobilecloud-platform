import { createHash, randomBytes } from "node:crypto";

/** PKCE (RFC 7636) and the opaque values that protect the authorization request. */
export function createPkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** A state value is single-use at the relying party; this only creates it. */
export function createState(): string {
  return randomToken(32);
}

export function createNonce(): string {
  return randomToken(32);
}
