"use client";

import { useState } from "react";
import { formatBytes } from "@/lib/format";
import { useCloud } from "@/lib/store";
import { ClientTime } from "./Time";

async function run(action: () => Promise<unknown>, setToast: (message: string | null) => void, ok: string) {
  try {
    const result = await action();
    const note = result && typeof result === "object" && "note" in result && typeof result.note === "string" ? result.note : ok;
    setToast(note);
  } catch (error) {
    setToast(error instanceof Error ? error.message : "Request failed");
  }
}

export function FirewallView() {
  const { state, call, setToast } = useCloud();
  const [name, setName] = useState("");
  const [action, setAction] = useState("log");
  const [matchKey, setMatchKey] = useState("path");
  const [matchOp, setMatchOp] = useState("starts_with");
  const [matchValue, setMatchValue] = useState("/functions");
  const [headerName, setHeaderName] = useState("");
  return (
    <>
      <header className="page-head">
        <div>
          <h2>Firewall</h2>
          <p>Rules apply to this API for your account. Account, overview, and firewall routes stay reachable so a rule cannot lock you out. A JA4 rule matches only when the request sends an x-ja4-fingerprint header. This process does not read the TLS ClientHello and does not invent a digest or a bot score.</p>
        </div>
      </header>
      <form className="panel form-row" onSubmit={(e) => {
        e.preventDefault();
        run(() => call("firewall", { method: "POST", body: JSON.stringify({ name, action, matchKey, matchOp, matchValue, headerName, limitCount: 30, windowSec: 60 }) }), setToast, "Rule saved");
        setName("");
      }}>
        <input aria-label="Rule name" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} required />
        <select aria-label="Action" value={action} onChange={(e) => setAction(e.target.value)}>
          <option value="log">log</option>
          <option value="deny">deny</option>
          <option value="rate_limit">rate limit 30 / 60s</option>
        </select>
        <select aria-label="Match" value={matchKey} onChange={(e) => setMatchKey(e.target.value)}>
          <option value="path">path</option>
          <option value="ip">ip</option>
          <option value="header">header</option>
          <option value="ja4">ja4 header</option>
          <option value="user_agent">user agent</option>
          <option value="host">host</option>
        </select>
        <select aria-label="Operator" value={matchOp} onChange={(e) => setMatchOp(e.target.value)}>
          <option value="starts_with">starts with</option>
          <option value="equals">equals</option>
          <option value="contains">contains</option>
        </select>
        <input aria-label="Value" value={matchValue} onChange={(e) => setMatchValue(e.target.value)} required />
        {matchKey === "header" && <input aria-label="Header name" placeholder="header name" value={headerName} onChange={(e) => setHeaderName(e.target.value)} />}
        <button className="primary" type="submit">Save rule</button>
      </form>
      <article className="panel">
        {state.firewall.rules.map((rule) => (
          <div key={rule.id} className="list-row" style={{ gridTemplateColumns: "1fr auto" }}>
            <div>
              <div className="name">{rule.name}</div>
              <div className="sub">{rule.action} when {rule.matchKey} {rule.matchOp} {rule.matchValue}</div>
            </div>
            <button className="danger" type="button" onClick={() => run(() => call(`firewall/${rule.id}`, { method: "DELETE" }), setToast, "Rule removed")}>Remove</button>
          </div>
        ))}
        {state.firewall.rules.length === 0 && <p className="empty">No firewall rules stored.</p>}
      </article>
      <article className="panel">
        <h3>Recent matches</h3>
        {state.firewall.events.map((event) => (
          <div key={event.id} className="list-row">
            <div className="name">{event.action} {event.path}</div>
            <div className="sub">{event.ip} · <ClientTime ts={event.at} /></div>
          </div>
        ))}
        {state.firewall.events.length === 0 && <p className="empty">No rule has matched a request yet.</p>}
      </article>
      <TrafficPanel />
    </>
  );
}

