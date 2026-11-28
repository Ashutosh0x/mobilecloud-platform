export type RangeKey = "1h" | "24h" | "7d" | "30d";

export type User = {
  id: string;
  email: string;
  name: string;
  role: string;
  plan: string;
};

export type Project = {
  id: string;
  name: string;
  framework: string;
  target: string;
  repoUrl?: string | null;
  createdAt: number;
};

export type Deployment = {
  id: string;
  projectId: string;
  project: string;
  status: "blocked" | "failed" | "queued" | "rolled_back";
  note: string;
  createdAt: number;
};

/** Lifecycle phase derived from the three independent signals (see lib/domain-status.ts). */
export type DomainStatus =
  | "pending_dns" | "dns_verified" | "ssl_provisioning" | "active"
  | "ssl_expiring" | "ssl_expired" | "dns_misconfigured"
  | "suspended" | "deleting";

/** Independent signal 1: does the DNS record point where we expect? */
export type DnsSignal = "pending" | "verified" | "misconfigured" | "missing";
/** Independent signal 2: the TLS certificate lifecycle. */
export type SslSignal = "none" | "provisioning" | "active" | "renewing" | "expired" | "failed";
/** Independent signal 3: is the origin actually serving? */
export type HealthSignal = "ok" | "degraded" | "down" | "unknown";
export type VerificationMethod = "cname" | "txt" | "http" | "auto";

export type DomainErrorCode =
  | "CNAME_MISSING" | "CNAME_WRONG_TARGET" | "A_RECORD_CONFLICT"
  | "CAA_BLOCKS_CA" | "SSL_TIMEOUT" | "TUNNEL_UNREACHABLE"
  | "NS_LOOKUP_FAILED" | "UNEXPECTED_DNS_CHANGE";

export type DomainPropagation = {
  regions: { name: string; resolved: boolean }[];
  lastCheckedAt: number;
};

export type DomainLastError = { code: DomainErrorCode; message: string; at: number };

export type Domain = {
  id: string;
  host: string;
  project: string;
  status: DomainStatus;
  detail: string;
  /** Detected authoritative DNS provider (Cloudflare, Route 53, …), or null when unknown. */
  dnsProvider: string | null;
  dnsStatus: DnsSignal;
  sslStatus: SslSignal;
  healthStatus: HealthSignal;
  dnsVerifiedAt: number | null;
  sslExpiresAt: number | null;
  sslIssuer: string | null;
  /** The CNAME target the host must point at (e.g. <id>.cfargotunnel.com). */
  tunnelTarget: string | null;
  /** Public DNS TXT challenge value; safe to display (never a secret). */
  verificationToken: string | null;
  verificationMethod: VerificationMethod;
  propagation: DomainPropagation | null;
  lastError: DomainLastError | null;
  createdAt: number;
  updatedAt: number;
};

export type DbFile = {
  id: string;
  name: string;
  engine: "sqlite";
  bytes: number | null;
  path: string;
};

export type FuncRow = {
  id: string;
  name: string;
  route: string;
  hasSource: boolean;
  invocations: number;
};

export type ObjectRow = {
  id: string;
  bucket: string;
  key: string;
  bytes: number;
};

export type LogRow = {
  id: string;
  level: "info" | "warn" | "error";
  source: string;
  message: string;
  at: number;
};

export type Member = {
  id: string;
  name: string;
  email: string;
  role: string;
  emailSent: boolean;
};

export type Metrics = {
  collectedAt: number;
  processUptimeSec: number;
  cpuBusySinceBootPct: number | null;
  memoryUsedPct: number | null;
  memoryUsedBytes: number;
  memoryTotalBytes: number;
  dataDirBytes: number;
  diskFreeBytes: number | null;
  diskTotalBytes: number | null;
  responseAvgMs: number | null;
  responseSamples: number;
  recordedRequests: number;
  networkUtilization: null;
  unavailable: string[];
};

export type Analytics = {
  range: RangeKey;
  total: number;
  points: { label: string; count: number }[];
};

export type HostInfo = {
  hostname: string;
  platform: string;
  arch: string;
  release: string;
  cpuCount: number;
  processUptimeSec: number;
  memoryUsedBytes: number;
  memoryTotalBytes: number;
  unavailable: string[];
};
