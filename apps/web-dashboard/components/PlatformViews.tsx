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
            <button className="danger" type="button" onClick={() => run(() => call(`firewall/${rule.id}`, { method: "DELETE" }, (s) => ({
              firewall: { ...s.firewall, rules: s.firewall.rules.filter((r) => r.id !== rule.id) },
            })), setToast, "Rule removed")}>Remove</button>
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
  const [selectedProject, setSelectedProject] = useState("");
  const [pending, setPending] = useState(false);
  const projects = state.projects.filter((project) => project.repoUrl);
  const projectId = projects.find((project) => project.id === selectedProject)?.id ?? projects[0]?.id ?? "";

  return (
    <>
      <header className="page-head">
        <div>
          <h2>Web builds</h2>
          <p>Build requests are recorded, but execution is disabled. Android builds and cache purges are not supported here.</p>
        </div>
        <form className="form-row" onSubmit={(e) => {
          e.preventDefault();
          if (!projectId || pending) return;
          setPending(true);
          void run(() => call("builds", { method: "POST", body: JSON.stringify({ projectId, target: "web" }) }), setToast, "Build request recorded").finally(() => setPending(false));
        }}>
          <select aria-label="Project" value={projectId} onChange={(e) => setSelectedProject(e.target.value)} disabled={!projects.length}>
            {!projects.length && <option value="">No project with a repository</option>}
            {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
          <button className="primary" type="submit" disabled={!projectId || pending}>{pending ? "Submitting…" : "Request web build"}</button>
        </form>
      </header>

      <article className="panel">
        {state.builds.map((build) => (
          <div key={build.id} className="list-row" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <div className="name"><strong>{build.project}</strong> · <span style={{ opacity: 0.8 }}>{build.target}</span> · <span style={{ color: build.status === "success" || build.status === "live" ? "#3ddc84" : "#ffaa00" }}>{build.status}</span></div>
              <div className="sub">{build.note} · <ClientTime ts={build.createdAt} /></div>
            </div>
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
  const [steps, setSteps] = useState('[{"function":"quote"}]');
  const [drive, setDrive] = useState("");
  return (
    <>
      <header className="page-head"><div><h2>Workflows and drives</h2><p>A workflow runs an ordered list of your functions and stops at the first failure. Drives are real directories on this server, not microVM volumes.</p></div></header>
      <form className="form-row" onSubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(steps || "[]");
          } catch {
            setToast("Steps must be a JSON array");
            return undefined;
          }
          const result = await call("workflows", { method: "POST", body: JSON.stringify({ name, steps: parsed }) });
          setName((value) => value === name ? "" : value);
          return result;
        }, setToast, "Workflow saved");
      }}>
        <input aria-label="Workflow name" placeholder="nightly-audit" value={name} onChange={(e) => setName(e.target.value)} required />
        <button className="primary" type="submit">Save workflow</button>
      </form>
      <article className="panel">
        <label className="sub" htmlFor="wf-steps">Steps: a JSON array of {"{"} function, input {"}"} referencing a function name or id</label>
        <textarea id="wf-steps" className="code" rows={3} value={steps} onChange={(e) => setSteps(e.target.value)} spellCheck={false} />
      </article>
      <article className="panel">
        {state.workflows.map((workflow) => (
          <div key={workflow.id} className="list-row" style={{ gridTemplateColumns: "1fr auto" }}>
            <div>
              <div className="name">{workflow.name}</div>
              <div className="sub">{workflow.stepCount ?? 0} step{workflow.stepCount === 1 ? "" : "s"} · {workflow.lastRun ? `${workflow.lastRun.status}: ${workflow.lastRun.note}` : "No run recorded"}</div>
            </div>
            <button className="ghost" type="button" onClick={() => run(() => call(`workflows/${workflow.id}/run`, { method: "POST" }), setToast, "Workflow ran")}>Run</button>
          </div>
        ))}
        {state.workflows.length === 0 && <p className="empty">No workflows stored.</p>}
      </article>
      <form className="form-row" onSubmit={(e) => { e.preventDefault(); void run(async () => { const result = await call("drives", { method: "POST", body: JSON.stringify({ name: drive }) }); setDrive((value) => value === drive ? "" : value); return result; }, setToast, "Directory created"); }}>
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

/** Renders an 18-decimal u128 base-unit string without floating-point rounding. */
function baseUnits(raw: string): string {
  const digits = raw.replace(/^0+(?=\d)/, "");
  const padded = digits.padStart(19, "0");
  const whole = padded.slice(0, -18).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const fraction = padded.slice(-18).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

export function ProofOfReserveView() {
  const por = useCloud().state.por;
  const attestation = por.attestation;
  return (
    <>
      <header className="page-head">
        <div>
          <h2>Proof of reserve</h2>
          <p>Reconciliation runs in the Rust por-kernel; this console stores and serves its output read-only. It never computes a reserve ratio, so until an attestation is published the state is honestly unverified.</p>
        </div>
      </header>
      <article className="panel">
        <div className={`sub ${por.verified ? "" : "notice"}`}>{por.status} · {por.reason}</div>
      </article>
      {attestation && (
        <>
          <section className="stats">
            <article className="stat"><div><b>{attestation.status}</b><span>Reserve status</span></div></article>
            <article className="stat"><div><b>{(attestation.reserveRatioBps / 100).toFixed(2)}%</b><span>Reserve ratio</span></div></article>
            <article className="stat"><div><b>{attestation.evidenceAgeSec}s</b><span>Evidence age</span></div></article>
            <article className="stat"><div><b>{attestation.ledgerSequence ?? "—"}</b><span>Ledger sequence</span></div></article>
          </section>
          <article className="panel">
            <h3>Balance sheet (18-decimal base units)</h3>
            <div className="list-row"><div className="name">Total backing</div><div className="sub">{baseUnits(attestation.totalBackingBase)}</div></div>
            <div className="list-row"><div className="name">Total liabilities</div><div className="sub">{baseUnits(attestation.totalLiabilitiesBase)}</div></div>
            <div className="list-row"><div className="name">Net difference</div><div className="sub">{baseUnits(attestation.netDifferenceBase)}</div></div>
          </article>
          <article className="panel">
            <div className="list-row"><div className="name">Digest</div><div className="sub">{attestation.digest ?? "not provided"}</div></div>
            <div className="list-row"><div className="name">Quorum</div><div className="sub">{attestation.quorum ?? "not provided"}</div></div>
            <div className="list-row"><div className="name">Observed</div><div className="sub"><ClientTime ts={attestation.observedAt} /></div></div>
            <div className="list-row"><div className="name">Recorded</div><div className="sub"><ClientTime ts={attestation.recordedAt} /></div></div>
          </article>
        </>
      )}
    </>
  );
}
