/**
 * Outbound HTTP for the relying party.
 *
 * Discovery and JWKS documents are attacker-influenced only after the issuer
 * is configured, but a compromised issuer or a redirect could still point the
 * client at an internal address. Every outbound URL is therefore checked:
 * HTTPS, no credentials, no fragment, no redirects, and never a loopback,
 * link-local or private address unless the caller explicitly opted in.
 */

export class FurlPayHttpError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 0) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const BLOCKED_V4 = [
  [/^10\./, "private"],
  [/^127\./, "loopback"],
  [/^169\.254\./, "link-local"],
  [/^172\.(1[6-9]|2\d|3[01])\./, "private"],
  [/^192\.168\./, "private"],
  [/^0\./, "unspecified"],
  [/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, "carrier-grade NAT"],
] as const;

function isPrivateHost(hostname: string, allowLoopback: boolean): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host === "[::1]" || host === "::1") return !allowLoopback;
  if (host.endsWith(".internal") || host.endsWith(".local") || host === "metadata.google.internal") return true;
  if (/^\[?f[cd][0-9a-f]{2}:/i.test(host) || /^\[?fe[89ab][0-9a-f]:/i.test(host)) return true;
  for (const [pattern, kind] of BLOCKED_V4) {
    if (pattern.test(host)) return !(allowLoopback && kind === "loopback");
  }
  return false;
}

/** Validates a URL before the client makes a request to it. */
export function assertSafeOutboundUrl(value: string, options: { allowLoopback?: boolean } = {}): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new FurlPayHttpError("invalid_url", `Not a valid URL: ${value}`);
  }
  if (url.username || url.password) throw new FurlPayHttpError("unsafe_url", "A URL cannot contain credentials");
  if (url.hash) throw new FurlPayHttpError("unsafe_url", "A URL cannot contain a fragment");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && options.allowLoopback)) {
    throw new FurlPayHttpError("unsafe_url", "Outbound identity requests must use HTTPS");
  }
  if (isPrivateHost(url.hostname, options.allowLoopback === true)) {
    throw new FurlPayHttpError("unsafe_url", "That address is not publicly routable");
  }
  return url;
}

export async function fetchJson<T>(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit & { allowLoopback?: boolean; timeoutMs?: number; maxBytes?: number } = {},
): Promise<T> {
  const safe = assertSafeOutboundUrl(url, { allowLoopback: init.allowLoopback });
  const timeoutMs = init.timeoutMs ?? 5_000;
  const maxBytes = init.maxBytes ?? 256 * 1024;
  let response: Response;
  try {
    response = await fetchImpl(safe.toString(), {
      ...init,
      redirect: "error",
      signal: init.signal ?? AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new FurlPayHttpError("network_error", `Could not reach ${safe.origin}: ${error instanceof Error ? error.message : "unknown error"}`);
  }
  const text = await response.text();
  if (text.length > maxBytes) throw new FurlPayHttpError("response_too_large", "The identity response exceeded the size limit");
  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      if (typeof parsed.error === "string") detail = typeof parsed.error_description === "string" ? `${parsed.error}: ${parsed.error_description}` : parsed.error;
    } catch { /* non-JSON error body */ }
    throw new FurlPayHttpError("http_error", detail, response.status);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new FurlPayHttpError("invalid_response", "The identity provider returned invalid JSON");
  }
}
