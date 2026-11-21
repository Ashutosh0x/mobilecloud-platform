"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Analytics, DbFile, Deployment, Domain, FuncRow, HostInfo, LogRow, Member, Metrics, ObjectRow, Project, RangeKey, User } from "./types";

export type { RangeKey };

type Billing = { plan: string; provider: null; charged: false; detail: string };
type Capability = { name: string; state: "active" | "unavailable"; detail: string };
type FirewallRule = { id: string; name: string; action: string; matchKey: string; matchOp: string; matchValue: string; headerName: string | null; limitCount: number | null; windowSec: number | null; enabled: number };
type FirewallEvent = { id: string; ruleId: string | null; action: string; path: string; ip: string; at: number; userAgent?: string | null; host?: string | null; ja4?: string | null };
type TrafficRank = { value: string; count: number };
type Traffic = { window: "24h"; requests: number; denied: number; logged: number; rateLimited: number; buckets: { start: number; requests: number }[]; topPaths: TrafficRank[]; topAgents: TrafficRank[]; topJa4: TrafficRank[]; crawlerTokens: TrafficRank[]; notes: string[] };
type VitalMetric = { metric: string; samples: number; p75: number | null };
type BuildRow = { id: string; project: string; target: string; status: string; note: string; createdAt: number };
type WorkflowRow = { id: string; name: string; createdAt: number; lastRun: { status: string; note: string; at: number } | null };
type DriveRow = { id: string; name: string; bytes: number | null; createdAt: number };
type Observability = { collectedAt: number; samples: number; statuses: { s2xx: number; s3xx: number; s4xx: number; s5xx: number }; p50: number | null; p95: number | null; p99: number | null; unavailable: string[] };
type Settings = { recordPageViews: boolean };
type Notice = { id: string; type: string; title: string; message: string; read: boolean; at: number };
type SessionRow = { id: string; userAgent: string; createdAt: number | null; expiresAt: number; current: boolean };
type TokenRow = { id: string; name: string; prefix: string; createdAt: number; expiresAt: number | null; lastUsed: number | null };
type WebhookRow = { id: string; url: string; events: string; createdAt: number };

type Snapshot = {
  user: User;
  projects: Project[];
  deployments: Deployment[];
  domains: Domain[];
  databases: DbFile[];
  functions: FuncRow[];
  objects: ObjectRow[];
  logs: LogRow[];
  team: Member[];
  settings: Settings;
  metrics: Metrics;
  host: HostInfo;
  billing: Billing;
  firewall: { rules: FirewallRule[]; events: FirewallEvent[]; traffic?: Traffic };
  observability: Observability;
  vitals: { collectedAt: number; metrics: VitalMetric[]; res: number | null; note: string };
  builds: BuildRow[];
  workflows: WorkflowRow[];
  drives: DriveRow[];
  capabilities: Capability[];
  notifications: Notice[];
  sessions: SessionRow[];
  tokens: TokenRow[];
  webhooks: WebhookRow[];
  protection: { required: boolean; unlocked: boolean };
  identity: Capability[];
};

export type CloudState = {
  status: "loading" | "anon" | "ready" | "error";
  error: string | null;
  toast: string | null;
  query: string;
  range: RangeKey;
  user: User | null;
  projects: Project[];
  deployments: Deployment[];
  domains: Domain[];
  databases: DbFile[];
  functions: FuncRow[];
  objects: ObjectRow[];
  logs: LogRow[];
  team: Member[];
  settings: Settings;
  metrics: Metrics | null;
  host: HostInfo | null;
  analytics: Analytics | null;
  billing: Billing | null;
  firewall: { rules: FirewallRule[]; events: FirewallEvent[]; traffic?: Traffic };
  observability: Observability | null;
  vitals: { collectedAt: number; metrics: VitalMetric[]; res: number | null; note: string } | null;
  builds: BuildRow[];
  workflows: WorkflowRow[];
  drives: DriveRow[];
  capabilities: Capability[];
  notifications: Notice[];
  sessions: SessionRow[];
  tokens: TokenRow[];
  webhooks: WebhookRow[];
  protection: { required: boolean; unlocked: boolean };
  identity: Capability[];
  shell: string[];
};

