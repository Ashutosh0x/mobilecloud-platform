"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useCloud } from "@/lib/store";

export default function LoginPage() {
  const { state, login } = useCloud();
  const router = useRouter();
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [name, setName] = useState("Ashutosh");
  const [email, setEmail] = useState("ashutosh@gmail.com");
  const [password, setPassword] = useState("ashutosh@123456@1");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (state.status === "ready") router.replace("/");
  }, [state.status, router]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      await login(mode === "signup" ? "auth/signup" : "auth/login", { name, email, password });
      router.replace("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed");
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="auth">
      <form className="panel auth-card" onSubmit={onSubmit}>
        <h1>MobileCloud</h1>
        <p>Create an account on this server. The first account is the owner. Nothing here is billed.</p>
        <div className="seg">
          <button type="button" className={mode === "signup" ? "on" : ""} onClick={() => setMode("signup")}>Create account</button>
          <button type="button" className={mode === "login" ? "on" : ""} onClick={() => setMode("login")}>Sign in</button>
        </div>
        {mode === "signup" && (
          <label className="field">Name
            <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} />
          </label>
        )}
        <label className="field">Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label className="field">Password
          <span className="password-field">
            <input
              type={showPassword ? "text" : "password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
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
        {error && <p className="banner bad" role="alert">{error}</p>}
        {state.status === "error" && <p className="banner bad">{state.error}</p>}
        <button className="primary" type="submit" disabled={pending}>{pending ? "Working…" : mode === "signup" ? "Create account" : "Sign in"}</button>
      </form>
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
