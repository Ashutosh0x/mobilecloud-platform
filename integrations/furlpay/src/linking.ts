import { randomBytes } from "node:crypto";

/**
 * Account linking for FurlPay.
 *
 * Rules, in order of importance:
 *   1. The identity key is `(issuer, subject)`. Email is display data only.
 *   2. An existing FurlPay account is never merged silently because an email
 *      matches. The user must be signed in to that FurlPay account and approve
 *      the link explicitly.
 *   3. A pending link is single use, short lived and bound to both the
 *      federated identity and the local account that approved it.
 */

export type FederatedIdentity = {
  issuer: string;
  subject: string;
  email?: string | null;
};

export type FurlPayAccount = {
  id: string;
  email: string;
  displayName?: string;
};

export type IdentityLink = {
  accountId: string;
  issuer: string;
  subject: string;
  email?: string | null;
  linkedAt: number;
};

export interface IdentityLinkStore {
  findByIdentity(issuer: string, subject: string): IdentityLink | null;
  findByAccount(accountId: string): IdentityLink | null;
  create(link: IdentityLink): void;
  delete(accountId: string): boolean;
}

export class MemoryIdentityLinkStore implements IdentityLinkStore {
  private byIdentity = new Map<string, IdentityLink>();
  private byAccount = new Map<string, IdentityLink>();

  private key(issuer: string, subject: string): string {
    return `${issuer}\u0000${subject}`;
  }

  findByIdentity(issuer: string, subject: string): IdentityLink | null {
    return this.byIdentity.get(this.key(issuer, subject)) ?? null;
  }

  findByAccount(accountId: string): IdentityLink | null {
    return this.byAccount.get(accountId) ?? null;
  }

  create(link: IdentityLink): void {
    const key = this.key(link.issuer, link.subject);
    if (this.byIdentity.has(key)) throw new Error("That identity is already linked");
    if (this.byAccount.has(link.accountId)) throw new Error("That account is already linked to another identity");
    this.byIdentity.set(key, link);
    this.byAccount.set(link.accountId, link);
  }

  delete(accountId: string): boolean {
    const link = this.byAccount.get(accountId);
    if (!link) return false;
    this.byAccount.delete(accountId);
    this.byIdentity.delete(this.key(link.issuer, link.subject));
    return true;
  }
}

export type LinkResolution =
  | { status: "linked"; accountId: string }
  | { status: "link_required"; pendingToken: string }
  | { status: "create_account" };

type Pending = {
  identity: FederatedIdentity;
  accountId: string;
  expiresAt: number;
  used: boolean;
};

export function createAccountLinkingService(
  store: IdentityLinkStore,
  options: { now?: () => number; ttlMs?: number } = {},
) {
  const now = options.now ?? (() => Date.now());
  const ttlMs = options.ttlMs ?? 5 * 60_000;
  const pending = new Map<string, Pending>();

  function issue(identity: FederatedIdentity, accountId: string): string {
    const token = randomBytes(32).toString("base64url");
    pending.set(token, { identity, accountId, expiresAt: now() + ttlMs, used: false });
    return token;
  }

  return {
    /**
     * Resolves a federated identity against FurlPay's own accounts.
     *
     * `localAccount` is the account the user is *already signed in to* at
     * FurlPay, or null for a first-time visitor. The caller must never supply
     * an account by looking up the email claim; that would be the silent merge
     * this module exists to prevent.
     */
    resolve(identity: FederatedIdentity, localAccount: FurlPayAccount | null): LinkResolution {
      const existing = store.findByIdentity(identity.issuer, identity.subject);
      if (existing) return { status: "linked", accountId: existing.accountId };
      if (localAccount) return { status: "link_required", pendingToken: issue(identity, localAccount.id) };
      return { status: "create_account" };
    },

    /** Starts an explicit link while the user is authenticated to the local account. */
    beginExplicitLink(identity: FederatedIdentity, localAccount: FurlPayAccount, authenticatedAccountId: string): string {
      if (localAccount.id !== authenticatedAccountId) {
        throw new Error("The authenticated FurlPay account does not match the account being linked");
      }
      const existing = store.findByIdentity(identity.issuer, identity.subject);
      if (existing) {
        if (existing.accountId === localAccount.id) return "";
        throw new Error("That identity is already linked to a different FurlPay account");
      }
      if (store.findByAccount(localAccount.id)) throw new Error("That FurlPay account is already linked to another identity");
      return issue(identity, localAccount.id);
    },

    /** Completes a link only with an explicit approval from the same account. */
    confirmExplicitLink(token: string, input: { decision: "approve" | "deny"; authenticatedAccountId: string }): { status: "linked"; accountId: string } | { status: "denied" } {
      const record = pending.get(token);
      if (!record) throw new Error("That link request is unknown or expired");
      if (record.used || record.expiresAt <= now()) {
        pending.delete(token);
        throw new Error("That link request has expired");
      }
      if (record.accountId !== input.authenticatedAccountId) {
        throw new Error("That link request belongs to a different FurlPay account");
      }
      record.used = true;
      pending.delete(token);
      if (input.decision !== "approve") return { status: "denied" };
      store.create({
        accountId: record.accountId,
        issuer: record.identity.issuer,
        subject: record.identity.subject,
        email: record.identity.email ?? null,
        linkedAt: now(),
      });
      return { status: "linked", accountId: record.accountId };
    },

    /** Unlinking is explicit and leaves the FurlPay account intact. */
    unlink(accountId: string): boolean {
      return store.delete(accountId);
    },
  };
}
