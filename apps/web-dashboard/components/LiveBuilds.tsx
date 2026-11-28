"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { realtime, type RealtimeEvent } from "@/lib/realtime";
import { request, useCloud } from "@/lib/store";
import { Icon } from "./Icons";
import { ClientTime } from "./Time";

/**
 * The live build view.
 *
 * A build is followed while it runs: the progress bar moves, the step
 * timeline fills in, and the log arrives line by line. The realtime bus
 * carries the events; polling is only the fallback for a client whose socket
 * is not connected.
 */

type Build = {
  id: string;
  projectId: string;
  target: string;
  status: string;
  note: string;
  progress: number;
  triggerSource: string | null;
  repositoryId: string | null;
  branch: string | null;
  commitSha: string | null;
  previewUrl: string | null;
  error: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  durationMs: number | null;
};

type Step = {
  name: string;
  status: "pending" | "running" | "success" | "failed" | "skipped";
  ordinal: number;
  startedAt: number | null;
  finishedAt: number | null;
  durationMs: number | null;
};

type BuildEvent = {
  seq: number;
  type: string;
  timestamp: number;
  stream?: string;
  line?: string;
  percentage?: number;
  currentStep?: string;
  stepName?: string;
  stepStatus?: string;
  duration?: number;
  metric?: Record<string, unknown>;
};

const POLL_MS = 2000;

