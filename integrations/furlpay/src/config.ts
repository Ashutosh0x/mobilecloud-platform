/**
 * FurlPay's configuration surface.
 *
 * FurlPay is the relying party. Everything it needs is environment-specific:
 * the MobileCloud issuer, its registered client id, the exact callback and the
 * scopes it asked for. No production value is hardcoded here.
 */

export type FurlPayConfig = {
  issuer: string;
  clientId: string;
  clientSecret: string | null;
  redirectUri: string;
  scopes: string[];
  postLogoutRedirectUri: string | null;
  /** Loopback HTTP is allowed only for local development and tests. */
  allowInsecureLoopback: boolean;
};

export class FurlPayConfigError extends Error {
  readonly code = "invalid_configuration";
}

function loopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/** Validates an absolute HTTPS origin (or a loopback HTTP origin in development). */
export function assertIssuer(value: string, allowInsecureLoopback = false): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new FurlPayConfigError("FURLPAY_OIDC_ISSUER is not a valid URL");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new FurlPayConfigError("FURLPAY_OIDC_ISSUER cannot contain credentials, a query or a fragment");
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new FurlPayConfigError("FURLPAY_OIDC_ISSUER must be an origin without a path");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && allowInsecureLoopback && loopback(url.hostname))) {
    throw new FurlPayConfigError("FURLPAY_OIDC_ISSUER must use HTTPS");
  }
  return url.origin;
}

export function assertRedirect(value: string, allowInsecureLoopback = false): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new FurlPayConfigError(`Not a valid callback URI: ${value}`);
  }
  if (url.username || url.password || url.hash) {
    throw new FurlPayConfigError("A callback URI cannot contain credentials or a fragment");
  }
  if (url.protocol === "https:") return url.toString();
  if (url.protocol === "http:" && allowInsecureLoopback && loopback(url.hostname)) return url.toString();
  throw new FurlPayConfigError("A callback URI must use HTTPS");
}

export function loadFurlPayConfig(env: NodeJS.ProcessEnv = process.env): FurlPayConfig {
  const allowInsecureLoopback = /^(1|true|yes|on)$/i.test((env.FURLPAY_OIDC_ALLOW_INSECURE_LOOPBACK ?? "").trim());
  const issuer = assertIssuer((env.FURLPAY_OIDC_ISSUER ?? "").trim(), allowInsecureLoopback);
  const clientId = (env.FURLPAY_OIDC_CLIENT_ID ?? "").trim();
  if (!/^[A-Za-z0-9._-]{3,64}$/.test(clientId)) {
    throw new FurlPayConfigError("FURLPAY_OIDC_CLIENT_ID is required and must be a valid client id");
  }
  const redirectUri = assertRedirect((env.FURLPAY_OIDC_REDIRECT_URI ?? "").trim(), allowInsecureLoopback);
  const scopes = (env.FURLPAY_OIDC_SCOPES ?? "openid profile email")
    .split(/\s+/)
    .map((scope) => scope.trim())
    .filter(Boolean);
  if (!scopes.includes("openid")) throw new FurlPayConfigError("FURLPAY_OIDC_SCOPES must include openid");
  const clientSecret = (env.FURLPAY_OIDC_CLIENT_SECRET ?? "").trim() || null;
  const postLogout = (env.FURLPAY_OIDC_POST_LOGOUT_REDIRECT_URI ?? "").trim();
  return {
    issuer,
    clientId,
    clientSecret,
    redirectUri,
    scopes,
    postLogoutRedirectUri: postLogout ? assertRedirect(postLogout, allowInsecureLoopback) : null,
    allowInsecureLoopback,
  };
}
