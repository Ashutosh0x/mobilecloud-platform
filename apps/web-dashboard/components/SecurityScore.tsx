"use client";

import { computeSecurityScore } from "@/lib/security-score";
import { useCloud } from "@/lib/store";
import { Icon } from "./Icons";
import { SecurityScoreRing } from "./UiKit";

/**
 * The security score panel.
 *
 * Every input comes from the account snapshot the console already holds, so
 * the panel renders without an extra request. Checks that could not be
 * evaluated are listed as skipped rather than counted as failures.
 */
export function SecurityScorePanel() {
  const { state } = useCloud();
  const observability = state.observability;
  const traffic = state.firewall.traffic;
  const requestCount = observability?.samples ?? traffic?.requests ?? 0;
  const serverErrorCount = observability?.statuses.s5xx ?? 0;

  const result = computeSecurityScore({
    firewallRules: state.firewall.rules.map((rule) => ({ action: rule.action, enabled: rule.enabled })),
    firewallEvents: state.firewall.events.map((event) => ({ action: event.action, at: event.at })),
    requestCount,
    serverErrorCount,
    activeSessions: state.sessions.length,
    tokens: state.tokens.map((token) => ({ expiresAt: token.expiresAt })),
    protection: state.protection,
  });

  const skipped = result.checks.filter((check) => check.skipped);

  return (
    <article className="panel">
      <div className="panel-head">
        <h3><Icon name="shield" size={18} /> Security score</h3>
        <span className="sub">Window: last 24 hours</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(200px, 260px) 1fr", gap: 22, alignItems: "start" }}>
        <SecurityScoreRing
          score={result.score}
          caption={`Weighted over ${result.measuredWeight} of 100 points — ${skipped.length} check${skipped.length === 1 ? "" : "s"} could not be measured.`}
        />
        <div style={{ display: "grid", gap: 10 }}>
          {result.checks.map((check) => (
            <div key={check.id} style={{ display: "flex", alignItems: "center", gap: 9, fontSize: 13 }}>
              <span style={{ color: check.skipped ? "var(--faint)" : check.ok ? "var(--green)" : "var(--amber)", display: "inline-flex" }}>
                <Icon name={check.skipped ? "gauge" : check.ok ? "check" : "warning"} size={16} />
              </span>
              <span style={{ color: check.skipped ? "var(--muted)" : "var(--text)" }}>{check.label}</span>
              <span className="sub" style={{ marginLeft: "auto", textAlign: "right" }}>{check.detail}</span>
              <span className="sub" style={{ width: 34, textAlign: "right" }}>{check.skipped ? "—" : `${check.weight}p`}</span>
            </div>
          ))}
          <p className="sub">
            The score describes this console account, not a global edge posture. It is computed from the checks above and
            nothing else.
          </p>
        </div>
      </div>
    </article>
  );
}
