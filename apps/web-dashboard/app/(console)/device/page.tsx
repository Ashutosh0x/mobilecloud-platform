"use client";

import { useState } from "react";

export default function DevicePage() {
  const [userCode, setUserCode] = useState("");
  const [deviceCode, setDeviceCode] = useState("");
  const [status, setStatus] = useState("Request a code, approve it in Settings, then poll.");
  const [token, setToken] = useState<string | null>(null);

  async function requestCode() {
    const res = await fetch("/api/auth/device/code", { method: "POST" });
    const data = await res.json() as { userCode?: string; deviceCode?: string; error?: string };
    if (!res.ok || !data.userCode || !data.deviceCode) {
      setStatus(data.error || "Could not start a device code");
      return;
    }
    setUserCode(data.userCode);
    setDeviceCode(data.deviceCode);
    setToken(null);
    setStatus("Waiting for approval. Confirm this code in Settings.");
  }

  async function poll() {
    const res = await fetch("/api/auth/device/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceCode }),
    });
    const data = await res.json() as { status?: string; token?: string; error?: string };
    if (data.status === "approved" && data.token) {
      setToken(data.token);
      setStatus("Approved. The token is shown once and stored only as a hash.");
      return;
    }
    setStatus(data.status === "pending" ? "Still waiting for approval." : data.error || data.status || "Not approved");
  }

  return (
    <>
      <header className="page-head"><div><h2>Device login</h2><p>RFC 8628 style code. The secret never goes into a shell prompt.</p></div></header>
      <article className="panel">
        <button className="primary" type="button" onClick={() => void requestCode()}>Request code</button>
        {userCode && <p className="banner">User code: <code>{userCode}</code></p>}
        <p className="sub">{status}</p>
        <button className="ghost" type="button" disabled={!deviceCode} onClick={() => void poll()}>Poll for token</button>
        {token && <p className="banner">Access token: <code>{token}</code></p>}
      </article>
    </>
  );
}
