"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Analytics, DbFile, Deployment, Domain, FuncRow, HostInfo, LogRow, Member, Metrics, ObjectRow, Project, RangeKey, User } from "./types";
import { CSRF_HEADER, readCsrfCookie } from "./csrf";
import { realtime, type RealtimeState } from "./realtime";

export type { RangeKey };

type Billing = { plan: string; provider: null; charged: false; detail: string };
type Capability = { name: string; state: "active" | "unavailable"; detail: string };
type FirewallRule = { id: string; name: string; action: string; matchKey: string; matchOp: string; matchValue: string; headerName: string | null; limitCount: number | null; windowSec: number | null; enabled: number };
type FirewallEvent = { id: string; ruleId: string | null; action: string; path: string; ip: string; at: number; userAgent?: string | null; host?: string | null; ja4?: string | null };
type TrafficRank = { value: string; count: number };
type Traffic = { window: "24h"; requests: number; denied: number; logged: number; rateLimited: number; buckets: { start: number; requests: number }[]; topPaths: TrafficRank[]; topAgents: TrafficRank[]; topJa4: TrafficRank[]; crawlerTokens: TrafficRank[]; notes: string[] };
type VitalMetric = { metric: string; samples: number; p75: number | null };
type BuildRow = { id: string; project: string; target: string; status: string; note: string; createdAt: number };
type WorkflowRow = { id: string; name: string; createdAt: number; stepCount?: number; lastRun: { status: string; note: string; at: number } | null };
type DriveRow = { id: string; name: string; bytes: number | null; createdAt: number };
type Observability = { collectedAt: number; samples: number; statuses: { s2xx: number; s3xx: number; s4xx: number; s5xx: number }; p50: number | null; p95: number | null; p99: number | null; unavailable: string[] };
type Settings = { recordPageViews: boolean };
type Notice = { id: string; type: string; title: string; message: string; read: boolean; at: number };
type SessionRow = { id: string; userAgent: string; createdAt: number | null; expiresAt: number; current: boolean };
type TokenRow = { id: string; name: string; prefix: string; createdAt: number; expiresAt: number | null; lastUsed: number | null };
type WebhookRow = { id: string; url: string; events: string; createdAt: number };
type UsageMetric = { meter: string; unit: string; value: number; limit: number | null; over: boolean };
type Usage = { periodStart: number; periodEnd: number; plan: string; metrics: UsageMetric[]; billable: boolean; note: string };
type WebhookDelivery = { id: string; webhookId: string; eventType: string; status: string; attempts: number; responseStatus: number | null; lastError: string | null; nextAttemptAt: number; createdAt: number; updatedAt: number };
type PorAttestation = { id: string; status: string; reserveRatioBps: number; totalBackingBase: string; totalLiabilitiesBase: string; netDifferenceBase: string; evidenceAgeSec: number; ledgerSequence: number | null; digest: string | null; quorum: string | null; observedAt: number; recordedAt: number };
type PorState = { verified: boolean; status: string; reason: string; attestation: PorAttestation | null; checkedAt: number };

/** Absence of a signed attestation is reported as unverified, never a made-up ratio. */
const POR_UNVERIFIED: PorState = { verified: false, status: "unverified", reason: "No proof-of-reserve attestation has been recorded.", attestation: null, checkedAt: 0 };

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
  usage: Usage;
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
  webhookDeliveries?: WebhookDelivery[];
  por?: PorState;
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
  usage: Usage | null;
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
  webhookDeliveries: WebhookDelivery[];
  por: PorState;
  protection: { required: boolean; unlocked: boolean };
  identity: Capability[];
  shell: string[];
  /** Live connection state shared by the whole app (single realtime client). */
  realtime: RealtimeState;
};

const initialRealtime: RealtimeState = {
  status: "connecting",
  accountId: null,
  accountName: null,
  cursor: 0,
  lastSyncAt: null,
  lastError: null,
  pending: 0,
  attempts: 0,
  transport: null,
  serverStatus: "unknown",
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
  usage: null,
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
  webhookDeliveries: [],
  por: POR_UNVERIFIED,
  protection: { required: false, unlocked: true },
  identity: [],
  shell: ["CloudShell reads this server. Type help."],
  realtime: initialRealtime,
};

type Api = {
  state: CloudState;
  setQuery: (query: string) => void;
  setRange: (range: RangeKey) => void;
  refresh: () => Promise<void>;
  /**
   * Performs a mutation. Pass [optimistic] to apply the change locally first:
   * the patch is rolled back if the server rejects it, and replaced by the
   * authoritative snapshot once the request succeeds.
   */
  call: (path: string, init?: RequestInit, optimistic?: OptimisticPatch) => Promise<unknown>;
  login: (input: { email: string; password: string }) => Promise<void>;
  logout: () => Promise<void>;
  pushShell: (line: string) => void;
  setToast: (toast: string | null) => void;
  /** Re-open the realtime socket immediately. */
  realtimeRetry: () => void;
};

/** Local, immediate state change applied before the server confirms it. */
export type OptimisticPatch = (state: CloudState) => Partial<CloudState>;

const Ctx = createContext<Api | null>(null);

