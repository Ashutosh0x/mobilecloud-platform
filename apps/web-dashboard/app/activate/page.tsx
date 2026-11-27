"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { CSRF_HEADER, readCsrfCookie } from "@/lib/csrf";
import { useCloud } from "@/lib/store";

/**
 * The page a person opens after `mobilecloud login` prints a code.
 *
 * It is the human half of the Device Authorization Grant (RFC 8628): verify a
 * short code, show exactly which client and scope it belongs to, then approve
 * or deny. Approval requires a signed-in console session, so a stolen code is
 * useless without the account.
 */

type DeviceRequest = {
  id: string;
  user_code: string;
  client_id: string;
  scope: string;
  status: string;
  expires_in_ms: number;
};

async function call<T>(path: string, body?: unknown): Promise<T> {
  const csrf = readCsrfCookie();
  const response = await fetch(`/api/${path}`, {
    method: body === undefined ? "GET" : "POST",
    credentials: "include",
    headers: { "content-type": "application/json", ...(csrf ? { [CSRF_HEADER]: csrf } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : `Request failed (${response.status})`);
  return data as T;
}

function formatCode(value: string): string {
  const raw = value.replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 8);
  return raw.length > 4 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw;
}

export default function ActivatePage() {
  const { state } = useCloud();
  const [code, setCode] = useState("");
  const [request, setRequest] = useState<DeviceRequest | null>(null);
  const [approved, setApproved] = useState(false);
  const [denied, setDenied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deadline, setDeadline] = useState(0);
  const [remaining, setRemaining] = useState(0);
  const autoTried = useRef(false);

  useEffect(() => {
    const fromUrl = new URLSearchParams(window.location.search).get("code") ?? "";
    if (fromUrl) setCode(formatCode(fromUrl));
  }, []);

  const verify = useCallback(async (value: string) => {
    setBusy(true);
    setError(null);
    try {
      setRequest(await call<DeviceRequest>("oauth/device/verify", { user_code: value }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not verify that code");
    } finally {
      setBusy(false);
    }
  }, []);

  // A link from the terminal carries the code, so the common path needs no typing.
  useEffect(() => {
    if (autoTried.current) return;
    if (state.status !== "ready" || request || code.length !== 9) return;
    autoTried.current = true;
    void verify(code);
  }, [state.status, request, code, verify]);

  useEffect(() => {
    if (!request) return;
    setDeadline(Date.now() + request.expires_in_ms);
  }, [request]);

  useEffect(() => {
    if (!deadline) return;
    const tick = () => setRemaining(Math.max(0, deadline - Date.now()));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [deadline]);

  async function onVerify(event: FormEvent) {
    event.preventDefault();
    await verify(code);
  }

  async function approve() {
    if (!request) return;
    setBusy(true);
    setError(null);
    try {
      await call(`oauth/device/${request.id}/approve`, { device_name: "Web Console", device_platform: "web" });
      setApproved(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not approve the request");
    } finally {
      setBusy(false);
    }
  }

  async function deny() {
    if (!request) return;
    setBusy(true);
    setError(null);
    try {
      await call(`oauth/device/${request.id}/deny`, {});
      setRequest(null);
      setCode("");
      setDenied(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not deny the request");
    } finally {
      setBusy(false);
    }
  }

  const seconds = Math.ceil(remaining / 1000);
  const nextPath = `/activate${code ? `?code=${encodeURIComponent(code)}` : ""}`;

  return (
    <main className="auth">
      <div className="panel auth-card">
        <h1>MobileCloud</h1>

        {state.status === "loading" && <p className="sub">Checking your session…</p>}

        {state.status === "anon" && (
          <>
            <h3>Sign in to authorize the CLI</h3>
            <p className="sub">
              A terminal is asking to sign in to your account. Sign in here first, then approve the request.
            </p>
            <Link className="primary auth-link" href={`/login?next=${encodeURIComponent(nextPath)}`}>
              Sign in
            </Link>
          </>
        )}

        {state.status === "ready" && approved && (
          <>
            <h3>CLI authorized</h3>
            <p className="banner">You can close this window and return to the terminal.</p>
            <p className="sub">The CLI now holds its own scoped token and can be signed out from the console at any time.</p>
          </>
        )}

        {state.status === "ready" && !approved && denied && (
          <>
            <h3>Request denied</h3>
            <p className="sub">The terminal was not signed in. It is safe to close this window.</p>
            <button className="ghost" type="button" onClick={() => setDenied(false)}>
              Enter another code
            </button>
          </>
        )}

        {state.status === "ready" && !approved && !denied && !request && (
          <form onSubmit={onVerify}>
            <h3>Authorize a CLI</h3>
            <p className="sub">Enter the code shown in your terminal. Codes are valid for 15 minutes.</p>
            <label className="field">
              Device code
              <input
                className="auth-code"
                type="text"
                value={code}
                onChange={(event) => setCode(formatCode(event.target.value))}
                placeholder="ABCD-1234"
                maxLength={9}
                autoFocus
                required
                autoComplete="one-time-code"
                spellCheck={false}
              />
            </label>
            {error && <p className="banner bad" role="alert">{error}</p>}
            <button className="primary" type="submit" disabled={busy || code.length !== 9}>
              {busy ? "Verifying…" : "Continue"}
            </button>
          </form>
        )}

        {state.status === "ready" && !approved && !denied && request && (
          <>
            <h3>Authorize this terminal?</h3>
            <p className="sub">
              <b>{request.client_id}</b> is asking for the <code>{request.scope}</code> scope.
            </p>
            <p className="banner">
              Confirm the terminal shows the same code: <code>{request.user_code}</code>
            </p>
            <p className="sub">
              {seconds > 0 ? `This request expires in ${seconds}s.` : "This request has expired."}
            </p>
            {error && <p className="banner bad" role="alert">{error}</p>}
            <div className="form-row">
              <button className="primary" type="button" disabled={busy} onClick={() => void approve()}>
                Approve
              </button>
              <button className="ghost" type="button" disabled={busy} onClick={() => void deny()}>
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
