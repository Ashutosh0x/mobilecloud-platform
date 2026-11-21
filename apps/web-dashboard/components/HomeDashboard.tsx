"use client";

import Link from "next/link";
import { formatBytes } from "@/lib/format";
import { useCloud, type RangeKey } from "@/lib/store";
import { Icon } from "./Icons";
import { ClientTime, Duration } from "./Time";

const RANGES: RangeKey[] = ["1h", "24h", "7d", "30d"];

export function HomeDashboard() {
  const { state, setRange, call, setToast } = useCloud();
  const q = state.query.trim().toLowerCase();
  const projects = state.projects.filter((p) => !q || p.name.includes(q));
  const deployments = state.deployments.filter((d) => !q || d.project.includes(q)).slice(0, 6);
  const metrics = state.metrics;
  const points = state.analytics?.points ?? [];
  const max = Math.max(1, ...points.map((p) => p.count));

  return (
    <>
      <div className="welcome-row">
        <div className="welcome">
          <h2>Welcome, {state.user?.name}</h2>
          <p>Figures below are read from this server. Missing measurements stay blank.</p>
        </div>
        <Link href="/node" className="device-chip">
          <span className="glyph"><Icon name="android" /></span>
          <span>
            <b>{state.host?.hostname ?? "Host unread"}</b>
            <small>{state.host ? `${state.host.platform} · ${state.host.cpuCount} CPUs` : "Open the node page after the API responds."}</small>
          </span>
        </Link>
      </div>

      <section className="stats">
        <Stat icon="rocket" value={String(state.deployments.length)} label="Deployment records" hint="Rows stored for your account" />
        <Stat icon="activity" value={metrics ? "" : "—"} label="Process uptime" hint="This Node process, not a phone" duration={metrics?.processUptimeSec ?? null} />
        <Stat icon="zap" value={metrics?.responseAvgMs == null ? "No samples" : `${metrics.responseAvgMs} ms`} label="Average response" hint={metrics ? `${metrics.responseSamples} requests in 24h` : "Waiting for metrics"} />
        <Stat icon="db" value={metrics ? formatBytes(metrics.dataDirBytes) : "—"} label="Data directory" hint="Files under the server data folder" />
      </section>

      <section className="grid-2">
        <article className="panel">
          <div className="panel-head">
            <h3>Recorded requests</h3>
            <div className="ranges">
              {RANGES.map((range) => (
                <button key={range} type="button" className={state.range === range ? "on" : ""} onClick={() => setRange(range)}>{range}</button>
              ))}
            </div>
          </div>
          <p className="sub">Counts of HTTP calls this server logged for your account. Collected {metrics ? <ClientTime ts={metrics.collectedAt} /> : "—"}.</p>
          {!state.analytics && <p className="skeleton" />}
          {state.analytics && state.analytics.total === 0 && <p className="empty">No requests recorded in this window.</p>}
          {state.analytics && state.analytics.total > 0 && (
            <div className="chart-wrap" role="img" aria-label={`${state.analytics.total} recorded requests`}>
              <svg viewBox="0 0 240 80" preserveAspectRatio="none">
                {points.map((point, i) => (
                  <rect key={`${point.label}-${i}`} x={i * (240 / points.length) + 1} y={80 - (point.count / max) * 72} width={Math.max(2, 240 / points.length - 2)} height={(point.count / max) * 72} fill="#3B82F6">
                    <title>{`${point.label}: ${point.count}`}</title>
                  </rect>
                ))}
              </svg>
            </div>
          )}
        </article>
        <article className="panel">
          <div className="panel-head"><h3>Deployments</h3><Link href="/deployments">View all</Link></div>
          {deployments.length === 0 && <p className="empty">No deployments recorded. Creating one stays blocked until a build runner is configured.</p>}
          <table className="table">
            <tbody>
              {deployments.map((d) => (
                <tr key={d.id}>
                  <td>{d.project}</td>
                  <td className={`badge ${d.status === "failed" ? "error" : "warn"}`}>{d.status}</td>
                  <td><ClientTime ts={d.createdAt} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </article>
      </section>

      <section className="grid-2 even">
        <article className="panel">
          <div className="panel-head"><h3>Projects</h3><Link href="/projects">Manage</Link></div>
          {projects.length === 0 && <p className="empty">No projects yet. Create one from the Projects page.</p>}
          {projects.slice(0, 6).map((p) => {
            const last = state.deployments.find((d) => d.projectId === p.id);
            return (
              <div key={p.id} className="list-row" style={{ gridTemplateColumns: "1fr auto" }}>
                <div>
                  <div className="name">{p.name}</div>
                  <div className="sub">{p.framework} · {p.target}{last ? ` · last ${last.status}` : " · no deployment"}</div>
                </div>
                <button className="ghost" type="button" onClick={async () => {
                  try {
                    const result = await call("deployments", { method: "POST", body: JSON.stringify({ projectId: p.id }) }) as { note?: string };
                    setToast(result.note ?? "Deployment recorded");
                  } catch (error) {
                    setToast(error instanceof Error ? error.message : "Deploy failed");
                  }
                }}>Request deploy</button>
              </div>
            );
          })}
        </article>
        <article className="panel">
          <div className="panel-head"><h3>This host</h3><Link href="/monitoring">Details</Link></div>
          {metrics ? (
            <div className="meters">
              <Meter label="CPU since boot" value={metrics.cpuBusySinceBootPct} />
              <Meter label="Memory" value={metrics.memoryUsedPct} hint={`${formatBytes(metrics.memoryUsedBytes)} / ${formatBytes(metrics.memoryTotalBytes)}`} />
              <Meter label="Disk used" value={metrics.diskTotalBytes && metrics.diskFreeBytes != null ? Math.round((1 - metrics.diskFreeBytes / metrics.diskTotalBytes) * 1000) / 10 : null} hint={metrics.diskTotalBytes ? `${formatBytes(metrics.diskFreeBytes)} free` : undefined} />
              <p className="notice">Network utilization is not measured. Phone battery and wall power are not visible to this process.</p>
              <p className="sub">Sampled <ClientTime ts={metrics.collectedAt} /> · process up <Duration seconds={metrics.processUptimeSec} /></p>
            </div>
          ) : <p className="empty">Host metrics have not arrived.</p>}
        </article>
      </section>
    </>
  );
}

function Stat({ icon, value, label, hint, duration }: { icon: string; value: string; label: string; hint: string; duration?: number | null }) {
  return (
    <article className="stat">
      <span className="glyph"><Icon name={icon} /></span>
      <div>
        <b>{duration !== undefined ? <Duration seconds={duration} /> : value}</b>
        <span>{label}</span>
        <div className="sub">{hint}</div>
      </div>
    </article>
  );
}

function Meter({ label, value, hint }: { label: string; value: number | null; hint?: string }) {
  return (
    <div>
      <div className="meter">
        <span>{label}</span>
        {value == null ? <span>Not measured</span> : <span className="bar"><i style={{ width: `${Math.max(0, Math.min(100, value))}%` }} /></span>}
        <span>{value == null ? "" : `${value}%`}</span>
      </div>
      {hint && <div className="sub">{hint}</div>}
    </div>
  );
}
