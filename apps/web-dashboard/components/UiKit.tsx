"use client";

import { useId, useState, type ReactNode } from "react";
import { Icon } from "./Icons";

/**
 * The MobileCloud UI kit.
 *
 * These are the shared primitives the product-improvement research report asks
 * for: a sparkline, a zoomable time-series, an animated security score ring, a
 * circular contribution gauge, and the global health banner.
 *
 * Two rules hold everywhere in this file:
 *
 * 1. **Every glyph is an official Phosphor icon.** No hand-drawn SVG paths.
 * 2. **Every number comes from the caller.** A component never invents a
 *    measurement; when it has nothing to show it says so, and it never renders
 *    a placeholder value that could be mistaken for a reading.
 */

/* ------------------------------------------------------------------ sparkline */

const SPARK_TONE: Record<string, string> = {
  blue: "var(--accent)",
  cyan: "var(--cyan)",
  green: "var(--green)",
  amber: "var(--amber)",
  red: "var(--red)",
  purple: "var(--purple)",
};

/** A trend line for a metric card. Empty data renders an explicit baseline. */
export function Sparkline({
  values,
  tone = "blue",
  width = 120,
  height = 32,
  label,
}: {
  values: number[];
  tone?: keyof typeof SPARK_TONE;
  width?: number;
  height?: number;
  label?: string;
}) {
  const points = values.filter((value) => Number.isFinite(value));
  if (points.length < 2) {
    return (
      <svg width={width} height={height} role="img" aria-label={label ?? "No trend yet"} style={{ display: "block" }}>
        <line x1={0} y1={height - 1} x2={width} y2={height - 1} stroke="var(--line)" strokeWidth={1} />
      </svg>
    );
  }
  const max = Math.max(...points);
  const min = Math.min(...points);
  const span = max - min || 1;
  const step = width / (points.length - 1);
  const y = (value: number) => height - 2 - ((value - min) / span) * (height - 6);
  const path = points.map((value, index) => `${index === 0 ? "M" : "L"}${index * step},${y(value)}`).join(" ");
  const fill = `${path} L${width},${height} L0,${height} Z`;
  const color = SPARK_TONE[tone] ?? SPARK_TONE.blue;
  return (
    <svg width={width} height={height} role="img" aria-label={label ?? "Trend"} style={{ display: "block" }}>
      <path d={fill} fill={color} opacity={0.12} />
      <path d={path} fill="none" stroke={color} strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/* --------------------------------------------------------------- timeseries */

export type SeriesPoint = { label: string; count: number };

/**
 * A time-series chart with a hover crosshair.
 *
 * The chart draws what the server measured. When there is nothing to draw it
 * shows the empty state rather than a flat line that would read as "steady
 * traffic".
 */
export function TimeseriesChart({
  points,
  tone = "accent",
  height = 180,
  unit = "requests",
  emptyMessage = "No samples in this window.",
}: {
  points: SeriesPoint[];
  tone?: "accent" | "cyan" | "green";
  height?: number;
  unit?: string;
  emptyMessage?: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const gradientId = useId();
  if (!points.length) return <p className="empty">{emptyMessage}</p>;

  const width = 720;
  const padX = 8;
  const padTop = 12;
  const padBottom = 22;
  const max = Math.max(1, ...points.map((point) => point.count));
  const step = points.length > 1 ? (width - padX * 2) / (points.length - 1) : 0;
  const y = (value: number) => padTop + (height - padTop - padBottom) * (1 - value / max);
  const color = tone === "cyan" ? "var(--cyan)" : tone === "green" ? "var(--green)" : "var(--accent)";
  const line = points.map((point, index) => `${index === 0 ? "M" : "L"}${padX + index * step},${y(point.count)}`).join(" ");
  const area = `${line} L${padX + (points.length - 1) * step},${height - padBottom} L${padX},${height - padBottom} Z`;
  const active = hover === null ? null : points[hover];
  const gridValues = [0.25, 0.5, 0.75, 1];

  return (
    <div style={{ position: "relative" }}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        style={{ width: "100%", height, display: "block" }}
        role="img"
        aria-label={`Time series of ${unit}`}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(event) => {
          const box = event.currentTarget.getBoundingClientRect();
          const ratio = (event.clientX - box.left) / box.width;
          const index = Math.round(((ratio * width) - padX) / (step || 1));
          setHover(index >= 0 && index < points.length ? index : null);
        }}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.34} />
            <stop offset="100%" stopColor={color} stopOpacity={0.02} />
          </linearGradient>
        </defs>
        {gridValues.map((ratio) => (
          <line
            key={ratio}
            x1={padX}
            x2={width - padX}
            y1={padTop + (height - padTop - padBottom) * (1 - ratio)}
            y2={padTop + (height - padTop - padBottom) * (1 - ratio)}
            stroke="var(--line)"
            strokeWidth={1}
          />
        ))}
        <path d={area} fill={`url(#${gradientId})`} />
        <path d={line} fill="none" stroke={color} strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
        {active && hover !== null && (
          <>
            <line x1={padX + hover * step} x2={padX + hover * step} y1={padTop} y2={height - padBottom} stroke="var(--faint)" strokeWidth={1} />
            <circle cx={padX + hover * step} cy={y(active.count)} r={4} fill={color} />
          </>
        )}
      </svg>
      <div style={{ display: "flex", justifyContent: "space-between", color: "var(--faint)", fontSize: 11, marginTop: 4 }}>
        <span>{points[0]?.label}</span>
        <span>{points[points.length - 1]?.label}</span>
      </div>
      {active && (
        <div
          role="status"
          style={{
            position: "absolute",
            top: 0,
            left: `${Math.min(82, Math.max(2, ((hover ?? 0) / Math.max(1, points.length - 1)) * 100))}%`,
            transform: "translateX(-50%)",
            background: "var(--elevated)",
            border: "1px solid var(--line)",
            borderRadius: 8,
            padding: "4px 8px",
            fontSize: 12,
            whiteSpace: "nowrap",
            pointerEvents: "none",
          }}
        >
          <b>{active.count}</b> {unit} · {active.label}
        </div>
      )}
    </div>
  );
}

/* ----------------------------------------------------------- score ring */

export type ScoreBand = "healthy" | "degraded" | "down";

export function scoreBand(score: number): ScoreBand {
  if (score >= 80) return "healthy";
  if (score >= 50) return "degraded";
  return "down";
}

/**
 * An animated ring for a 0–100 score.
 *
 * The score itself is computed by the caller from measurements it can explain;
 * this component only draws it. The checks behind the score are listed under
 * the ring so the number is never a black box.
 */
export function SecurityScoreRing({
  score,
  size = 148,
  checks,
  caption,
}: {
  score: number;
  size?: number;
  checks?: { label: string; ok: boolean; detail?: string }[];
  caption?: ReactNode;
}) {
  const clamped = Math.max(0, Math.min(100, Math.round(score)));
  const band = scoreBand(clamped);
  const color = band === "healthy" ? "var(--green)" : band === "degraded" ? "var(--amber)" : "var(--red)";
  const stroke = 12;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - clamped / 100);
  return (
    <div style={{ display: "grid", gap: 10, justifyItems: "center" }}>
      <div style={{ position: "relative", width: size, height: size }}>
        <svg width={size} height={size} role="img" aria-label={`Security score ${clamped} of 100`}>
          <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="var(--line)" strokeWidth={stroke} />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke={color}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
            style={{ transition: "stroke-dashoffset 700ms ease, stroke 300ms ease" }}
          />
        </svg>
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "grid",
            placeContent: "center",
            textAlign: "center",
          }}
        >
          <strong style={{ fontSize: 30, lineHeight: "34px", color }}>{clamped}</strong>
          <span style={{ fontSize: 11, color: "var(--muted)" }}>of 100</span>
        </div>
      </div>
      {caption && <div className="sub" style={{ fontSize: 12, textAlign: "center" }}>{caption}</div>}
      {checks && checks.length > 0 && (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 6, width: "100%" }}>
          {checks.map((check) => (
            <li key={check.label} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
              <Icon name={check.ok ? "check" : "warning"} size={15} />
              <span style={{ color: check.ok ? "var(--text)" : "var(--amber)" }}>{check.label}</span>
              {check.detail && <span className="sub" style={{ marginLeft: "auto" }}>{check.detail}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ fleet meter */

/** A circular gauge for a contribution or capacity figure. */
export function FleetMeshMeter({
  value,
  max = 100,
  label,
  caption,
  size = 116,
  unit = "%",
}: {
  value: number | null;
  max?: number;
  label: string;
  caption?: ReactNode;
  size?: number;
  unit?: string;
}) {
  const stroke = 10;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const ratio = value == null ? 0 : Math.max(0, Math.min(1, value / (max || 1)));
  const color = ratio >= 0.85 ? "var(--amber)" : "var(--cyan)";
  return (
    <div style={{ display: "grid", gap: 8, justifyItems: "center" }}>
      <div style={{ position: "relative", width: size, height: size }}>
        <svg width={size} height={size} role="img" aria-label={value == null ? `${label}: not measured` : `${label}: ${value}${unit}`}>
          <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="var(--line)" strokeWidth={stroke} />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke={color}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={circumference * (1 - ratio)}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
            style={{ transition: "stroke-dashoffset 600ms ease" }}
          />
        </svg>
        <div style={{ position: "absolute", inset: 0, display: "grid", placeContent: "center", textAlign: "center" }}>
          <strong style={{ fontSize: 20, lineHeight: "24px" }}>{value == null ? "—" : `${Math.round(value)}${unit}`}</strong>
          <span style={{ fontSize: 10, color: "var(--muted)" }}>{label}</span>
        </div>
      </div>
      {caption && <div className="sub" style={{ fontSize: 11, textAlign: "center" }}>{caption}</div>}
    </div>
  );
}

/* --------------------------------------------------------- health banner */

export type HealthStatus = "healthy" | "degraded" | "down" | "unconfigured";

export type HealthEntry = {
  id: string;
  label: string;
  status: HealthStatus;
  detail: string;
  latencyMs: number | null;
};

export type HealthReport = {
  checkedAt: number;
  status: "healthy" | "degraded" | "down";
  subsystems: HealthEntry[];
};

/**
 * The global health banner.
 *
 * It answers one question first — is anything broken? — and then lists what
 * was checked. A subsystem that is not deployed here is grey, never red.
 */
export function HealthBanner({ report, onRefresh }: { report: HealthReport | null; onRefresh?: () => void }) {
  if (!report) {
    return (
      <section className="panel" style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <Icon name="heartbeat" size={18} />
        <span className="sub">Checking the subsystems this deployment runs…</span>
      </section>
    );
  }
  const tone = report.status === "healthy" ? "var(--green)" : report.status === "degraded" ? "var(--amber)" : "var(--red)";
  const headline = report.status === "healthy"
    ? "All checked subsystems operational"
    : report.status === "degraded"
      ? "Degraded performance"
      : "A subsystem is down";
  return (
    <section
      className="panel"
      style={{ borderColor: `color-mix(in oklch, ${tone} 45%, var(--line))`, display: "grid", gap: 10 }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <Icon name={report.status === "healthy" ? "check" : "warning"} size={18} />
        <strong style={{ color: tone }}>{headline}</strong>
        <span className="sub" style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 6 }}>
          <Icon name="heartbeat" size={14} />
          checked {new Date(report.checkedAt).toLocaleTimeString()}
        </span>
        {onRefresh && (
          <button className="ghost" type="button" onClick={onRefresh}>Re-check</button>
        )}
      </div>
      <div style={{ display: "grid", gap: 6 }}>
        {report.subsystems.map((entry) => {
          const color = entry.status === "healthy"
            ? "var(--green)"
            : entry.status === "degraded"
              ? "var(--amber)"
              : entry.status === "down"
                ? "var(--red)"
                : "var(--faint)";
          return (
            <div key={entry.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
              <i style={{ width: 7, height: 7, borderRadius: 4, background: color }} aria-hidden="true" />
              <b style={{ minWidth: 190 }}>{entry.label}</b>
              <span className="sub">{entry.detail}</span>
              {entry.latencyMs != null && (
                <span className="sub" style={{ marginLeft: "auto", fontFamily: "var(--mono)" }}>{entry.latencyMs} ms</span>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------ metric card */

/**
 * A metric card with a trend line, per the design system's card spec: the
 * number, the label, the sparkline, and the direction it moved.
 */
export function TrendCard({
  label,
  value,
  hint,
  series,
  trend,
  tone,
  href,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  series?: number[];
  trend?: "up" | "down" | "flat";
  tone?: "blue" | "cyan" | "green" | "amber" | "red" | "purple";
  href?: string;
}) {
  const body = (
    <>
      <div className="sub" style={{ fontSize: 12 }}>{label}</div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <strong style={{ fontSize: 24, lineHeight: "28px" }}>{value}</strong>
        {trend && trend !== "flat" && (
          <span style={{ color: trend === "up" ? "var(--green)" : "var(--red)", display: "inline-flex" }}>
            <Icon name={trend === "up" ? "trend-up" : "trend-down"} size={16} weight="bold" />
          </span>
        )}
      </div>
      {series && series.length > 1 && <Sparkline values={series} tone={tone ?? "blue"} width={140} height={30} label={`${label} trend`} />}
      {hint && <div className="sub" style={{ fontSize: 12 }}>{hint}</div>}
    </>
  );
  if (!href) return <article className="stat" style={{ display: "grid", gap: 6 }}>{body}</article>;
  return (
    <a className="stat" href={href} style={{ display: "grid", gap: 6, textDecoration: "none" }}>
      {body}
      <span className="sub" style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
        Details <Icon name="arrow-right" size={12} />
      </span>
    </a>
  );
}
