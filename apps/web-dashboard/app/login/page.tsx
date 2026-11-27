"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CSRF_HEADER, readCsrfCookie } from "@/lib/csrf";
import { useCloud } from "@/lib/store";

/**
 * Sign in with the phone that already holds the account.
 *
 * "Login with MobileCloud" creates a short lived challenge, shows it as a QR
 * code, and waits for the phone to approve it. The browser never sees a
 * credential: approval sets the session cookie, and only this browser holds the
 * poll secret that can collect it. Email and password remain as the recovery
 * path for an account that has not added a passkey yet.
 */

type Mode = "choose" | "password" | "mobilecloud";
type QrStatus = "WAITING" | "SCANNED" | "APPROVED" | "EXPIRED" | "DENIED";

type QrSession = {
  challenge_id: string;
  verification_code: string;
  qr_data_url: string;
  poll_secret: string;
  expires_in_ms: number;
  status: QrStatus;
};

const POLL_MS = 2000;

/** Only same-origin absolute paths are accepted, so `?next=` cannot redirect away. */
function safeNext(value: string | null): string {
  if (!value) return "/";
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return "/";
  return value;
}

/** A short, human label the phone can show on its approval screen. */
function browserLabel(userAgent: string): string {
  const browser = /Edg\//.test(userAgent)
    ? "Edge"
    : /Chrome\//.test(userAgent)
      ? "Chrome"
      : /Firefox\//.test(userAgent)
        ? "Firefox"
        : /Safari\//.test(userAgent)
          ? "Safari"
          : "A browser";
  const platform = /Windows/.test(userAgent)
    ? "Windows"
    : /Android/.test(userAgent)
      ? "Android"
      : /iPhone|iPad/.test(userAgent)
        ? "iOS"
        : /Mac OS X/.test(userAgent)
          ? "macOS"
          : /Linux/.test(userAgent)
            ? "Linux"
            : "an unknown platform";
  return `${browser} on ${platform}`;
}

