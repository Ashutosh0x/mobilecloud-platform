"use client";

import { FormEvent, useMemo, useState } from "react";
import { formatBytes } from "@/lib/format";
import { useCloud } from "@/lib/store";
import { ClientTime, Duration } from "./Time";

function useFiltered<T>(rows: T[], pick: (row: T) => string) {
  const { state } = useCloud();
  const q = state.query.trim().toLowerCase();
  return rows.filter((row) => !q || pick(row).toLowerCase().includes(q));
}

async function run(action: () => Promise<unknown>, setToast: (m: string | null) => void, ok: string) {
  try {
    const result = await action();
    const note = result && typeof result === "object" && "note" in result && typeof result.note === "string" ? result.note : ok;
    setToast(note);
  } catch (error) {
    setToast(error instanceof Error ? error.message : "Request failed");
  }
}

export function ProjectsView() {
  const { state, call, setToast } = useCloud();
  const [name, setName] = useState("");
  const [framework, setFramework] = useState("Next.js");
  const [drop, setDrop] = useState<string | null>(null);
  const rows = useFiltered(state.projects, (p) => `${p.name} ${p.framework}`);

  return (
    <>
      <header className="page-head">
        <div>
          <h2>Projects</h2>
          <p>Records stored in this server’s database. A project does not deploy by itself.</p>
        </div>
        <form className="form-row" onSubmit={(e) => {
          e.preventDefault();
          run(() => call("projects", { method: "POST", body: JSON.stringify({ name, framework }) }), setToast, "Project saved");
          setName("");
        }}>
          <input aria-label="Project name" placeholder="project-name" value={name} onChange={(e) => setName(e.target.value)} required />
          <select aria-label="Framework" value={framework} onChange={(e) => setFramework(e.target.value)}>
            {["Next.js", "Vite", "Astro", "Nuxt", "Remix", "React"].map((f) => <option key={f}>{f}</option>)}
          </select>
          <button className="primary" type="submit">Create</button>
        </form>
      </header>
      <div className="cards">
        {rows.map((p) => {
          const last = state.deployments.find((d) => d.projectId === p.id);
          return (
            <article key={p.id} className="panel card-block">
              <div className="name">{p.name}</div>
              <div className="sub">{p.framework} · {p.target}</div>
              <p className="sub">{last ? `${last.status} · ${last.note}` : "No deployment recorded"}</p>
              <div className="form-row">
                <button className="primary" type="button" onClick={() => run(() => call("deployments", { method: "POST", body: JSON.stringify({ projectId: p.id }) }), setToast, "Recorded")}>Request deploy</button>
                <button className="danger" type="button" onClick={() => setDrop(p.id)}>Delete</button>
              </div>
            </article>
          );
        })}
      </div>
      {rows.length === 0 && <p className="empty">No projects stored for this account.</p>}
      {drop && (
        <Confirm title="Delete this project?" body="Deployments and domain records for it are removed. Files already written are left on disk." onCancel={() => setDrop(null)} onYes={() => {
          const id = drop;
          setDrop(null);
          run(() => call(`projects/${id}`, { method: "DELETE" }, (s) => ({
            // Optimistic: hide it immediately, restore it if the server refuses.
            projects: s.projects.filter((p) => p.id !== id),
          })), setToast, "Project deleted");
        }} />
      )}
    </>
  );
}

