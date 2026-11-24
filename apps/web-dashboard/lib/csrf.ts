/**
 * Double-submit CSRF token: shared by the browser client and the server route.
 *
 * The server issues a non-httpOnly `mc_csrf` cookie (so JavaScript can read it)
 * alongside the httpOnly `mc_session` cookie, and stores the same value on the
 * session row. A state-changing request must echo the value in the
 * `x-mc-csrf` header; the server only accepts it when header, cookie, and the
 * stored session value all match (constant-time).
 *
 * This module stays free of node built-ins so the client bundle can import the
 * cookie name and reader without pulling in `node:crypto`.
 */
export const CSRF_COOKIE = "mc_csrf";
export const CSRF_HEADER = "x-mc-csrf";

/** Reads the CSRF token the server put in the non-httpOnly cookie. Browser only. */
export function readCsrfCookie(): string | null {
  if (typeof document === "undefined") return null;
  const hit = document.cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${CSRF_COOKIE}=`));
  return hit ? decodeURIComponent(hit.slice(CSRF_COOKIE.length + 1)) : null;
}
