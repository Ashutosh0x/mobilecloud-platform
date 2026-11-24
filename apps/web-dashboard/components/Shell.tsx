"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { request, useCloud } from "@/lib/store";
import { realtimeLabel } from "@/lib/realtime";
import { Icon } from "./Icons";

const GROUPS = [
  { label: "Project", items: [
    { href: "/", label: "Overview", icon: "home" },
    { href: "/projects", label: "Projects", icon: "folder" },
    { href: "/deployments", label: "Deployments", icon: "rocket" },
    { href: "/builds", label: "Builds", icon: "rocket" },
  ] },
  { label: "Observe", items: [
    { href: "/logs", label: "Logs", icon: "logs" },
    { href: "/analytics", label: "Analytics", icon: "chart" },
    { href: "/monitoring", label: "Monitoring", icon: "activity" },
    { href: "/observability", label: "Observability", icon: "activity" },
    { href: "/speed", label: "Speed", icon: "zap" },
  ] },
  { label: "Security", items: [
    { href: "/firewall", label: "Firewall", icon: "shield" },
    { href: "/device", label: "Link device", icon: "shield" },
    { href: "/settings", label: "Settings", icon: "gear" },
  ] },
  { label: "Infrastructure", items: [
    { href: "/domains", label: "Domains", icon: "globe" },
    { href: "/storage", label: "Storage", icon: "box" },
    { href: "/databases", label: "Databases", icon: "db" },
    { href: "/functions", label: "Functions", icon: "zap" },
    { href: "/workflows", label: "Workflows", icon: "grid" },
    { href: "/shell", label: "CloudShell", icon: "grid" },
    { href: "/node", label: "Node console", icon: "android" },
    { href: "/team", label: "Team", icon: "users" },
    { href: "/billing", label: "Billing", icon: "card" },
  ] },
];

const ALL = GROUPS.flatMap((group) => group.items);
const GO: Record<string, string> = { o: "/", p: "/projects", d: "/deployments", a: "/analytics", f: "/firewall", l: "/logs", s: "/settings", b: "/builds" };

function Gate() {
  const { call, setToast } = useCloud();
  const [password, setPassword] = useState("");
  return (
    <form className="panel" onSubmit={async (e) => {
      e.preventDefault();
      try {
        await call("protection/unlock", { method: "POST", body: JSON.stringify({ password }) });
        setToast("Console unlocked");
      } catch (error) {
        setToast(error instanceof Error ? error.message : "Password does not match");
      }
    }}>
      <h3>Browser screen lock</h3>
      <p className="sub">Enter your screen lock password to continue in this browser.</p>
      <label className="field">Password<input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
      <button className="primary" type="submit">Unlock</button>
    </form>
  );
}

