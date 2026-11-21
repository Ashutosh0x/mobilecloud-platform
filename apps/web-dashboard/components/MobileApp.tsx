"use client";

import Link from "next/link";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { formatBytes } from "@/lib/format";
import { useCloud } from "@/lib/store";
import { Duration } from "./Time";

export function MobileApp() {
  const { state } = useCloud();
  const router = useRouter();
  const host = state.host;

  useEffect(() => {
    if (state.status === "anon") router.replace("/login");
  }, [state.status, router]);

  return (
    <main className="phone">
      <header className="page-head">
        <div>
          <h2>Node console</h2>
          <p>This page reports the computer running the web server. Battery, bypass charging, and wall power are not available here.</p>
        </div>
        <Link href="/" className="ghost">Back to dashboard</Link>
      </header>
      {state.status === "loading" && <p className="skeleton" />}
      {state.status === "error" && <p className="banner bad">{state.error}</p>}
      {host && (
        <section className="cards">
          <article className="panel"><h3>Host</h3><b>{host.hostname}</b><p className="sub">{host.platform} {host.release} · {host.arch} · {host.cpuCount} CPUs</p></article>
          <article className="panel"><h3>Process uptime</h3><b><Duration seconds={host.processUptimeSec} /></b><p className="sub">Time since this Node process started.</p></article>
          <article className="panel"><h3>Memory</h3><b>{formatBytes(host.memoryUsedBytes)}</b><p className="sub">of {formatBytes(host.memoryTotalBytes)} reported by the OS</p></article>
          <article className="panel"><h3>Not available from this process</h3><ul>{host.unavailable.map((line) => <li key={line}>{line}</li>)}</ul></article>
        </section>
      )}
    </main>
  );
}
