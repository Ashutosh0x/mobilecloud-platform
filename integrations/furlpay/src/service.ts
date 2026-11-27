import type { FurlPayConfig } from "./config.ts";
import { createFurlPayOidcClient, type FurlPayOidcClient, type IdTokenClaims, type TokenResponse } from "./oidc-client.ts";
import {
  createAccountLinkingService,
  MemoryIdentityLinkStore,
  type FurlPayAccount,
  type IdentityLinkStore,
  type LinkResolution,
} from "./linking.ts";
import type { FetchLike } from "./http.ts";
import { createFurlPaySession, type FurlPaySession } from "./session.ts";
import { createNonce, createPkce, createState } from "./pkce.ts";

/**
 * One login, end to end, for FurlPay.
 *
 * The service owns the cross-cutting order that is easy to get wrong:
 * verify `state`, exchange the code, verify the ID token (including `nonce`),
 * then resolve the local account. A session is issued only when the identity
 * is already linked; first-time and link-required outcomes are handed back to
 * FurlPay to complete on its own terms.
 */

export type LoginTransaction = {
  state: string;
  nonce: string;
  codeVerifier: string;
  redirectUri: string;
};

export type CompletedLogin = {
  claims: IdTokenClaims;
  tokens: TokenResponse;
  resolution: LinkResolution;
  session: FurlPaySession | null;
};

export type FurlPayServiceDeps = {
  fetch?: FetchLike;
  now?: () => number;
  linkStore?: IdentityLinkStore;
  allowInsecureLoopback?: boolean;
};

export function createFurlPayService(config: FurlPayConfig, deps: FurlPayServiceDeps = {}) {
  const oidc: FurlPayOidcClient = createFurlPayOidcClient(config, {
    fetch: deps.fetch,
    now: deps.now,
    allowInsecureLoopback: deps.allowInsecureLoopback,
  });
  const store = deps.linkStore ?? new MemoryIdentityLinkStore();
  const linking = createAccountLinkingService(store, { now: deps.now });

  return {
    oidc,
    linking,
    store,

    /** Step 1: build the redirect and persist the transaction server-side. */
    async beginLogin(): Promise<{ url: string; transaction: LoginTransaction }> {
      const { verifier, challenge } = createPkce();
      const state = createState();
      const nonce = createNonce();
      const url = await oidc.authorizationUrl({ state, nonce, codeChallenge: challenge });
      return { url, transaction: { state, nonce, codeVerifier: verifier, redirectUri: config.redirectUri } };
    },

    /**
     * Step 2: handle the callback.
     *
     * `resolveLocalAccount` must return the FurlPay account the user is already
     * signed in to, or null. It must never look an account up by email.
     */
    async completeLogin(
      input: {
        code: string;
        state: string;
        transaction: LoginTransaction;
        resolveLocalAccount: () => FurlPayAccount | null | Promise<FurlPayAccount | null>;
      },
    ): Promise<CompletedLogin> {
      if (!input.state || input.state !== input.transaction.state) {
        throw new Error("The login state does not match this transaction");
      }
      const tokens = await oidc.exchangeCode({
        code: input.code,
        codeVerifier: input.transaction.codeVerifier,
        redirectUri: input.transaction.redirectUri,
      });
      const claims = await oidc.verifyIdToken(tokens.id_token, input.transaction.nonce);
      const localAccount = await input.resolveLocalAccount();
      const resolution = linking.resolve(
        { issuer: claims.iss, subject: claims.sub, email: typeof claims.email === "string" ? claims.email : null },
        localAccount,
      );
      const session =
        resolution.status === "linked"
          ? createFurlPaySession(resolution.accountId, { issuer: claims.iss, subject: claims.sub }, { now: deps.now })
          : null;
      return { claims, tokens, resolution, session };
    },
  };
}

export type FurlPayService = ReturnType<typeof createFurlPayService>;