export function DeploymentsView() {
  const { state } = useCloud();
  const [status, setStatus] = useState("All");
  const rows = useFiltered(state.deployments, (d) => `${d.project} ${d.status} ${d.note}`).filter((d) => status === "All" || d.status === status);
  return (
    <>
      <header className="page-head">
        <div>
          <h2>Deployments</h2>
          <p>A request is stored as blocked unless a build runner accepts it. Nothing is marked ready from a timer.</p>
        </div>
        <select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
          {["All", "blocked", "failed"].map((s) => <option key={s}>{s}</option>)}
        </select>
      </header>
      <article className="panel">
        <table className="table">
          <thead><tr><th>PROJECT</th><th>STATUS</th><th>WHEN</th><th>NOTE</th></tr></thead>
          <tbody>
            {rows.map((d) => (
              <tr key={d.id}>
                <td>{d.project}</td>
                <td className="badge warn">{d.status}</td>
                <td><ClientTime ts={d.createdAt} /></td>
                <td>{d.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <p className="empty">No deployment records match.</p>}
      </article>
    </>
  );
}

export function DomainsView() {
  const { state, call, setToast } = useCloud();
  const [host, setHost] = useState("");
  const [project, setProject] = useState(state.projects[0]?.name ?? "");
  const [drop, setDrop] = useState<string | null>(null);
  const rows = useFiltered(state.domains, (d) => `${d.host} ${d.project}`);
  return (
    <>
      <header className="page-head">
        <div>
          <h2>Domains</h2>
          <p>Hostnames are saved locally. No DNS provider is configured, so nothing is published.</p>
        </div>
        <form className="form-row" onSubmit={(e) => {
          e.preventDefault();
          run(() => call("domains", { method: "POST", body: JSON.stringify({ host, project }) }), setToast, "Hostname recorded");
          setHost("");
        }}>
          <input aria-label="Hostname" placeholder="app.example.com" value={host} onChange={(e) => setHost(e.target.value)} required />
          <select aria-label="Project" value={project} onChange={(e) => setProject(e.target.value)}>
            {state.projects.map((p) => <option key={p.id}>{p.name}</option>)}
          </select>
          <button className="primary" type="submit" disabled={!state.projects.length}>Record</button>
        </form>
      </header>
      <article className="panel">
        {rows.map((d) => (
          <div key={d.id} className="list-row" style={{ gridTemplateColumns: "1fr auto" }}>
            <div><div className="name">{d.host}</div><div className="sub">{d.project} · {d.status} · {d.detail}</div></div>
            <button className="danger" type="button" onClick={() => setDrop(d.id)}>Remove</button>
          </div>
        ))}
        {rows.length === 0 && <p className="empty">No hostnames recorded.</p>}
      </article>
      {drop && <Confirm title="Remove this hostname?" body="Only the local record is deleted." onCancel={() => setDrop(null)} onYes={() => { const id = drop; setDrop(null); run(() => call(`domains/${id}`, { method: "DELETE" }, (s) => ({ domains: s.domains.filter((d) => d.id !== id) })), setToast, "Hostname removed"); }} />}
    </>
  );
}

export function DatabasesView() {
  const { state, call, setToast } = useCloud();
  const [name, setName] = useState("");
  const rows = useFiltered(state.databases, (d) => d.name);
  return (
    <>
      <header className="page-head">
        <div><h2>Databases</h2><p>Each database is an empty SQLite file on this server. Size is read from the filesystem.</p></div>
        <form className="form-row" onSubmit={(e) => { e.preventDefault(); run(() => call("databases", { method: "POST", body: JSON.stringify({ name }) }), setToast, "Database file created"); setName(""); }}>
          <input aria-label="Database name" placeholder="ledger" value={name} onChange={(e) => setName(e.target.value)} required />
          <button className="primary" type="submit">Create file</button>
        </form>
      </header>
      <article className="panel">
        {rows.map((d) => (
          <div key={d.id} className="list-row">
            <div className="name">{d.name}</div>
            <div className="sub">{d.engine} · {d.bytes == null ? "file missing" : formatBytes(d.bytes)}</div>
          </div>
        ))}
        {rows.length === 0 && <p className="empty">No database files yet.</p>}
      </article>
    </>
  );
}

export function FunctionsView() {
  const { state, call, setToast } = useCloud();
  const [name, setName] = useState("");
  const [route, setRoute] = useState("/api/");
  const rows = useFiltered(state.functions, (f) => `${f.name} ${f.route}`);
  return (
    <>
      <header className="page-head">
        <div><h2>Functions</h2><p>Names and routes are stored. Invocation is refused until handler source exists, and the counter is not incremented.</p></div>
        <form className="form-row" onSubmit={(e) => { e.preventDefault(); run(() => call("functions", { method: "POST", body: JSON.stringify({ name, route }) }), setToast, "Function registered"); setName(""); }}>
          <input aria-label="Function name" placeholder="quote" value={name} onChange={(e) => setName(e.target.value)} required />
          <input aria-label="Route" value={route} onChange={(e) => setRoute(e.target.value)} required />
          <button className="primary" type="submit">Register</button>
        </form>
      </header>
      <article className="panel">
        {rows.map((f) => (
          <div key={f.id} className="list-row" style={{ gridTemplateColumns: "1fr auto" }}>
            <div><div className="name">{f.name}</div><div className="sub">{f.route} · source {f.hasSource ? "stored" : "missing"} · {f.invocations} invocations</div></div>
            <button className="ghost" type="button" onClick={() => run(() => call(`functions/${f.id}/invoke`, { method: "POST" }), setToast, "Invoked")}>Invoke</button>
          </div>
        ))}
        {rows.length === 0 && <p className="empty">No functions registered.</p>}
      </article>
    </>
  );
}

export function StorageView() {
  const { state, call, setToast } = useCloud();
  const [bucket, setBucket] = useState("assets");
  const [key, setKey] = useState("");
  const [content, setContent] = useState("");
  const rows = useFiltered(state.objects, (o) => `${o.bucket} ${o.key}`);
  const used = state.objects.reduce((sum, o) => sum + o.bytes, 0);
  return (
    <>
      <header className="page-head">
        <div><h2>Storage</h2><p>Uploads are written under the server data directory, up to 1 MB. Usage is the sum of stored file sizes: {formatBytes(used)}.</p></div>
      </header>
      <form className="panel form-row" onSubmit={(e) => {
        e.preventDefault();
        const bytes = new TextEncoder().encode(content);
        let bin = "";
        bytes.forEach((b) => { bin += String.fromCharCode(b); });
        run(() => call("storage", { method: "POST", body: JSON.stringify({ bucket, key, contentBase64: btoa(bin) }) }), setToast, "Object written");
        setContent("");
      }}>
        <input aria-label="Bucket" value={bucket} onChange={(e) => setBucket(e.target.value)} required />
        <input aria-label="Object key" placeholder="notes/readme.txt" value={key} onChange={(e) => setKey(e.target.value)} required />
        <input aria-label="Contents" placeholder="file contents" value={content} onChange={(e) => setContent(e.target.value)} required />
        <button className="primary" type="submit">Upload</button>
      </form>
      <article className="panel">
        {rows.map((o) => <div key={o.id} className="list-row"><div className="name">{o.bucket}/{o.key}</div><div className="sub">{formatBytes(o.bytes)} on disk</div></div>)}
        {rows.length === 0 && <p className="empty">No objects stored.</p>}
      </article>
    </>
  );
}

export function MonitoringView() {
  const { state } = useCloud();
  const m = state.metrics;
  return (
    <>
      <header className="page-head"><div><h2>Monitoring</h2><p>Values come from the operating system and this process. Unmeasured signals are listed, not drawn as zero.</p></div></header>
      {!m && <p className="empty">Metrics are unavailable.</p>}
      {m && (
        <div className="cards">
          <article className="panel"><h3>CPU busy since boot</h3><b>{m.cpuBusySinceBootPct == null ? "Not measured" : `${m.cpuBusySinceBootPct}%`}</b><p className="sub">From os.cpus() times, not a live interval.</p></article>
          <article className="panel"><h3>Memory</h3><b>{m.memoryUsedPct == null ? "Not measured" : `${m.memoryUsedPct}%`}</b><p className="sub">{formatBytes(m.memoryUsedBytes)} of {formatBytes(m.memoryTotalBytes)}</p></article>
          <article className="panel"><h3>Disk</h3><b>{m.diskFreeBytes == null ? "Not measured" : `${formatBytes(m.diskFreeBytes)} free`}</b><p className="sub">{m.diskTotalBytes ? `of ${formatBytes(m.diskTotalBytes)}` : "statfs unread"} · data dir {formatBytes(m.dataDirBytes)}</p></article>
          <article className="panel"><h3>Responses</h3><b>{m.responseAvgMs == null ? "No samples" : `${m.responseAvgMs} ms`}</b><p className="sub">{m.responseSamples} logged requests in 24h · process <Duration seconds={m.processUptimeSec} /></p></article>
        </div>
      )}
      {m && <article className="panel"><h3>Not measured</h3><ul>{m.unavailable.map((line) => <li key={line}>{line}</li>)}</ul><p className="sub">Collected <ClientTime ts={m.collectedAt} /></p></article>}
    </>
  );
}

export function LogsView() {
  const { state } = useCloud();
  const [level, setLevel] = useState("All");
  const rows = useFiltered(state.logs, (l) => `${l.source} ${l.message}`).filter((l) => level === "All" || l.level === level);
  return (
    <>
      <header className="page-head">
        <div><h2>Logs</h2><p>Entries written by this server for your account.</p></div>
        <select aria-label="Level" value={level} onChange={(e) => setLevel(e.target.value)}>{["All", "info", "warn", "error"].map((l) => <option key={l}>{l}</option>)}</select>
      </header>
      <article className="panel">
        {rows.map((l) => (
          <div key={l.id} className="list-row" style={{ gridTemplateColumns: "72px 1fr auto" }}>
            <span className={`badge ${l.level === "error" ? "error" : l.level === "warn" ? "warn" : "info"}`}>{l.level}</span>
            <div><div className="name">{l.message}</div><div className="sub">{l.source}</div></div>
            <ClientTime ts={l.at} />
          </div>
        ))}
        {rows.length === 0 && <p className="empty">No log lines match.</p>}
      </article>
    </>
  );
}

export function SettingsView() {
  const { state, call, setToast } = useCloud();
  const [name, setName] = useState(state.user?.name ?? "");
  const [tokenName, setTokenName] = useState("");
  const [days, setDays] = useState("30");
  const [shown, setShown] = useState<string | null>(null);
  const [hookUrl, setHookUrl] = useState("");
  const [hookSecret, setHookSecret] = useState<string | null>(null);
  const [gate, setGate] = useState("");
  const [device, setDevice] = useState("");
  return (
    <>
      <header className="page-head"><div><h2>Settings</h2><p>Sessions, tokens, and the identity providers this server can actually use.</p></div></header>
      <form className="panel" onSubmit={(e) => { e.preventDefault(); run(() => call("profile", { method: "POST", body: JSON.stringify({ name }) }), setToast, "Name saved"); }}>
        <label className="field">Display name<input value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} /></label>
        <button className="primary" type="submit">Save name</button>
      </form>
      <article className="panel">
        <div className="toggle">
          <div><b>Record page views</b><div className="sub">When on, opening a page writes a log line and a request sample.</div></div>
          <button className={state.settings.recordPageViews ? "primary" : "ghost"} type="button" onClick={() => run(() => call("settings", { method: "POST", body: JSON.stringify({ recordPageViews: !state.settings.recordPageViews }) }), setToast, "Setting saved")}>{state.settings.recordPageViews ? "On" : "Off"}</button>
        </div>
      </article>

      <article className="panel">
        <h3>Sessions</h3>
        <p className="sub">This browser session stays until you sign out. Other sessions can be revoked.</p>
        {state.sessions.map((session) => (
          <div key={session.id} className="list-row">
            <div>
              <div className="name">{session.current ? "This browser" : "Other session"}</div>
              <div className="sub">{session.userAgent}</div>
            </div>
            {!session.current && <button className="ghost" type="button" onClick={() => run(() => call(`sessions/${session.id}`, { method: "DELETE" }), setToast, "Session revoked")}>Revoke</button>}
          </div>
        ))}
        {state.sessions.length === 0 && <p className="empty">No sessions recorded.</p>}
      </article>

      <form className="panel" onSubmit={async (e) => {
        e.preventDefault();
        try {
          const result = await call("tokens", { method: "POST", body: JSON.stringify({ name: tokenName, days: Number(days) }) }) as { token?: string };
          setShown(result.token ?? null);
          setTokenName("");
          setToast("Token created. Copy it now. It is stored only as a hash.");
        } catch (error) {
          setToast(error instanceof Error ? error.message : "Request failed");
        }
      }}>
        <h3>Access tokens</h3>
        <div className="form-row">
          <input aria-label="Token name" placeholder="Name" value={tokenName} onChange={(e) => setTokenName(e.target.value)} required />
          <select aria-label="Expiry" value={days} onChange={(e) => setDays(e.target.value)}>
            <option value="7">7 days</option>
            <option value="30">30 days</option>
            <option value="90">90 days</option>
            <option value="0">No expiry</option>
          </select>
          <button className="primary" type="submit">Create</button>
        </div>
        {shown && <p className="banner">Shown once: <code>{shown}</code></p>}
        {state.tokens.map((token) => (
          <div key={token.id} className="list-row">
            <div><div className="name">{token.name}</div><div className="sub">{token.prefix}… · {token.expiresAt ? "expires" : "no expiry"}</div></div>
            <button className="ghost" type="button" onClick={() => run(() => call(`tokens/${token.id}`, { method: "DELETE" }), setToast, "Token revoked")}>Revoke</button>
          </div>
        ))}
      </form>

      <form className="panel" onSubmit={(e) => { e.preventDefault(); run(() => call("device/approve", { method: "POST", body: JSON.stringify({ userCode: device }) }), setToast, "Device approved"); setDevice(""); }}>
        <h3>Approve a device code</h3>
        <p className="sub">A client calls the device-code API, then you confirm the code here. No password is entered in a shell.</p>
        <div className="form-row">
          <input aria-label="Device code" placeholder="ABCD-EFGH" value={device} onChange={(e) => setDevice(e.target.value)} required />
          <button className="primary" type="submit">Approve</button>
        </div>
      </form>

      <form className="panel" onSubmit={(e) => { e.preventDefault(); run(() => call("protection", { method: "POST", body: JSON.stringify({ password: gate }) }), setToast, "Console password saved"); setGate(""); }}>
        <h3>Console password</h3>
        <p className="sub">Optional extra password for this browser. It is stored as a scrypt hash. This is not an edge network gate.</p>
        <div className="form-row">
          <input aria-label="Console password" type="password" placeholder="At least 8 characters" value={gate} onChange={(e) => setGate(e.target.value)} minLength={8} required />
          <button className="primary" type="submit">Set password</button>
        </div>
        {state.protection.required && <button className="ghost" type="button" onClick={() => run(() => call("protection", { method: "DELETE" }), setToast, "Console password removed")}>Remove password</button>}
      </form>

      <form className="panel" onSubmit={async (e) => {
        e.preventDefault();
        try {
          const result = await call("webhooks", { method: "POST", body: JSON.stringify({ url: hookUrl }) }) as { secret?: string };
          setHookSecret(result.secret ?? null);
          setHookUrl("");
          setToast("Webhook saved. Copy the signing secret.");
        } catch (error) {
          setToast(error instanceof Error ? error.message : "Request failed");
        }
      }}>
        <h3>Webhooks</h3>
        <p className="sub">This server POSTs JSON and an HMAC-SHA256 signature when a deployment is blocked, a firewall rule denies a request, or a session is created. Delivery errors are not retried.</p>
        <div className="form-row">
          <input aria-label="Webhook URL" placeholder="https://example.com/hooks" value={hookUrl} onChange={(e) => setHookUrl(e.target.value)} required />
          <button className="primary" type="submit">Add</button>
        </div>
        {hookSecret && <p className="banner">Signing secret, shown once: <code>{hookSecret}</code></p>}
        {state.webhooks.map((hook) => (
          <div key={hook.id} className="list-row">
            <div><div className="name">{hook.url}</div><div className="sub">{hook.events}</div></div>
            <button className="ghost" type="button" onClick={() => run(() => call(`webhooks/${hook.id}`, { method: "DELETE" }), setToast, "Webhook removed")}>Remove</button>
          </div>
        ))}
      </form>

      <article className="panel">
        <h3>Identity providers</h3>
        {state.identity.map((item) => (
          <div key={item.name} className="list-row">
            <div><div className="name">{item.name}</div><div className="sub">{item.detail}</div></div>
            <span className={`badge ${item.state === "active" ? "ok" : "warn"}`}>{item.state}</span>
          </div>
        ))}
      </article>
    </>
  );
}

export function TeamView() {
  const { state, call, setToast } = useCloud();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const rows = useFiltered(state.team, (m) => `${m.name} ${m.email}`);
  return (
    <>
      <header className="page-head"><div><h2>Team</h2><p>Invites are stored. SMTP is not configured, so no email is sent.</p></div></header>
      <form className="form-row" onSubmit={(e) => { e.preventDefault(); run(() => call("team", { method: "POST", body: JSON.stringify({ name, email }) }), setToast, "Invite saved. No email was sent."); setName(""); setEmail(""); }}>
        <input aria-label="Name" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} required />
        <input aria-label="Email" type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <button className="primary" type="submit">Save invite</button>
      </form>
      <article className="panel">
        {rows.map((m) => <div key={m.id} className="list-row"><div className="name">{m.name}</div><div className="sub">{m.email} · {m.role} · {m.emailSent ? "account" : "invite stored, email not sent"}</div></div>)}
      </article>
    </>
  );
}

export function BillingView() {
  const { state, call, setToast } = useCloud();
  const plans = ["community", "mesh", "hardware"];
  return (
    <>
      <header className="page-head"><div><h2>Billing</h2><p>{state.billing?.detail}</p></div></header>
      <div className="plans">
        {plans.map((plan) => (
          <button key={plan} className={`panel plan${state.billing?.plan === plan ? " on" : ""}`} type="button" onClick={() => run(() => call("billing", { method: "POST", body: JSON.stringify({ plan }) }), setToast, "Plan preference saved. Nothing was charged.")}>
            <b>{plan}</b>
            <div className="sub">{state.billing?.plan === plan ? "Stored preference" : "Save as preference"}</div>
          </button>
        ))}
      </div>
    </>
  );
}

export function ShellPage() {
  const { state, call, pushShell, setToast } = useCloud();
  const [line, setLine] = useState("");
  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const command = line;
    setLine("");
    pushShell(`$ ${command}`);
    try {
      const data = await call("shell", { method: "POST", body: JSON.stringify({ command }) }) as { output: string };
      pushShell(data.output);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Shell failed";
      pushShell(message);
      setToast(message);
    }
  }
  return (
    <>
      <header className="page-head"><div><h2>CloudShell</h2><p>Commands are a fixed list. They read this database. They do not open a host shell.</p></div></header>
      <div className="term">
        {state.shell.map((row, i) => <div key={`${i}-${row.slice(0, 12)}`} className={row.startsWith("$") ? "cmd" : ""}>{row}</div>)}
        <form onSubmit={onSubmit}>
          <span>$</span>
          <input aria-label="Command" value={line} onChange={(e) => setLine(e.target.value)} placeholder="help" />
        </form>
      </div>
    </>
  );
}

