"use client";

import { useState } from "react";
import type { DnsSignal, Domain, DomainStatus, HealthSignal, SslSignal } from "@/lib/types";

/* =========================================================================
 * Domain status presentation.
 *
 * The three signals (DNS, SSL, Health) are rendered as three separate tiles
 * and are never collapsed into one colour — a live domain with a down origin
 * is still "active" with a red health tile. Only the lifecycle pill borrows
 * from all three, and it is derived on the server (lib/domain-status.ts).
 * ========================================================================= */

const STATUS_LABEL: Record<DomainStatus, string> = {
  pending_dns: "Pending DNS",
  dns_verified: "DNS verified",
  ssl_provisioning: "SSL provisioning",
  active: "Active",
  ssl_expiring: "SSL expiring",
  ssl_expired: "SSL expired",
  dns_misconfigured: "DNS misconfigured",
  suspended: "Suspended",
  deleting: "Deleting",
};

/** Maps a lifecycle status onto the console's existing badge tones. */
const STATUS_BADGE: Record<DomainStatus, string> = {
  pending_dns: "warn",
  dns_verified: "building",
  ssl_provisioning: "building",
  active: "ready",
  ssl_expiring: "warn",
  ssl_expired: "error",
  dns_misconfigured: "error",
  suspended: "bad",
  deleting: "bad",
};

export function StatusPill({ status }: { status: DomainStatus }) {
  return <span className={`badge ${STATUS_BADGE[status] ?? "warn"}`}>{STATUS_LABEL[status] ?? status}</span>;
}

const DNS_LABEL: Record<DnsSignal, string> = { pending: "Pending", verified: "Verified", missing: "Not found", misconfigured: "Misconfigured" };
const DNS_TONE: Record<DnsSignal, Tone> = { pending: "warn", verified: "ok", missing: "bad", misconfigured: "bad" };
const SSL_LABEL: Record<SslSignal, string> = { none: "Not started", provisioning: "Provisioning", active: "Active", renewing: "Renewing", expired: "Expired", failed: "Failed" };
const SSL_TONE: Record<SslSignal, Tone> = { none: "neutral", provisioning: "warn", active: "ok", renewing: "warn", expired: "bad", failed: "bad" };
const HEALTH_LABEL: Record<HealthSignal, string> = { ok: "Healthy", degraded: "Degraded", down: "Down", unknown: "Unknown" };
const HEALTH_TONE: Record<HealthSignal, Tone> = { ok: "ok", degraded: "warn", down: "bad", unknown: "neutral" };

type Tone = "ok" | "warn" | "bad" | "neutral";

function toneClass(tone: Tone) {
  return tone === "ok" ? "badge ok" : tone === "warn" ? "badge warn" : tone === "bad" ? "badge bad" : "badge info";
}

function Signal({ name, label, tone, detail }: { name: string; label: string; tone: Tone; detail: string }) {
  return (
    <div className="signal" data-tone={tone}>
      <span className="signal-name">{name}</span>
      <span className={toneClass(tone)}>{label}</span>
      <span className="signal-detail">{detail}</span>
    </div>
  );
}

/** The three independent signals, side by side and never merged. */
export function SignalTiles({ domain }: { domain: Domain }) {
  const dnsDetail = domain.dnsVerifiedAt ? `Verified ${new Date(domain.dnsVerifiedAt).toISOString().slice(0, 10)}` : domain.dnsStatus === "verified" ? "Verified" : "Awaiting record";
  const sslDetail = domain.sslExpiresAt ? `Expires ${new Date(domain.sslExpiresAt).toISOString().slice(0, 10)}` : domain.sslStatus === "none" ? "No certificate yet" : "In progress";
  const healthDetail = domain.healthStatus === "unknown" ? "Not probed yet" : "Origin response";
  return (
    <div className="signal-strip">
      <Signal name="DNS" label={DNS_LABEL[domain.dnsStatus]} tone={DNS_TONE[domain.dnsStatus]} detail={dnsDetail} />
      <Signal name="SSL" label={SSL_LABEL[domain.sslStatus]} tone={SSL_TONE[domain.sslStatus]} detail={sslDetail} />
      <Signal name="Health" label={HEALTH_LABEL[domain.healthStatus]} tone={HEALTH_TONE[domain.healthStatus]} detail={healthDetail} />
    </div>
  );
}

type DnsRecord = { type: string; name: string; value: string };

/** The records an operator must publish, exactly as verification checks them. */
export function dnsRecords(domain: Domain): DnsRecord[] {
  const records: DnsRecord[] = [];
  if (domain.tunnelTarget) records.push({ type: "CNAME", name: domain.host, value: domain.tunnelTarget });
  if (domain.verificationToken) records.push({ type: "TXT", name: `_mobilecloud-verify.${domain.host}`, value: domain.verificationToken });
  return records;
}

function CopyRow({ record, onCopied }: { record: DnsRecord; onCopied: (message: string) => void }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(record.value);
      setCopied(true);
      onCopied(`${record.type} ${record.name} copied.`);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      onCopied("Copy is unavailable — select the value and copy it manually.");
    }
  }
  return (
    <tr>
      <td className="mono">{record.type}</td>
      <td className="mono break">{record.name}</td>
      <td className="mono break">{record.value}</td>
      <td>
        <button type="button" className="ghost copy-btn" onClick={copy} aria-label={`Copy the ${record.type} value for ${record.name}`}>
          {copied ? "Copied" : "Copy"}
        </button>
      </td>
    </tr>
  );
}

export function DomainDnsCard({ domain, onVerify, onCopied, verifying }: {
  domain: Domain;
  onVerify: () => void;
  onCopied: (message: string) => void;
  verifying: boolean;
}) {
  const records = dnsRecords(domain);
  const verified = domain.dnsStatus === "verified";
  return (
    <div className="dns-card">
      <div className="dns-card-head">
        <h4>Configure DNS for {domain.host}</h4>
        <StatusPill status={domain.status} />
      </div>

      {domain.lastError && (
        <p className="banner bad" role="alert">{domain.lastError.message}</p>
      )}

      {records.length === 0 ? (
        <p className="banner">
          This deployment has not published a tunnel target yet, so the CNAME value is not known.
          Ask your operator to set <code>CLOUDFLARE_TUNNEL_ID</code>, then reload this page.
        </p>
      ) : (
        <table className="table">
          <thead><tr><th>TYPE</th><th>NAME</th><th>VALUE</th><th><span className="sr-only">Copy</span></th></tr></thead>
          <tbody>
            {records.map((record) => <CopyRow key={`${record.type}-${record.name}`} record={record} onCopied={onCopied} />)}
          </tbody>
        </table>
      )}

      <p className="sub">
        DNS changes can take time to propagate. Verification re-checks the live records — nothing is marked
        verified until the record actually matches.
      </p>

      <div className="form-row">
        <button type="button" className="primary" onClick={onVerify} disabled={verifying} aria-busy={verifying}>
          {verifying ? "Checking…" : verified ? "Re-check DNS" : "Verify DNS"}
        </button>
        <span className="sub" role="status">
          {verified ? "DNS verified." : domain.detail}
        </span>
      </div>
    </div>
  );
}

/** A polite live region that announces status changes without stealing focus. */
export function DomainAnnouncer({ message }: { message: string | null }) {
  return <p className="sr-only" role="status" aria-live="polite">{message ?? ""}</p>;
}
