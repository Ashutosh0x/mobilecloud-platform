"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CSRF_HEADER, readCsrfCookie } from "@/lib/csrf";
import { realtime, type RealtimeEvent } from "@/lib/realtime";

/**
 * "Link a device" — the signed-in browser's half of QR pairing.
 *
 * The browser shows a QR code; the phone scans it and asks to be linked; the
 * browser approves. Only then does the phone mint its credential, and only
 * while the browser is open can any of this happen. Polling is paired with the
 * realtime stream, so the screen reacts the instant a phone scans rather than
 * waiting for the next tick.
 */

type PairingStatus =
  | "WAITING_FOR_SCAN"
  | "SCANNED"
  | "AWAITING_APPROVAL"
  | "APPROVED"
  | "CONNECTED"
  | "EXPIRED"
  | "REVOKED"
  | "FAILED";

type Pairing = {
  pairing_id: string;
  status: PairingStatus;
  verification_code: string;
  method: string;
  created_at: string;
  expires_at: string;
  expires_in_ms: number;
  scanned_at: string | null;
  browser: { name: string | null; platform: string | null };
  device: { name: string | null; platform: string | null; app_version: string | null } | null;
  connected_device_id: string | null;
  reason: string | null;
};

type Device = {
  id: string;
  name: string;
  platform: string;
  appVersion: string | null;
  method: string;
  createdAt: number;
  pairedAt: number;
  lastActive: number | null;
  revoked: boolean;
  revokedAt: number | null;
};

const POLL_MS = 2000;
/** Statuses where the other side may still move, so the screen keeps polling. */
const LIVE: PairingStatus[] = ["WAITING_FOR_SCAN", "SCANNED", "AWAITING_APPROVAL", "APPROVED"];

