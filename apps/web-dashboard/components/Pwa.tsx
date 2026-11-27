"use client";

import { useEffect, useState } from "react";

/**
 * Installable-PWA behaviour: service-worker registration, offline state and a
 * one-tap install prompt. Nothing here touches authentication; the worker is
 * explicitly excluded from API and OAuth routes.
 */
export function Pwa() {
  const [online, setOnline] = useState(true);
  const [installable, setInstallable] = useState(false);
  const [prompt, setPrompt] = useState<{ prompt: () => Promise<void> } | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    setOnline(navigator.onLine);
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);

    const capture = (event: Event) => {
      event.preventDefault();
      setPrompt(event as unknown as { prompt: () => Promise<void> });
      setInstallable(true);
    };
    window.addEventListener("beforeinstallprompt", capture);
    const installed = () => setInstallable(false);
    window.addEventListener("appinstalled", installed);

    if (process.env.NODE_ENV === "production" && "serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => undefined);
    }

    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
      window.removeEventListener("beforeinstallprompt", capture);
      window.removeEventListener("appinstalled", installed);
    };
  }, []);

  return (
    <>
      {!online && (
        <div className="offline-banner" role="status">
          Offline — cached pages are read-only until the connection returns.
        </div>
      )}
      {installable && online && !dismissed && (
        <div className="install-chip">
          <button className="primary" type="button" onClick={() => void prompt?.prompt()}>
            Install app
          </button>
          <button className="ghost" type="button" aria-label="Dismiss install prompt" onClick={() => setDismissed(true)}>
            Not now
          </button>
        </div>
      )}
    </>
  );
}