const empty: CloudState = {
  status: "loading",
  error: null,
  toast: null,
  query: "",
  range: "24h",
  user: null,
  projects: [],
  deployments: [],
  domains: [],
  databases: [],
  functions: [],
  objects: [],
  logs: [],
  team: [],
  settings: { recordPageViews: true },
  metrics: null,
  host: null,
  analytics: null,
  billing: null,
  firewall: { rules: [], events: [] },
  observability: null,
  vitals: null,
  builds: [],
  workflows: [],
  drives: [],
  capabilities: [],
  notifications: [],
  sessions: [],
  tokens: [],
  webhooks: [],
  protection: { required: false, unlocked: true },
  identity: [],
  shell: ["CloudShell reads this server. Type help."],
};

type Api = {
  state: CloudState;
  setQuery: (query: string) => void;
  setRange: (range: RangeKey) => void;
  refresh: () => Promise<void>;
  call: (path: string, init?: RequestInit) => Promise<unknown>;
  login: (path: "auth/login" | "auth/signup", input: { email: string; password: string; name?: string }) => Promise<void>;
  logout: () => Promise<void>;
  pushShell: (line: string) => void;
  setToast: (toast: string | null) => void;
};

const Ctx = createContext<Api | null>(null);

async function request(path: string, init?: RequestInit) {
  const res = await fetch(`/api/${path}`, {
    ...init,
    credentials: "include",
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : `Request failed (${res.status})`);
  return data;
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<CloudState>(empty);

  const refresh = useCallback(async () => {
    const me = await request("auth/me") as { user: User | null };
    if (!me.user) {
      setState((s) => ({ ...empty, status: "anon", query: s.query, range: s.range, shell: s.shell }));
      return;
    }
    const range = state.range;
    const [snap, analytics] = await Promise.all([
      request("overview") as Promise<Snapshot>,
      request(`analytics?range=${range}`) as Promise<Analytics>,
    ]);
    setState((s) => ({
      ...s,
      status: "ready",
      error: null,
      user: snap.user,
      projects: snap.projects,
      deployments: snap.deployments,
      domains: snap.domains,
      databases: snap.databases,
      functions: snap.functions,
      objects: snap.objects,
      logs: snap.logs,
      team: snap.team,
      settings: snap.settings,
      metrics: snap.metrics,
      host: snap.host,
      billing: snap.billing,
      firewall: snap.firewall,
      observability: snap.observability,
      vitals: snap.vitals,
      builds: snap.builds,
      workflows: snap.workflows,
      drives: snap.drives,
      capabilities: snap.capabilities,
      notifications: snap.notifications ?? [],
      sessions: snap.sessions ?? [],
      tokens: snap.tokens ?? [],
      webhooks: snap.webhooks ?? [],
      protection: snap.protection ?? { required: false, unlocked: true },
      identity: snap.identity ?? [],
      analytics,
    }));
  }, [state.range]);

  useEffect(() => {
    let live = true;
    refresh().catch((error) => {
      if (!live) return;
      setState((s) => ({ ...s, status: "error", error: error instanceof Error ? error.message : "The control plane is unreachable." }));
    });
    return () => { live = false; };
  }, [refresh]);

  useEffect(() => {
    if (state.status !== "ready") return;
    const id = setInterval(() => {
      refresh().catch(() => setState((s) => ({ ...s, status: "error", error: "Lost contact with the control plane." })));
    }, 20000);
    return () => clearInterval(id);
  }, [state.status, refresh]);

  const call = useCallback(async (path: string, init?: RequestInit) => {
    const data = await request(path, init);
    await refresh();
    return data;
  }, [refresh]);

  const api = useMemo<Api>(() => ({
    state,
    setQuery: (query) => setState((s) => ({ ...s, query })),
    setRange: (range) => setState((s) => ({ ...s, range })),
    refresh,
    call,
    login: async (path, input) => {
      await request(path, { method: "POST", body: JSON.stringify(input) });
      await refresh();
    },
    logout: async () => {
      await request("auth/logout", { method: "POST" });
      setState((s) => ({ ...empty, status: "anon", shell: s.shell }));
    },
    pushShell: (line) => setState((s) => ({ ...s, shell: [...s.shell, line].slice(-40) })),
    setToast: (toast) => setState((s) => ({ ...s, toast })),
  }), [state, refresh, call]);

  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

export function useCloud() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useCloud must be used inside StoreProvider");
  return ctx;
}

export async function mutate(path: string, body?: unknown, method = "POST") {
  return request(path, { method, body: body ? JSON.stringify(body) : undefined });
}