/** Browser-side request helper: CSRF header on mutations, mirroring lib/store. */
async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const method = (init?.method ?? "GET").toUpperCase();
  const csrf = method === "GET" || method === "HEAD" ? null : readCsrfCookie();
  const res = await fetch(`/api/${path}`, {
    ...init,
    credentials: "include",
    headers: {
      "content-type": "application/json",
      ...(csrf ? { [CSRF_HEADER]: csrf } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : `Request failed (${res.status})`);
  return data as T;
}

function statusLabel(status: PairingStatus): string {
  switch (status) {
    case "WAITING_FOR_SCAN":
      return "Waiting for a scan";
    case "SCANNED":
      return "Phone detected";
    case "AWAITING_APPROVAL":
      return "Waiting for your approval";
    case "APPROVED":
      return "Approved. Finishing on the phone…";
    case "CONNECTED":
      return "Device linked";
    case "EXPIRED":
      return "QR code expired";
    case "REVOKED":
      return "Cancelled";
    default:
      return "Could not complete";
  }
}

export default function DevicePage() {
  const [session, setSession] = useState<{ pairing: Pairing; qr: string } | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [remaining, setRemaining] = useState(0);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const sessionRef = useRef<string | null>(null);
  sessionRef.current = session?.pairing.pairing_id ?? null;

  const loadDevices = useCallback(async () => {
    try {
      const data = await api<{ devices: Device[] }>("devices");
      setDevices(data.devices);
    } catch {
      /* the next tick retries */
    }
  }, []);

  const refresh = useCallback(async (id: string) => {
    try {
      const data = await api<{ pairing: Pairing }>(`device/pairing/${id}`);
      setSession((current) => (current && current.pairing.pairing_id === id ? { ...current, pairing: data.pairing } : current));
      if (data.pairing.status === "CONNECTED") void loadDevices();
    } catch {
      /* transient; polling continues */
    }
  }, [loadDevices]);

  useEffect(() => {
    void loadDevices();
  }, [loadDevices]);

  // Poll only while the pairing can still change, so an idle screen is silent.
  useEffect(() => {
    if (!session) return;
    if (!LIVE.includes(session.pairing.status)) return;
    const id = session.pairing.pairing_id;
    const timer = setInterval(() => void refresh(id), POLL_MS);
    return () => clearInterval(timer);
  }, [session, refresh]);

  // Realtime makes the scan appear instantly instead of up to 2s later.
  useEffect(() => {
    return realtime.onEvent((event: RealtimeEvent) => {
      if (!event.event_type.startsWith("device.")) return;
      const id = sessionRef.current;
      if (id) void refresh(id);
      void loadDevices();
    });
  }, [refresh, loadDevices]);

  // Local countdown, so the number moves without a round trip.
  useEffect(() => {
    if (!session) {
      setRemaining(0);
      return;
    }
    if (!LIVE.includes(session.pairing.status)) {
      setRemaining(0);
      return;
    }
    const deadline = Date.now() + session.pairing.expires_in_ms;
    const tick = () => setRemaining(Math.max(0, deadline - Date.now()));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [session]);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const data = await api<{ pairing: Pairing; qr_data_url: string }>("device/pairing", {
        method: "POST",
        body: JSON.stringify({ name: "Web Dashboard", platform: "web" }),
      });
      setSession({ pairing: data.pairing, qr: data.qr_data_url });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start a pairing session");
    } finally {
      setBusy(false);
    }
  }

  async function approve() {
    const id = session?.pairing.pairing_id;
    if (!id) return;
    setBusy(true);
    setError(null);
    try {
      const data = await api<{ pairing: Pairing }>(`device/pairing/${id}/approve`, { method: "POST" });
      setSession((current) => (current ? { ...current, pairing: data.pairing } : current));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not approve this device");
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    const id = session?.pairing.pairing_id;
    if (!id) return;
    setBusy(true);
    setError(null);
    try {
      await api(`device/pairing/${id}`, { method: "DELETE" });
      setSession(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not cancel this pairing");
    } finally {
      setBusy(false);
    }
  }

  async function revoke(device: Device) {
    setError(null);
    try {
      await api(`devices/${device.id}`, { method: "DELETE" });
      await loadDevices();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not revoke this device");
    }
  }

  async function saveName(device: Device) {
    const name = draft.trim();
    if (!name) return;
    setError(null);
    try {
      await api(`devices/${device.id}`, { method: "PATCH", body: JSON.stringify({ name }) });
      setRenaming(null);
      await loadDevices();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not rename this device");
    }
  }

  const status = session?.pairing.status;
  const active = devices.filter((device) => !device.revoked);
  const seconds = Math.ceil(remaining / 1000);

  return (
    <>
      <header className="page-head">
        <div>
          <h2>Link a device</h2>
          <p>Scan this code with the MobileCloud app, then approve the phone here. Nothing is linked until you approve.</p>
        </div>
      </header>

      {error && <p className="banner bad">{error}</p>}

      <article className="panel">
        {!session && (
          <>
            <h3>Pair the mobile app</h3>
            <p className="sub">
              Open the MobileCloud app, choose <b>Link this device</b>, and scan the code shown here. The code is valid for two
              minutes and can be used once.
            </p>
            <button className="primary" type="button" disabled={busy} onClick={() => void start()}>
              Show QR code
            </button>
          </>
        )}

        {session && status === "WAITING_FOR_SCAN" && (
          <div className="pair-grid">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="pair-qr" src={session.qr} alt="QR code to link this device" width={280} height={280} />
            <div>
              <h3>{statusLabel(session.pairing.status)}</h3>
              <p className="sub">Open the MobileCloud app, tap <b>Link this device</b>, and point it at this code.</p>
              <p className="banner">
                Verification code: <code>{session.pairing.verification_code}</code>
              </p>
              <p className="sub">
                {seconds > 0 ? `Expires in ${seconds}s` : "Expiring…"}
              </p>
              <button className="ghost" type="button" disabled={busy} onClick={() => void cancel()}>
                Cancel
              </button>
            </div>
          </div>
        )}

        {session && (status === "SCANNED" || status === "AWAITING_APPROVAL") && (
          <div className="pair-grid">
            <div>
              <h3>{statusLabel(session.pairing.status)}</h3>
              <p className="sub">
                <b>{session.pairing.device?.name ?? "A device"}</b>
                {session.pairing.device?.platform ? ` · ${session.pairing.device.platform}` : ""} wants to link to this account.
              </p>
              <p className="banner">
                Confirm the code matches the app: <code>{session.pairing.verification_code}</code>
              </p>
              <div className="form-row">
                <button className="primary" type="button" disabled={busy} onClick={() => void approve()}>
                  Approve device
                </button>
                <button className="ghost" type="button" disabled={busy} onClick={() => void cancel()}>
                  Deny
                </button>
              </div>
            </div>
          </div>
        )}

        {session && status === "APPROVED" && (
          <>
            <h3>{statusLabel(status)}</h3>
            <p className="sub">Approved. The phone is collecting its credential now. This page updates on its own.</p>
            <button className="ghost" type="button" disabled={busy} onClick={() => void cancel()}>
              Cancel
            </button>
          </>
        )}

        {session && status === "CONNECTED" && (
          <>
            <h3>{statusLabel(status)}</h3>
            <p className="sub">
              <b>{session.pairing.device?.name ?? "The device"}</b> is now linked. It appears under Connected devices and can be
              revoked at any time.
            </p>
            <button className="primary" type="button" onClick={() => setSession(null)}>
              Link another device
            </button>
          </>
        )}

        {session && (status === "EXPIRED" || status === "REVOKED" || status === "FAILED") && (
          <>
            <h3>{statusLabel(status)}</h3>
            <p className="sub">
              {status === "EXPIRED"
                ? "QR codes are valid for two minutes. Show a new one and scan again."
                : "This pairing was closed before the device was linked."}
            </p>
            <button className="primary" type="button" disabled={busy} onClick={() => void start()}>
              Show a new QR code
            </button>
          </>
        )}
      </article>

      <article className="panel">
        <h3>Connected devices</h3>
        <p className="sub">Devices linked to this account. Revoking a device deletes its credential immediately.</p>
        {active.map((device) => (
          <div key={device.id} className="list-row">
            <div>
              <div className="name">
                {renaming === device.id ? (
                  <span className="form-row">
                    <input
                      aria-label="Device name"
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      maxLength={60}
                      autoFocus
                    />
                    <button className="primary" type="button" onClick={() => void saveName(device)}>
                      Save
                    </button>
                    <button className="ghost" type="button" onClick={() => setRenaming(null)}>
                      Cancel
                    </button>
                  </span>
                ) : (
                  device.name
                )}
              </div>
              <div className="sub">
                {device.platform}
                {device.appVersion ? ` · v${device.appVersion}` : ""} · linked via {device.method} ·{" "}
                {device.lastActive ? "active recently" : "no activity yet"}
              </div>
            </div>
            {renaming !== device.id && (
              <span className="form-row">
                <button
                  className="ghost"
                  type="button"
                  onClick={() => {
                    setRenaming(device.id);
                    setDraft(device.name);
                  }}
                >
                  Rename
                </button>
                <button className="ghost" type="button" onClick={() => void revoke(device)}>
                  Revoke
                </button>
              </span>
            )}
          </div>
        ))}
        {active.length === 0 && <p className="empty">No devices linked yet.</p>}
      </article>
    </>
  );
}
