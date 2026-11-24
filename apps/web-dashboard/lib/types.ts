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

export type Domain = {
  id: string;
  host: string;
  project: string;
  status: "recorded";
  detail: string;
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