export function Shell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const router = useRouter();
  const { state, setQuery, setToast, logout, call, realtimeRetry } = useCloud();
  const unread = state.notifications.filter((item) => !item.read).length;
  const [collapsed, setCollapsed] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [jump, setJump] = useState(false);
  const [notes, setNotes] = useState(false);
  const [account, setAccount] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [palette, setPalette] = useState("");
  const [help, setHelp] = useState(false);
  const jumpDialog = useRef<HTMLDialogElement>(null);
  const helpDialog = useRef<HTMLDialogElement>(null);
  const go = useRef(false);

  useEffect(() => {
    const dialog = jumpDialog.current;
    if (!dialog) return;
    if (jump) dialog.showModal();
    else dialog.close();
  }, [jump]);

  useEffect(() => {
    const dialog = helpDialog.current;
    if (!dialog) return;
    if (help) dialog.showModal();
    else dialog.close();
  }, [help]);
  const here = ALL.find((item) => item.href === path);

  const hits = useMemo(() => {
    const q = palette.toLowerCase();
    const pages = ALL.filter((n) => n.label.toLowerCase().includes(q));
    const projects = state.projects
      .filter((p) => p.name.includes(q))
      .map((p) => ({ href: "/projects", label: p.name, icon: "folder" }));
    return [...pages, ...projects].slice(0, 8);
  }, [palette, state.projects]);

  useEffect(() => {
    if (state.status === "anon") router.replace("/login");
  }, [state.status, router]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (jumpDialog.current?.open || helpDialog.current?.open) return;
      const target = e.target as HTMLElement | null;
      const typing = !!target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable);
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setJump(true);
        return;
      }
      if (e.key === "Escape") {
        setJump(false);
        setNotes(false);
        setAccount(false);
        setDrawer(false);
        setHelp(false);
        return;
      }
      if (typing) return;
      if (e.key === "?") {
        e.preventDefault();
        setHelp(true);
        return;
      }
      if (e.key.toLowerCase() === "g" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        go.current = true;
        window.setTimeout(() => { go.current = false; }, 800);
        return;
      }
      if (go.current && GO[e.key.toLowerCase()]) {
        e.preventDefault();
        router.push(GO[e.key.toLowerCase()]);
        go.current = false;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router]);

  useEffect(() => {
    if (!state.toast) return;
    const id = setTimeout(() => setToast(null), 3200);
    return () => clearTimeout(id);
  }, [state.toast, setToast]);

  useEffect(() => { setDrawer(false); setAccount(false); setNotes(false); }, [path]);

  useEffect(() => {
    if (state.status !== "ready") return;
    const posted = new Set<string>();
    const send = (metric: string, value: number) => {
      if (posted.has(metric) || !Number.isFinite(value)) return;
      posted.add(metric);
      void request("vitals", {
        method: "POST",
        keepalive: true,
        body: JSON.stringify({ metric, value, path }),
      }).catch(() => undefined);
    };
    let cls = 0;
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.entryType === "largest-contentful-paint") send("LCP", entry.startTime);
        if (entry.entryType === "paint" && entry.name === "first-contentful-paint") send("FCP", entry.startTime);
        if (entry.entryType === "navigation") send("TTFB", (entry as PerformanceNavigationTiming).responseStart);
        if (entry.entryType === "layout-shift" && !(entry as PerformanceEntry & { hadRecentInput?: boolean }).hadRecentInput) {
          cls += (entry as PerformanceEntry & { value?: number }).value ?? 0;
        }
        if (entry.entryType === "event" && (entry as PerformanceEventTiming).duration > 0) send("INP", (entry as PerformanceEventTiming).duration);
      }
    });
    try {
      observer.observe({ type: "largest-contentful-paint", buffered: true });
      observer.observe({ type: "paint", buffered: true });
      observer.observe({ type: "navigation", buffered: true });
      observer.observe({ type: "layout-shift", buffered: true });
      observer.observe({ type: "event", buffered: true, durationThreshold: 40 } as PerformanceObserverInit);
    } catch {
      /* this browser did not expose one of the entry types */
    }
    const flushCls = () => { if (cls > 0) send("CLS", cls); };
    const timer = window.setTimeout(flushCls, 4000);
    window.addEventListener("pagehide", flushCls);
    return () => {
      observer.disconnect();
      window.clearTimeout(timer);
      window.removeEventListener("pagehide", flushCls);
    };
  }, [path, state.status]);

  useEffect(() => {
    if (state.status !== "ready" || !state.settings.recordPageViews) return;
    void request("events", {
      method: "POST",
      keepalive: true,
      body: JSON.stringify({ path }),
    }).catch(() => undefined);
  }, [path, state.status, state.settings.recordPageViews]);

  const rt = state.realtime;
  const rtTone =
    rt.status === "connected"
      ? "online"
      : rt.status === "offline" || rt.status === "sync_error"
        ? "offline"
        : "pending";
  const rtTitle = [
    `Realtime: ${realtimeLabel(rt.status)}`,
    rt.transport ? `transport ${rt.transport}` : null,
    rt.pending > 0 ? `${rt.pending} new` : null,
    rt.lastSyncAt ? `last sync ${new Date(rt.lastSyncAt).toLocaleTimeString()}` : null,
    rt.lastError,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className={`console${collapsed ? " collapsed" : ""}`}>
      <header className="topbar">
        <button className="icon-btn" type="button" aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"} onClick={() => { if (window.innerWidth <= 800) setDrawer((v) => !v); else setCollapsed((v) => !v); }}>
          <Icon name="grid" size={16} />
        </button>
        <Link href="/" className="brand" aria-label="MobileCloud home">
          <span className="logo" aria-hidden="true">
            <svg viewBox="0 0 24 24" focusable="false">
              <path fill="#EDF7FF" d="M12 2.8 21.1 8 17.1 10.3 12 7.4 6.9 10.3 2.9 8Z" />
              <path fill="#9AB9FF" d="M2.9 10.6 10.8 15.1V20.4L2.9 15.8Z" />
              <path fill="#60E2E6" d="M21.1 10.6V15.8L13.2 20.4V15.1Z" />
              <path fill="#FFFFFF" d="M12 9.7 14.9 11.4 12 13.1 9.1 11.4Z" />
            </svg>
          </span>
          <span className="brand-copy">
            <h1>MobileCloud</h1>
            <p>Build. Ship. Scale.</p>
          </span>
        </Link>
        <div className="search">
          <Icon name="search" />
          <input
            placeholder="Filter this page"
            value={state.query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Filter current page"
          />
          <button className="ghost" type="button" aria-label="Search pages and projects" aria-haspopup="dialog" onClick={() => setJump(true)}>Ctrl K</button>
        </div>
        <div className="top-actions">
          <button className={rtTone} type="button" title={rtTitle} onClick={() => realtimeRetry()} style={{ background: "transparent", border: 0, cursor: "pointer" }}>
            <i className="dot" /> <span>{realtimeLabel(rt.status)}</span>
          </button>
          <button className="icon-btn" type="button" aria-label="Notifications" aria-expanded={notes} onClick={() => { setNotes((v) => !v); setAccount(false); }}>
            <Icon name="bell" />
            {unread > 0 && <i className="ping" />}
          </button>
          <button className="avatar" type="button" aria-label="Account menu" aria-expanded={account} onClick={() => { setAccount((v) => !v); setNotes(false); }}>
            <Icon name="user" size={18} />
          </button>
          {notes && (
            <div className="menu">
              <div className="sub">{unread > 0 ? `${unread} unread` : "Notifications"}</div>
              {state.notifications.slice(0, 8).map((item) => (
                <button key={item.id} type="button" onClick={() => {
                  // Optimistic: mark it read now, roll back if the server rejects it.
                  void call(`notifications/${item.id}`, { method: "PATCH" }, (s) => ({
                    notifications: s.notifications.map((n) => (n.id === item.id ? { ...n, read: true } : n)),
                  }));
                }}>
                  {item.title}{item.read ? "" : " · unread"}
                </button>
              ))}
              {state.notifications.length === 0 && <p className="empty">No notifications yet.</p>}
            </div>
          )}
          {account && state.user && (
            <div className="menu">
              <div className="sub">{state.user.name} · {state.user.role}</div>
              <Link href="/settings">Settings</Link>
              <Link href="/billing">Plan · {state.billing?.plan}</Link>
              <button type="button" onClick={() => logout()}>Sign out</button>
            </div>
          )}
        </div>
      </header>

      {drawer && <button className="drawer-back" aria-label="Close menu" onClick={() => setDrawer(false)} />}
      <aside className={`sidebar${drawer ? " open" : ""}`}>
        {GROUPS.map((group) => (
          <div key={group.label}>
            <div className="nav-section">{group.label}</div>
            {group.items.map((item) => (
              <Link key={item.href} href={item.href} title={item.label} className={`nav-link${path === item.href ? " active" : ""}`}>
                <Icon name={item.icon} />
                <span>{item.label}</span>
              </Link>
            ))}
          </div>
        ))}
        <div className="side-spacer" />
        <div className="side-note">
          <strong>Control plane</strong>
          <span>{state.error ?? (state.status === "ready" && state.metrics ? "SQLite on this server." : "Waiting for the API.")}</span>
          <em><i className="dot" /> {state.metrics ? `Up ${Math.floor(state.metrics.processUptimeSec / 60)}m` : "No metrics yet"}</em>
        </div>
      </aside>
      <main className="main">
        {here && <p className="crumb">{here.label}</p>}
        {state.status === "error" && (
          <p className="banner bad" role="alert">{state.error} <button className="ghost" type="button" onClick={() => window.location.reload()}>Retry</button></p>
        )}
        {state.status === "loading" || state.status === "anon" ? <p className="skeleton" aria-busy="true" /> : state.protection.required && !state.protection.unlocked ? <Gate /> : children}
      </main>

      <nav className="bottom-nav" aria-label="Primary">
        {GROUPS[0].items.map((item) => (
          <Link key={item.href} href={item.href} className={path === item.href ? "on" : ""}>
            <Icon name={item.icon} size={18} />
            {item.label === "Overview" ? "Home" : item.label.split(" ")[0]}
          </Link>
        ))}
        <button type="button" className={drawer ? "on" : ""} onClick={() => setDrawer((v) => !v)}>
          <Icon name="grid" size={18} />
          More
        </button>
      </nav>

      <dialog ref={jumpDialog} className="modal" aria-label="Jump to" onCancel={(event) => { event.preventDefault(); setJump(false); }}>
        <h3>Jump to</h3>
        <input
          aria-label="Pages and projects"
          placeholder="Pages and projects"
          value={palette}
          onChange={(e) => { setPalette(e.target.value); setCursor(0); }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") setCursor((c) => Math.min(hits.length - 1, c + 1));
            if (e.key === "ArrowUp") setCursor((c) => Math.max(0, c - 1));
            if (e.key === "Enter" && hits[cursor]) {
              router.push(hits[cursor].href);
              setJump(false);
            }
          }}
        />
        {hits.map((h, i) => (
          <button key={`${h.href}-${h.label}`} className={`hit${i === cursor ? " on" : ""}`} type="button" onClick={() => { router.push(h.href); setJump(false); }}>
            {h.label}
          </button>
        ))}
        {hits.length === 0 && <p className="empty">Nothing matches.</p>}
        <button className="ghost" type="button" onClick={() => setJump(false)}>Close</button>
      </dialog>
      <dialog ref={helpDialog} className="modal" aria-label="Keyboard shortcuts" onCancel={(event) => { event.preventDefault(); setHelp(false); }}>
        <h3>Shortcuts</h3>
        <p className="sub">Ctrl K opens search. Then G followed by a key:</p>
        <p className="sub">O overview · P projects · D deployments · B builds · L logs · A analytics · F firewall · S settings</p>
        <button className="ghost" type="button" onClick={() => setHelp(false)}>Close</button>
      </dialog>
      {state.toast && <div className="toast" role="status">{state.toast}</div>}
    </div>
  );
}