export function AnalyticsView() {
  const { state, setRange } = useCloud();
  const points = state.analytics?.points ?? [];
  const max = Math.max(1, ...points.map((p) => p.count));
  const ticks = useMemo(() => points.filter((_, i) => i % Math.ceil(points.length / 6) === 0), [points]);
  return (
    <>
      <header className="page-head">
        <div><h2>Analytics</h2><p>Requests this server recorded for your account. {state.analytics ? `${state.analytics.total} in view.` : ""}</p></div>
        <div className="ranges">{(["1h", "24h", "7d", "30d"] as const).map((range) => <button key={range} type="button" className={state.range === range ? "on" : ""} onClick={() => setRange(range)}>{range}</button>)}</div>
      </header>
      <article className="panel">
        {!state.analytics && <p className="skeleton" />}
        {state.analytics && state.analytics.total === 0 && <p className="empty">No requests recorded in this window.</p>}
        {state.analytics && state.analytics.total > 0 && (
          <>
            <div className="chart-wrap">
              <svg viewBox="0 0 300 90" preserveAspectRatio="none">
                {points.map((point, i) => (
                  <rect key={`${point.label}-${i}`} x={i * (300 / points.length)} y={90 - (point.count / max) * 84} width={Math.max(1, 300 / points.length - 1)} height={(point.count / max) * 84} fill="#3B82F6">
                    <title>{`${point.label}: ${point.count}`}</title>
                  </rect>
                ))}
              </svg>
            </div>
            <div className="sub">{ticks.map((t) => t.label).join("  ·  ")}</div>
          </>
        )}
      </article>
    </>
  );
}

function Confirm({ title, body, onYes, onCancel }: { title: string; body: string; onYes: () => void; onCancel: () => void }) {
  return (
    <div className="modal-back" onClick={onCancel}>
      <div className="modal" role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        <p>{body}</p>
        <div className="form-row">
          <button className="ghost" type="button" onClick={onCancel}>Cancel</button>
          <button className="danger" type="button" onClick={onYes}>Confirm</button>
        </div>
      </div>
    </div>
  );
}
