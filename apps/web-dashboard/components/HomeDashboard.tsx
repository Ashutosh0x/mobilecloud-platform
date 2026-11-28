"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { formatBytes } from "@/lib/format";
import { request, useCloud, type RangeKey } from "@/lib/store";
import { Icon } from "./Icons";
import { StatusPill } from "./StatusPill";
import { ClientTime, Duration } from "./Time";
import { FleetMeshMeter, HealthBanner, TimeseriesChart, TrendCard, type HealthReport } from "./UiKit";

const RANGES: RangeKey[] = ["1h", "24h", "7d", "30d"];

/**
 * The Command Center.
 *
 * The layout follows the product-improvement report: a global health banner
 * first, then the metric row, then traffic beside what needs attention, then
 * the account's own work.
 *
 * Every figure on this page was measured by this server. Where a number does
 * not exist the card says so instead of showing a zero that would read as a
 * reading.
 */
export function HomeDashboard() {
  const { state, setRange, call, setToast } = useCloud();
  const [health, setHealth] = useState<HealthReport | null>(null);

  const loadHealth = useCallback(async () => {
    try {
      setHealth((await request("health/subsystems")) as HealthReport);
    } catch {
      setHealth(null);
    }
  }, []);

  useEffect(() => {
    void loadHealth();
    const timer = setInterval(() => { void loadHealth(); }, 20000);
    return () => clearInterval(timer);
  }, [loadHealth]);

  const q = state.query.trim().toLowerCase();
  const projects = state.projects.filter((p) => !q || p.name.includes(q));
  const deployments = state.deployments.filter((d) => !q || d.project.includes(q)).slice(0, 6);
  const metrics = state.metrics;
  const points = state.analytics?.points ?? [];
  const counts = points.map((point) => point.count);

  // The trend compares the second half of the window with the first half, so
  // a single busy bucket cannot claim a growth trend.
  const trend = useMemo<"up" | "down" | "flat" | undefined>(() => {
    if (counts.length < 2) return undefined;
    const half = Math.floor(counts.length / 2);
    if (half === 0) return undefined;
    const first = counts.slice(0, half).reduce((sum, value) => sum + value, 0);
    const second = counts.slice(half).reduce((sum, value) => sum + value, 0);
    if (first === 0 && second === 0) return undefined;
    if (second === first) return "flat";
    return second > first ? "up" : "down";
  }, [counts]);

  const alerts = useMemo(() => buildAlerts(state), [state]);
  const activeDomains = state.domains.filter((domain) => domain.status === "active").length;

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

      <HealthBanner report={health} onRefresh={() => void loadHealth()} />

      <section className="stats" style={{ marginTop: 16 }}>
        <TrendCard
          label="Recorded requests"
          value={state.analytics ? state.analytics.total : "—"}
          hint={state.analytics ? `Last ${state.range}` : "Waiting for analytics"}
          series={counts}
          trend={trend}
          tone="blue"
          href="/analytics"
        />
        <TrendCard
          label="Average response"
          value={metrics?.responseAvgMs == null ? "No samples" : `${metrics.responseAvgMs} ms`}
          hint={metrics ? `${metrics.responseSamples} requests measured` : "Waiting for metrics"}
          tone="cyan"
          href="/monitoring"
        />
        <TrendCard
          label="Deployment records"
          value={state.deployments.length}
          hint="Rows stored for your account"
          tone="purple"
          href="/deployments"
        />
        <TrendCard
          label="Domains"
          value={state.domains.length}
          hint={state.domains.length ? `${activeDomains} active` : "No domains yet"}
          tone="green"
          href="/domains"
        />
        <TrendCard
          label="Data directory"
          value={metrics ? formatBytes(metrics.dataDirBytes) : "—"}
          hint="Files under the server data folder"
          tone="amber"
          href="/storage"
        />
      </section>

      <section className="grid-2" style={{ marginTop: 16 }}>
        <article className="panel">
          <div className="panel-head">
            <h3>Traffic</h3>
            <div className="ranges">
              {RANGES.map((range) => (
                <button key={range} type="button" className={state.range === range ? "on" : ""} onClick={() => setRange(range)}>{range}</button>
              ))}
            </div>
          </div>
          <p className="sub">
            Counts of HTTP calls this server logged for your account.
            {metrics ? <> Collected <ClientTime ts={metrics.collectedAt} />.</> : null}
          </p>
          <TimeseriesChart points={points} unit="requests" />
        </article>

        <article className="panel">
          <div className="panel-head">
            <h3>Needs attention</h3>
            <Link href="/logs">Logs</Link>
          </div>
          {alerts.length === 0 && <p className="empty">Nothing needs attention. Domains are active, no build failed, and no request was denied.</p>}
          {alerts.map((alert) => (
            <div key={alert.key} className="list-row" style={{ gridTemplateColumns: "auto 1fr auto" }}>
              <span style={{ color: alert.tone === "bad" ? "var(--red)" : "var(--amber)", display: "inline-flex" }}>
                <Icon name={alert.tone === "bad" ? "warning" : "heartbeat"} size={16} />
              </span>
              <div>
                <div className="name">{alert.title}</div>
                <div className="sub">{alert.detail}</div>
              </div>
              {alert.href && <Link className="ghost" href={alert.href}>Open</Link>}
            </div>
          ))}
        </article>
      </section>

      <section className="grid-2 even">
        <article className="panel">
          <div className="panel-head"><h3>Deployments</h3><Link href="/deployments">View all</Link></div>
          {deployments.length === 0 && <p className="empty">No deployments recorded. Creating one stays blocked until a build runner is configured.</p>}
          <table className="table">
            <tbody>
              {deployments.map((d) => (
                <tr key={d.id}>
                  <td>{d.project}</td>
                  <td><StatusPill status={d.status} label={d.status} /></td>
                  <td><ClientTime ts={d.createdAt} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </article>

        <article className="panel">
          <div className="panel-head"><h3>Recent activity</h3><Link href="/logs">All logs</Link></div>
          {state.notifications.length === 0 && <p className="empty">No activity recorded for this account yet.</p>}
          {state.notifications.slice(0, 8).map((notice) => (
            <div key={notice.id} className="list-row" style={{ gridTemplateColumns: "1fr auto" }}>
              <div>
                <div className="name">{notice.title}</div>
                <div className="sub">{notice.message}</div>
              </div>
              <span className="sub"><ClientTime ts={notice.at} /></span>
            </div>
          ))}
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
              <div style={{ display: "flex", justifyContent: "center", padding: "10px 0" }}>
                <FleetMeshMeter
                  value={metrics.memoryUsedPct}
                  label="Memory used"
                  caption="This Node process, not a phone."
                />
              </div>
              <p className="notice">Network utilization is not measured. Phone battery and wall power are not visible to this process.</p>
              <p className="sub">Sampled <ClientTime ts={metrics.collectedAt} /> · process up <Duration seconds={metrics.processUptimeSec} /></p>
            </div>
          ) : <p className="empty">Host metrics have not arrived.</p>}
        </article>
      </section>
    </>
  );
}