export default function LoginPage() {
  const { state, login, refresh } = useCloud();
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("choose");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [qr, setQr] = useState<QrSession | null>(null);
  const [deadline, setDeadline] = useState(0);
  const [remaining, setRemaining] = useState(0);
  const next = useRef("/");

  useEffect(() => {
    next.current = safeNext(new URLSearchParams(window.location.search).get("next"));
  }, []);

  useEffect(() => {
    if (state.status === "ready") router.replace(next.current);
  }, [state.status, router]);

  const startQr = useCallback(async () => {
    setPending(true);
    setError(null);
    try {
      const csrf = readCsrfCookie();
      const response = await fetch("/api/auth/qr-login/init", {
        method: "POST",
        credentials: "include",
        headers: {
          "content-type": "application/json",
          ...(csrf ? { [CSRF_HEADER]: csrf } : {}),
        },
        body: JSON.stringify({ browser: browserLabel(navigator.userAgent) }),
      });
      const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "Could not start the sign-in");
      setQr({
        challenge_id: String(data.challenge_id ?? ""),
        verification_code: String(data.verification_code ?? ""),
        qr_data_url: String(data.qr_data_url ?? ""),
        poll_secret: String(data.poll_secret ?? ""),
        expires_in_ms: Number(data.expires_in_ms ?? 120_000),
        status: "WAITING",
      });
      setDeadline(Date.now() + Number(data.expires_in_ms ?? 120_000));
      setMode("mobilecloud");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not start the sign-in");
    } finally {
      setPending(false);
    }
  }, []);

  // Poll only while the request can still move. The poll secret proves this is
  // the browser that created the challenge, so no other tab can collect it.
  const challengeId = qr?.challenge_id;
  const pollSecret = qr?.poll_secret;
  const qrStatus = qr?.status;

  useEffect(() => {
    if (!challengeId || !pollSecret) return;
    if (qrStatus !== "WAITING" && qrStatus !== "SCANNED") return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const response = await fetch(
          `/api/auth/qr-login/${challengeId}?poll=${encodeURIComponent(pollSecret)}`,
          { credentials: "include", cache: "no-store" },
        );
        if (cancelled) return;
        if (!response.ok) {
          setQr((current) => (current ? { ...current, status: response.status === 403 ? "DENIED" : "EXPIRED" } : current));
          return;
        }
        const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        const status = (typeof data.status === "string" ? data.status : "WAITING") as QrStatus;
        if (status === "APPROVED") {
          setQr((current) => (current ? { ...current, status } : current));
          // The poll response set the session cookies; re-read the account
          // before navigating so the console does not flash the login page.
          await refresh();
          if (!cancelled) router.replace(next.current);
          return;
        }
        if (status !== qrStatus) {
          setQr((current) => (current ? { ...current, status } : current));
        }
      } catch {
        /* a transient failure is retried on the next tick */
      }
      if (!cancelled) timer = setTimeout(poll, POLL_MS);
    };
    timer = setTimeout(poll, POLL_MS);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [challengeId, pollSecret, qrStatus, refresh, router]);

  useEffect(() => {
    if (!deadline) return;
    const tick = () => setRemaining(Math.max(0, deadline - Date.now()));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [deadline]);

  async function onPasswordSubmit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      await login({ email, password });
      router.replace(next.current);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Sign-in failed");
    } finally {
      setPending(false);
    }
  }

  const seconds = Math.ceil(remaining / 1000);

  return (
    <main className="auth">
      <div className="panel auth-card">
        <h1>MobileCloud</h1>

        {mode === "choose" && (
          <>
            <p className="sub">Sign in with the phone that holds your account, or use your password.</p>
            <button className="primary" type="button" disabled={pending} onClick={() => void startQr()}>
              {pending ? "Starting…" : "Login with MobileCloud"}
            </button>
            <button className="ghost" type="button" disabled={pending} onClick={() => setMode("password")}>
              Use email and password
            </button>
            <p className="sub">
              Signing in to the CLI? Open <Link href="/activate">the device page</Link> and enter the code from your terminal.
            </p>
          </>
        )}

        {mode === "mobilecloud" && qr && (
          <div className="auth-qr-flow">
            {qr.status === "WAITING" && (
              <>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img className="auth-qr" src={qr.qr_data_url} alt="QR code to sign in with the MobileCloud app" width={240} height={240} />
                <p className="sub">Open the MobileCloud app, scan this code, and approve the sign-in on your phone.</p>
                <p className="banner">
                  Verification code: <code>{qr.verification_code}</code>
                </p>
                <p className="sub">{seconds > 0 ? `This code expires in ${seconds}s` : "This code has expired."}</p>
              </>
            )}

            {qr.status === "SCANNED" && (
              <>
                <h3>Phone detected</h3>
                <p className="sub">Your phone is reviewing this request. Approve it there to continue.</p>
                <p className="banner">
                  Confirm the code matches: <code>{qr.verification_code}</code>
                </p>
                <p className="sub">{seconds > 0 ? `This code expires in ${seconds}s` : "This code has expired."}</p>
              </>
            )}

            {qr.status === "APPROVED" && (
              <>
                <h3>Approved</h3>
                <p className="sub">Signing you in…</p>
              </>
            )}

            {(qr.status === "EXPIRED" || qr.status === "DENIED") && (
              <>
                <h3>{qr.status === "EXPIRED" ? "This code expired" : "Sign-in denied"}</h3>
                <p className="sub">
                  {qr.status === "EXPIRED"
                    ? "Codes are valid for two minutes. Start a new one and scan again."
                    : "The phone declined this request. Start again if that was a mistake."}
                </p>
                <button className="primary" type="button" disabled={pending} onClick={() => void startQr()}>
                  Show a new code
                </button>
              </>
            )}

            <button
              className="ghost"
              type="button"
              onClick={() => {
                setMode("choose");
                setQr(null);
                setDeadline(0);
              }}
            >
              Back
            </button>
          </div>
        )}

        {mode === "password" && (
          <form onSubmit={onPasswordSubmit}>
            <p className="sub">Sign in with the account your operator provisioned.</p>
            <label className="field">
              Email
              <input type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} required />
            </label>
            <label className="field">
              Password
              <span className="password-field">
                <input
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                  minLength={8}
                  autoComplete="current-password"
                />
                <button
                  className="eye"
                  type="button"
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  aria-pressed={showPassword}
                  onClick={() => setShowPassword((value) => !value)}
                >
                  {showPassword ? <EyeOff /> : <Eye />}
                </button>
              </span>
            </label>
            <button className="primary" type="submit" disabled={pending}>
              {pending ? "Signing in…" : "Sign in"}
            </button>
            <button className="ghost" type="button" onClick={() => setMode("choose")}>
              Back
            </button>
          </form>
        )}

        {error && <p className="banner bad" role="alert">{error}</p>}
        {state.status === "error" && <p className="banner bad">{state.error}</p>}
      </div>
    </main>
  );
}

function Eye() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function EyeOff() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M3 3l18 18" />
      <path d="M10.6 10.6a3 3 0 0 0 4.2 4.2" />
      <path d="M9.9 5.2A10.8 10.8 0 0 1 12 5c6.5 0 10 7 10 7a18.4 18.4 0 0 1-4.1 4.9" />
      <path d="M6.1 6.1C3.8 7.8 2 12 2 12s3.5 7 10 7a10.7 10.7 0 0 0 4.1-.8" />
    </svg>
  );
}
