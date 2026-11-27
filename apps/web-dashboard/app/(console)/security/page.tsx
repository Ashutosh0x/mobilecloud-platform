"use client";

import { useCallback, useEffect, useState } from "react";
import { request, useCloud } from "@/lib/store";
import { createPasskey, credentialToJson, getPasskey } from "@/lib/webauthn";
import { Icon } from "@/components/Icons";

/**
 * Passkey management and a real WebAuthn step-up check.
 *
 * Adding a passkey always triggers the platform biometric/PIN prompt because
 * the server requires user verification. The step-up card performs the same
 * ceremony FurlPay uses for a payment, but never calls a payment API: it proves
 * the biometric authorization path works.
 */

type Passkey = {
  id: string;
  deviceName: string | null;
  transports: string | null;
  aaguid: string | null;
  backedUp: number;
  createdAt: number;
  lastUsedAt: number | null;
};

const DEMO_PAYMENT = { amount: 10, currency: "USD", to: "demo-merchant" };

export default function SecurityPage() {
  const { state, setToast } = useCloud();
  const [passkeys, setPasskeys] = useState<Passkey[]>([]);
  const [busy, setBusy] = useState(false);
  const [stepUp, setStepUp] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = (await request("auth/passkeys")) as { passkeys: Passkey[] };
      setPasskeys(data.passkeys ?? []);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load passkeys");
    }
  }, []);

  useEffect(() => {
    if (state.status === "ready") void load();
  }, [state.status, load]);

  async function addPasskey() {
    setBusy(true);
    setError(null);
    try {
      const begin = (await request("auth/passkey/register/begin", {
        method: "POST",
        body: JSON.stringify({ deviceName: navigator.userAgent.includes("Windows") ? "Windows device" : "This device", devicePlatform: "web" }),
      })) as { challenge_id: string; publicKey: Record<string, unknown> };
      const credential = await createPasskey(begin.publicKey as never);
      await request("auth/passkey/register/finish", {
        method: "POST",
        body: JSON.stringify({
          challengeId: begin.challenge_id,
          credential: credentialToJson(credential),
          deviceName: "This browser",
          devicePlatform: "web",
        }),
      });
      setToast("Passkey added. Next sign-in can use your fingerprint or face.");
      await load();
    } catch (caught) {
      const name = caught instanceof DOMException ? caught.name : "";
      if (name === "NotAllowedError" || name === "AbortError") setError("Passkey creation was cancelled.");
      else setError(caught instanceof Error ? caught.message : "Could not add a passkey");
    } finally {
      setBusy(false);
    }
  }

  async function removePasskey(id: string) {
    if (!window.confirm("Remove this passkey? Any session authenticated with it will be signed out.")) return;
    setBusy(true);
    setError(null);
    try {
      await request(`auth/passkeys/${encodeURIComponent(id)}`, { method: "DELETE" });
      setToast("Passkey removed");
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not remove the passkey");
    } finally {
      setBusy(false);
    }
  }

  async function runStepUp() {
    setBusy(true);
    setError(null);
    setStepUp(null);
    try {
      const begin = (await request("auth/step-up/begin", {
        method: "POST",
        body: JSON.stringify({ action: "payment.initiate", payload: DEMO_PAYMENT, client_id: "mobilecloud-console" }),
      })) as { challenge_id: string; public_key: Record<string, unknown> };
      const credential = await getPasskey(begin.public_key as never);
      const verified = (await request("auth/step-up/verify", {
        method: "POST",
        body: JSON.stringify({
          challenge_id: begin.challenge_id,
          credential: credentialToJson(credential),
          payload: DEMO_PAYMENT,
        }),
      })) as { step_up_token: string; expires_at: number };
      setStepUp(verified.step_up_token);
      setToast("Biometric step-up verified for this exact payment payload.");
    } catch (caught) {
      const name = caught instanceof DOMException ? caught.name : "";
      if (name === "NotAllowedError" || name === "AbortError") setError("Step-up was cancelled.");
      else setError(caught instanceof Error ? caught.message : "Step-up failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <header className="page-head">
        <div>
          <p className="crumb">Security</p>
          <h2>Passkeys &amp; biometrics</h2>
          <p>Fingerprint, face and device PIN unlock a private key that never leaves your device. The server stores only the public key.</p>
        </div>
      </header>

      {error && <p className="banner bad" role="alert">{error}</p>}

      <article className="panel">
        <div className="panel-head">
          <h3><Icon name="passkey" size={18} /> Your passkeys</h3>
          <button className="primary" type="button" disabled={busy} onClick={() => void addPasskey()}>
            <span className="btn-icon"><Icon name="passkey" size={16} /></span>
            {busy ? "Waiting for biometrics…" : "Add a passkey"}
          </button>
        </div>
        {passkeys.length === 0 && <p className="empty">No passkeys yet. Add one to sign in without a password.</p>}
        {passkeys.map((passkey) => (
          <div className="list-row" key={passkey.id} style={{ gridTemplateColumns: "1fr auto" }}>
            <div>
              <b><Icon name="passkey" size={14} /> {passkey.deviceName ?? "Passkey"}</b>
              <div className="sub">
                {passkey.backedUp ? "Synced passkey" : "Device-bound passkey"} ·{" "}
                {passkey.lastUsedAt ? `last used ${new Date(passkey.lastUsedAt).toLocaleString()}` : "never used"}
              </div>
            </div>
            <button className="ghost" type="button" disabled={busy} onClick={() => void removePasskey(passkey.id)}>
              Remove
            </button>
          </div>
        ))}
        <p className="sub">
          Add at least two passkeys, on separate devices, so losing one device does not lock you out. Removal is blocked when
          it would leave the account with no passkey and no password.
        </p>
      </article>

      <article className="panel" style={{ marginTop: 16 }}>
        <div className="panel-head">
          <h3><Icon name="shield" size={18} /> Biometric step-up check</h3>
          <button className="ghost" type="button" disabled={busy || passkeys.length === 0} onClick={() => void runStepUp()}>
            <span className="btn-icon"><Icon name="passkey" size={16} /></span>
            Verify a $10 demo payment
          </button>
        </div>
        <p className="sub">
          This performs the same WebAuthn ceremony FurlPay requires before money moves: the challenge is bound to the exact
          amount, currency and recipient, user verification is required, and the resulting token is single-use and expires in
          five minutes. No payment is sent.
        </p>
        {stepUp && (
          <p className="banner">
            Step-up token issued: <code>{stepUp.slice(0, 32)}…</code>
          </p>
        )}
      </article>
    </>
  );
}