export async function request(path: string, init?: RequestInit) {
  const method = (init?.method ?? "GET").toUpperCase();
  const csrf = method === "GET" || method === "HEAD" ? null : readCsrfCookie();
  const res = await fetch(`/api/${path}`, {
    ...init,
    credentials: "include",
    headers: { "content-type": "application/json", ...(csrf ? { [CSRF_HEADER]: csrf } : {}), ...(init?.headers ?? {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : `Request failed (${res.status})`);
  return data;
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<CloudState>(empty);
  // Keeps the latest refresh identity for the realtime event handler without
  // re-subscribing on every re-render.
  const refreshRef = useRef<() => Promise<void>>(async () => undefined);
  // Last rendered state, read by `call` to roll an optimistic patch back.
  const stateRef = useRef<CloudState>(empty);
  useEffect(() => { stateRef.current = state; }, [state]);

  const refreshSequence = useRef(0);
  const refresh = useCallback(async () => {
    const sequence = ++refreshSequence.current;
    const me = await request("auth/me") as { user: User | null };
    if (sequence !== refreshSequence.current) return;
    if (!me.user) {
      setState((s) => ({ ...empty, status: "anon", query: s.query, range: s.range, shell: s.shell, realtime: s.realtime }));
      return;
    }
    const range = state.range;
    const [snap, analytics] = await Promise.all([
      request("overview") as Promise<Snapshot>,
      request(`analytics?range=${range}`) as Promise<Analytics>,
    ]);
    if (sequence !== refreshSequence.current || snap.user.id !== me.user.id) return;
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
      usage: snap.usage,
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
      webhookDeliveries: snap.webhookDeliveries ?? [],
      por: snap.por ?? POR_UNVERIFIED,
      protection: snap.protection ?? { required: false, unlocked: true },
      identity: snap.identity ?? [],
      analytics,
    }));
  }, [state.range]);

  useEffect(() => {
    let live = true;
    refresh().catch((error) => {
      if (!live) return;
      setState((s) => ({ ...s, status: s.user ? "ready" : "error", error: error instanceof Error ? error.message : "The control plane is unreachable." }));
    });
    return () => { live = false; };
  }, [refresh]);

  // Mirror the shared realtime client's state into the store so any component
  // can render the connection indicator without opening its own socket.
  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  useEffect(() => {
    return realtime.subscribe((rt) => setState((s) => ({ ...s, realtime: rt })));
  }, []);

  // A live event means the server state moved: re-pull the snapshot so every
  // page reflects it. Debounced so a burst of events triggers one refresh.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const scheduleRefresh = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        refreshRef.current().catch(() => undefined);
      }, 250);
    };
    let status = realtime.snapshot().status;
    const unsubscribeStatus = realtime.subscribe((next) => {
      if (status !== next.status && (next.status === "connected" || next.status === "sync_error")) scheduleRefresh();
      status = next.status;
    });
    const unsubscribeEvent = realtime.onEvent(scheduleRefresh);
    return () => {
      unsubscribeStatus();
      unsubscribeEvent();
      if (timer) clearTimeout(timer);
    };
  }, []);

  // Only run the socket for an authenticated session. Signing in starts it,
  // signing out (or a lost session) tears it down.
  useEffect(() => {
    if (state.status === "ready" && state.user) realtime.start(state.user.id);
    else realtime.stop();
  }, [state.status, state.user?.id]);

  // Bounded safety net: if the socket is unavailable the app still converges.
  useEffect(() => {
    if (state.status !== "ready") return;
    const id = setInterval(() => {
      refresh().catch(() => setState((s) => ({ ...s, error: "Lost contact with the control plane." })));
    }, 60000);
    return () => clearInterval(id);
  }, [state.status, refresh]);

  const call = useCallback(async (path: string, init?: RequestInit, optimistic?: OptimisticPatch) => {
    const before = stateRef.current;
    const patch = optimistic?.(before);
    if (patch) setState((s) => s.user?.id === before.user?.id ? { ...s, ...patch } : s);
    let data: unknown;
    try {
      data = await request(path, init);
    } catch (error) {
      if (patch) setState((s) => {
        if (s.user?.id !== before.user?.id) return s;
        const rollback = (Object.keys(patch) as (keyof CloudState)[])
          .filter((key) => s[key] === patch[key]).map((key) => [key, before[key]]);
        return { ...s, ...Object.fromEntries(rollback) };
      });
      throw error;
    }
    try {
      await refresh();
    } catch {
      setState((s) => s.user?.id === before.user?.id ? { ...s, error: "Saved, but the latest state could not be loaded yet." } : s);
    }
    return data;
  }, [refresh]);

  const api = useMemo<Api>(() => ({
    state,
    setQuery: (query) => setState((s) => ({ ...s, query })),
    setRange: (range) => setState((s) => ({ ...s, range })),
    refresh,
    call,
    login: async (input) => {
      refreshSequence.current += 1;
      realtime.reset();
      await request("auth/login", { method: "POST", body: JSON.stringify(input) });
      await refresh();
    },
    logout: async () => {
      await request("auth/logout", { method: "POST" });
      refreshSequence.current += 1;
      realtime.reset();
      setState((s) => ({ ...empty, status: "anon", shell: s.shell }));
    },
    pushShell: (line) => setState((s) => ({ ...s, shell: [...s.shell, line].slice(-40) })),
    setToast: (toast) => setState((s) => ({ ...s, toast })),
    realtimeRetry: () => realtime.retry(),
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
