"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { CSRF_HEADER, readCsrfCookie } from "@/lib/csrf";
import { useCloud } from "@/lib/store";

/**
 * Consent screen for the Authorization Code + PKCE flow.
 *
 * `mobilecloud login --method browser` opens this page with the client's PKCE
 * challenge. Approving issues a single-use code and sends the browser to the
 * client's loopback callback, which is the only place the verifier exists.
 */

type Authorization = {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: string;
  state: string;
  nonce: string;
  scope: string;
};

const SCOPES: Record<string, string> = {
  openid: "Confirm your identity and share a stable account identifier.",
  profile: "Share your display name.",
  email: "Share your email address.",
  "cli:full": "Read and manage your account from the command line.",
};

function describeScope(scope: string): string {
  return scope
    .split(/\s+/)
    .filter(Boolean)
    .map((entry) => SCOPES[entry] ?? `Grant the ${entry} permission.`)
    .join(" ");
}

function parse(): Authorization | null {
  const params = new URLSearchParams(window.location.search);
  const clientId = params.get("client_id") ?? "";
  const redirect = params.get("redirect_uri") ?? "";
  const challenge = params.get("code_challenge") ?? "";
  if (!clientId || !redirect || !challenge) return null;
  return {
    client_id: clientId,
    redirect_uri: redirect,
    code_challenge: challenge,
    code_challenge_method: params.get("code_challenge_method") ?? "S256",
    state: params.get("state") ?? "",
    nonce: params.get("nonce") ?? "",
    scope: params.get("scope") ?? "openid",
  };
}

export default function AuthorizePage() {
  const { state } = useCloud();
  const [request, setRequest] = useState<Authorization | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [next, setNext] = useState("/authorize");

  useEffect(() => {
    setRequest(parse());
    setNext(`/authorize${window.location.search}`);
    setReady(true);
  }, []);

  async function decide(decision: "approve" | "deny") {
    if (!request) return;
    setBusy(true);
    setError(null);
    try {
      const csrf = readCsrfCookie();
      const response = await fetch("/api/oauth/authorize", {
        method: "POST",
        credentials: "include",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          ...(csrf ? { [CSRF_HEADER]: csrf } : {}),
        },
        body: JSON.stringify({ ...request, decision }),
      });
      const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : `Request failed (${response.status})`);
      if (typeof data.redirect !== "string") throw new Error("The server did not return a redirect.");
      window.location.assign(data.redirect);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not process the authorization");
      setBusy(false);
    }
  }

  return (
    <main className="auth">
      <div className="panel auth-card">
        <h1>MobileCloud</h1>

        {!ready && <p className="sub">Checking the request…</p>}

        {ready && !request && (
          <>
            <h3>That link is incomplete</h3>
            <p className="sub">The client did not send a redirect address or a PKCE challenge. Start the login again from your terminal.</p>
          </>
        )}

        {ready && request && state.status === "loading" && <p className="sub">Checking your session…</p>}

        {ready && request && state.status === "anon" && (
          <>
            <h3>Sign in to continue</h3>
            <p className="sub">
              <b>{request.client_id}</b> wants to sign in to your account. Sign in here, then approve the request.
            </p>
            <Link className="primary auth-link" href={`/login?next=${encodeURIComponent(next)}`}>
              Sign in
            </Link>
          </>
        )}

        {ready && request && state.status === "ready" && (
          <>
            <h3>Authorize {request.client_id}?</h3>
            <p className="sub">{describeScope(request.scope)}</p>
            <p className="banner">
              It will be sent back to <code>{request.redirect_uri}</code>
            </p>
            {error && <p className="banner bad" role="alert">{error}</p>}
            <div className="form-row">
              <button className="primary" type="button" disabled={busy} onClick={() => void decide("approve")}>
                Approve
              </button>
              <button className="ghost" type="button" disabled={busy} onClick={() => void decide("deny")}>
                Deny
              </button>
            </div>
          </>
        )}

        {state.status === "error" && <p className="banner bad">{state.error ?? "The control plane is unreachable."}</p>}
      </div>
    </main>
  );
}
