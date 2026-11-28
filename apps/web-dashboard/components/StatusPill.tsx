import type { ReactNode } from "react";

/**
 * The console's status vocabulary.
 *
 * A status is shown the same way everywhere: one word, one colour, one
 * meaning. Healthy is green, degraded is amber, down is red, and anything the
 * platform has not measured yet is grey rather than optimistic.
 */

export type StatusTone = "healthy" | "degraded" | "down" | "unknown";

const TONES: Record<StatusTone, { label: string; color: string }> = {
  healthy: { label: "Healthy", color: "var(--green)" },
  degraded: { label: "Degraded", color: "var(--amber)" },
  down: { label: "Down", color: "var(--red)" },
  unknown: { label: "Unknown", color: "var(--faint)" },
};

/** Maps a free-form status word onto the console's four tones. */
export function toneFor(status: string | null | undefined): StatusTone {
  const value = (status ?? "").toLowerCase();
  if (["ok", "ready", "success", "healthy", "live", "active", "up", "connected", "running"].includes(value)) return "healthy";
  if (["degraded", "warn", "warning", "partial", "pending", "queued", "starting"].includes(value)) return "degraded";
  if (["failed", "error", "down", "offline", "blocked", "revoked", "expired"].includes(value)) return "down";
  return "unknown";
}

/** A status badge: one word, one colour. */
export function StatusPill({ status, label, tone }: { status?: string | null; label?: string; tone?: StatusTone }) {
  const resolved = tone ?? toneFor(status);
  const meta = TONES[resolved];
  return (
    <span
      className="status-pill"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "2px 9px",
        borderRadius: 999,
        fontSize: 12,
        lineHeight: "18px",
        color: meta.color,
        border: `1px solid color-mix(in oklch, ${meta.color} 38%, transparent)`,
        background: `color-mix(in oklch, ${meta.color} 12%, transparent)`,
      }}
    >
      <i style={{ width: 6, height: 6, borderRadius: 3, background: meta.color }} aria-hidden="true" />
      {label ?? meta.label}
    </span>
  );
}

/** A metric: the number, what it means, and the trend beside it. */
export function MetricCard({
  label,
  value,
  hint,
  trend,
  tone,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  trend?: "up" | "down" | "flat";
  tone?: StatusTone;
}) {
  const meta = tone ? TONES[tone] : null;
  return (
    <div className="metric-card" style={{ display: "grid", gap: 4 }}>
      <div className="sub" style={{ fontSize: 12 }}>{label}</div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <strong style={{ fontSize: 24, lineHeight: "28px", color: meta?.color }}>{value}</strong>
        {trend && trend !== "flat" && (
          <span aria-hidden="true" style={{ color: trend === "up" ? "var(--green)" : "var(--red)" }}>
            {trend === "up" ? "▲" : "▼"}
          </span>
        )}
      </div>
      {hint && <div className="sub" style={{ fontSize: 12 }}>{hint}</div>}
    </div>
  );
}