function TrafficPanel() {
  const traffic = useCloud().state.firewall.traffic;
  if (!traffic) return <p className="empty">No traffic summary yet.</p>;
  const peak = Math.max(1, ...traffic.buckets.map((bucket) => bucket.requests));
  return (
    <>
      <section className="stats">
        <article className="stat"><div><b>{traffic.requests}</b><span>API calls, 24h</span></div></article>
        <article className="stat"><div><b>{traffic.denied}</b><span>Deny events</span></div></article>
        <article className="stat"><div><b>{traffic.logged}</b><span>Log events</span></div></article>
        <article className="stat"><div><b>{traffic.rateLimited}</b><span>Rate-limit events</span></div></article>
      </section>
      <article className="panel">
        <h3>Requests by hour</h3>
        {traffic.buckets.length === 0 && <p className="empty">No API calls stored in this window.</p>}
        <div className="hours">
          {traffic.buckets.map((bucket) => (
            <i key={bucket.start} title={`${bucket.requests}`} style={{ height: `${Math.max(4, Math.round((bucket.requests / peak) * 72))}px` }} />
          ))}
        </div>
      </article>
      <div className="cards">
        <Rank title="Paths" rows={traffic.topPaths} empty="No paths stored." />
        <Rank title="User agents" rows={traffic.topAgents} empty="No user agent stored." />
        <Rank title="JA4 headers" rows={traffic.topJa4} empty="No JA4 header observed." />
        <Rank title="Crawler names in User-Agent" rows={traffic.crawlerTokens} empty="No known crawler token in a stored User-Agent." />
      </div>
      <article className="panel"><ul>{traffic.notes.map((note) => <li key={note}>{note}</li>)}</ul></article>
    </>
  );
}

function Rank({ title, rows, empty }: { title: string; rows: { value: string; count: number }[]; empty: string }) {
  return (
    <article className="panel">
      <h3>{title}</h3>
      {rows.map((row) => <div key={row.value} className="list-row"><div className="name">{row.value}</div><div className="sub">{row.count}</div></div>)}
      {rows.length === 0 && <p className="empty">{empty}</p>}
    </article>
  );
}

export function ObservabilityView() {
  const { state } = useCloud();
  const data = state.observability;
  return (
    <>
      <header className="page-head"><div><h2>Observability</h2><p>Status counts and latency percentiles from requests this server stored in the last 24 hours.</p></div></header>
      {!data && <p className="empty">No observability sample yet.</p>}
      {data && (
        <>
          <section className="stats">
            <article className="stat"><div><b>{data.samples}</b><span>Requests</span></div></article>
            <article className="stat"><div><b>{data.p50 == null ? "No samples" : `${data.p50} ms`}</b><span>p50 duration</span></div></article>
            <article className="stat"><div><b>{data.p95 == null ? "No samples" : `${data.p95} ms`}</b><span>p95 duration</span></div></article>
            <article className="stat"><div><b>{data.p99 == null ? "No samples" : `${data.p99} ms`}</b><span>p99 duration</span></div></article>
          </section>
          <article className="panel">
            <div className="sub">2xx {data.statuses.s2xx} · 3xx {data.statuses.s3xx} · 4xx {data.statuses.s4xx} · 5xx {data.statuses.s5xx}</div>
            <ul>{data.unavailable.map((line) => <li key={line}>{line}</li>)}</ul>
          </article>
        </>
      )}
    </>
  );
}

export function SpeedView() {
  const { state } = useCloud();
  const vitals = state.vitals;
  return (
    <>
      <header className="page-head"><div><h2>Speed</h2><p>{vitals?.note}</p></div></header>
      <article className="panel"><h3>Real Experience Score</h3><b>{vitals?.res == null ? "No samples" : vitals.res}</b></article>
      <div className="cards">
        {vitals?.metrics.map((metric) => (
          <article key={metric.metric} className="panel">
            <h3>{metric.metric}</h3>
            <b>{metric.p75 == null ? "No samples" : metric.metric === "CLS" ? metric.p75.toFixed(3) : `${Math.round(metric.p75)} ms`}</b>
            <p className="sub">{metric.samples} samples · p75</p>
          </article>
        ))}
      </div>
    </>
  );
}