export function LiveBuildsView() {
  const { state, call, setToast } = useCloud();
  const [builds, setBuilds] = useState<Build[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [steps, setSteps] = useState<Step[]>([]);
  const [events, setEvents] = useState<BuildEvent[]>([]);
  const [pending, setPending] = useState(false);
  const logRef = useRef<HTMLDivElement | null>(null);

  const loadBuilds = useCallback(async () => {
    try {
      const response = (await request("builds")) as { builds: Build[] };
      setBuilds(response.builds ?? []);
    } catch {
      setBuilds([]);
    }
  }, []);

  const loadDetail = useCallback(async (id: string) => {
    try {
      const response = (await request(`builds/${id}`)) as { steps: Step[]; events: BuildEvent[] };
      setSteps(response.steps ?? []);
      setEvents(response.events ?? []);
    } catch {
      setSteps([]);
      setEvents([]);
    }
  }, []);

  useEffect(() => {
    void loadBuilds();
  }, [loadBuilds]);

  // The realtime bus tells the page a build moved; the list follows.
  useEffect(() => {
    return realtime.onEvent((event: RealtimeEvent) => {
      if (!event.event_type.startsWith("build.")) return;
      void loadBuilds();
      if (selectedId && event.payload?.buildId === selectedId) void loadDetail(selectedId);
    });
  }, [loadBuilds, loadDetail, selectedId]);

  // Polling is the fallback for a client whose socket is not connected.
  useEffect(() => {
    const running = builds.some((build) => build.status === "running");
    if (!running) return;
    const timer = setInterval(() => {
      void loadBuilds();
      if (selectedId) void loadDetail(selectedId);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [builds, loadBuilds, loadDetail, selectedId]);

  useEffect(() => {
    if (selectedId) void loadDetail(selectedId);
    else {
      setSteps([]);
      setEvents([]);
    }
  }, [selectedId, loadDetail]);

  useEffect(() => {
    const node = logRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [events]);

  const selected = builds.find((build) => build.id === selectedId) ?? null;
  const projects = state.projects.filter((project) => project.repoUrl);
  const projectId = projects[0]?.id ?? "";

  function start(target: string) {
    if (!projectId || pending) return;
    setPending(true);
    void call("builds", { method: "POST", body: JSON.stringify({ projectId, target }) })
      .then((result) => {
        const buildId = (result as { buildId?: string }).buildId;
        setToast(buildId ? "The build started" : "The build request was recorded");
        if (buildId) setSelectedId(buildId);
        return loadBuilds();
      })
      .catch((error) => setToast(error instanceof Error ? error.message : "The build could not start"))
      .finally(() => setPending(false));
  }

  return (
    <>
      <header className="page-head">
        <div>
          <h2>Builds</h2>
          <p>
            Every build streams its output as it happens: the progress bar moves with the work, the timeline shows which
            step is running, and the log arrives line by line. A repository connected through GitHub is analysed for
            its framework, its changed files and its cache decision; the platform&rsquo;s own targets are compiled
            here.
          </p>
        </div>
        <div className="form-row">
          <button className="ghost" type="button" disabled={!projectId || pending} onClick={() => start("android")}>
            Build Android
          </button>
          <button className="primary" type="button" disabled={!projectId || pending} onClick={() => start("web")}>
            Build web
          </button>
        </div>
      </header>

      <article className="panel">
        {builds.length === 0 && <p className="empty">No build has run yet.</p>}
        {builds.map((build) => (
          <button
            key={build.id}
            type="button"
            className="list-row"
            onClick={() => setSelectedId(build.id === selectedId ? null : build.id)}
            style={{
              display: "block",
              width: "100%",
              textAlign: "left",
              background: "none",
              border: "none",
              borderBottom: "1px solid var(--divider)",
              padding: "10px 0",
              cursor: "pointer",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
              <strong>{build.note || build.target}</strong>
              <span style={{ color: build.status === "success" ? "var(--green)" : build.status === "failed" ? "var(--red)" : "var(--amber)" }}>
                {build.status}
              </span>
            </div>
            <div className="sub">
              {build.target} · {build.triggerSource ?? "console"}
              {build.branch ? ` · ${build.branch}` : ""}
              {build.commitSha ? ` · ${build.commitSha.slice(0, 7)}` : ""} · <ClientTime ts={build.createdAt} />
              {build.durationMs !== null ? ` · ${(build.durationMs / 1000).toFixed(1)}s` : ""}
            </div>
            <div
              style={{
                marginTop: 6,
                height: 4,
                borderRadius: 2,
                background: "var(--panel-2)",
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  width: `${build.progress}%`,
                  height: "100%",
                  background: build.status === "failed" ? "var(--red)" : "var(--accent)",
                  transition: "width 240ms ease",
                }}
              />
            </div>
          </button>
        ))}
      </article>

      {selected && (
        <article className="panel" style={{ marginTop: 16 }}>
          <div className="panel-head">
            <h3><Icon name="activity" size={18} /> {selected.note || selected.target}</h3>
            <div className="sub">
              {selected.progress}% · {selected.status}
              {selected.previewUrl ? (
                <>
                  {" · "}
                  <a href={selected.previewUrl} rel="noreferrer">preview</a>
                </>
              ) : null}
            </div>
          </div>

          <div className="list-row" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10 }}>
            {steps.map((step) => (
              <div key={step.name}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: 4,
                      background:
                        step.status === "success"
                          ? "var(--green)"
                          : step.status === "failed"
                            ? "var(--red)"
                            : step.status === "running"
                              ? "var(--accent)"
                              : "var(--faint)",
                    }}
                  />
                  <span style={{ fontSize: 13 }}>{step.name}</span>
                </div>
                <div className="sub">
                  {step.status}
                  {step.durationMs !== null ? ` · ${step.durationMs}ms` : ""}
                </div>
              </div>
            ))}
          </div>

          {selected.error && <p className="banner bad">{selected.error}</p>}

          <div ref={logRef} className="term" style={{ maxHeight: 260, overflow: "auto", marginTop: 12 }}>
            {events
              .filter((event) => event.type === "log")
              .map((event) => (
                <div key={event.seq} style={{ color: event.stream === "stderr" ? "var(--red)" : undefined }}>
                  {event.line}
                </div>
              ))}
            {events.length === 0 && <div className="sub">No output yet.</div>}
          </div>

          <div className="sub" style={{ marginTop: 8 }}>
            {events.filter((event) => event.type === "metric").length > 0 && (
              <>
                {events
                  .filter((event) => event.type === "metric")
                  .map((event) => (
                    <span key={event.seq} style={{ marginRight: 12 }}>
                      {Object.entries(event.metric ?? {})
                        .map(([key, value]) => `${key}: ${String(value)}`)
                        .join(" · ")}
                    </span>
                  ))}
              </>
            )}
          </div>
        </article>
      )}
    </>
  );
}