type Alert = { key: string; title: string; detail: string; tone: "warn" | "bad"; href?: string };

/**
 * Alerts are derived from state the account already owns: domains that are not
 * active yet, builds that failed, requests the firewall denied, and a
 * proof-of-reserve state with no attestation behind it.
 */
function buildAlerts(state: ReturnType<typeof useCloud>["state"]): Alert[] {
  const alerts: Alert[] = [];

  for (const domain of state.domains) {
    if (domain.status === "active") continue;
    alerts.push({
      key: `domain-${domain.id}`,
      title: `Domain ${domain.host} is ${domain.status.replace(/_/g, " ")}`,
      detail: domain.detail || "The domain is not serving yet.",
      tone: domain.status === "ssl_expired" || domain.status === "dns_misconfigured" ? "bad" : "warn",
      href: "/domains",
    });
  }

  for (const build of state.builds) {
    if (build.status !== "failed" && build.status !== "error") continue;
    alerts.push({
      key: `build-${build.id}`,
      title: `Build of ${build.project} failed`,
      detail: build.note || "The build runner reported a failure.",
      tone: "bad",
      href: "/builds",
    });
  }

  const denied = state.firewall.events.filter((event) => event.action === "deny").length;
  if (denied > 0) {
    alerts.push({
      key: "firewall-denied",
      title: `${denied} request${denied === 1 ? "" : "s"} denied by a firewall rule`,
      detail: "Open the firewall page to see which rule matched.",
      tone: "warn",
      href: "/firewall",
    });
  }

  if (state.por && !state.por.verified) {
    alerts.push({
      key: "por",
      title: "Proof of reserve is unverified",
      detail: state.por.reason || "No signed attestation has been recorded for this account.",
      tone: "warn",
      href: "/reserve",
    });
  }

  return alerts;
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