export function BuildsView() {
  const { state, call, setToast } = useCloud();
  const [projectId, setProjectId] = useState(state.projects[0]?.id ?? "");
  const [target, setTarget] = useState("android");
  return (
    <>
      <header className="page-head">
        <div><h2>Builds</h2><p>A build request is stored as blocked until a runner exists. This host has no ARM64 pool, hot Gradle snapshot, or Android SDK.</p></div>
        <form className="form-row" onSubmit={(e) => { e.preventDefault(); run(() => call("builds", { method: "POST", body: JSON.stringify({ projectId, target }) }), setToast, "Recorded"); }}>
          <select aria-label="Project" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            {state.projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
          <select aria-label="Target" value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="android">android</option>
            <option value="web">web</option>
          </select>
          <button className="primary" type="submit" disabled={!state.projects.length}>Queue</button>
        </form>
      </header>
      <article className="panel">
        {state.builds.map((build) => (
          <div key={build.id} className="list-row">
            <div className="name">{build.project} · {build.target} · {build.status}</div>
            <div className="sub">{build.note} · <ClientTime ts={build.createdAt} /></div>
          </div>
        ))}
        {state.builds.length === 0 && <p className="empty">No build requests stored.</p>}
      </article>
    </>
  );
}

export function WorkflowsView() {
  const { state, call, setToast } = useCloud();
  const [name, setName] = useState("");
  const [drive, setDrive] = useState("");
  return (
    <>
      <header className="page-head"><div><h2>Workflows and drives</h2><p>Workflow runs are recorded and not executed. Drives are real directories on this server, not microVM volumes.</p></div></header>
      <form className="form-row" onSubmit={(e) => { e.preventDefault(); run(() => call("workflows", { method: "POST", body: JSON.stringify({ name }) }), setToast, "Workflow saved"); setName(""); }}>
        <input aria-label="Workflow name" placeholder="nightly-audit" value={name} onChange={(e) => setName(e.target.value)} required />
        <button className="primary" type="submit">Save workflow</button>
      </form>
      <article className="panel">
        {state.workflows.map((workflow) => (
          <div key={workflow.id} className="list-row" style={{ gridTemplateColumns: "1fr auto" }}>
            <div>
              <div className="name">{workflow.name}</div>
              <div className="sub">{workflow.lastRun ? `${workflow.lastRun.status}: ${workflow.lastRun.note}` : "No run recorded"}</div>
            </div>
            <button className="ghost" type="button" onClick={() => run(() => call(`workflows/${workflow.id}/run`, { method: "POST" }), setToast, "Recorded")}>Record run</button>
          </div>
        ))}
        {state.workflows.length === 0 && <p className="empty">No workflows stored.</p>}
      </article>
      <form className="form-row" onSubmit={(e) => { e.preventDefault(); run(() => call("drives", { method: "POST", body: JSON.stringify({ name: drive }) }), setToast, "Directory created"); setDrive(""); }}>
        <input aria-label="Drive name" placeholder="workspace" value={drive} onChange={(e) => setDrive(e.target.value)} required />
        <button className="primary" type="submit">Create drive directory</button>
      </form>
      <article className="panel">
        {state.drives.map((item) => <div key={item.id} className="list-row"><div className="name">{item.name}</div><div className="sub">{item.bytes == null ? "unreadable" : formatBytes(item.bytes)} on disk</div></div>)}
        {state.drives.length === 0 && <p className="empty">No drive directories yet.</p>}
      </article>
      <article className="panel">
        <h3>Platform boundaries</h3>
        {state.capabilities.map((item) => (
          <div key={item.name} className="list-row">
            <div className="name">{item.name}</div>
            <div className={`sub ${item.state === "unavailable" ? "notice" : ""}`}>{item.state} · {item.detail}</div>
          </div>
        ))}
      </article>
    </>
  );
}
