import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openDb } from "./db.ts";
import { collectSubsystems, probe } from "./health.ts";

function freshDb() {
  const file = join(mkdtempSync(join(tmpdir(), "mc-health-")), "t.db");
  return openDb(file);
}

/** A stand-in HTTP server that answers one route and stalls on another. */
function stubServer(handler: (path: string) => { status: number; body: string }): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const path = (req.url ?? "/").split("?")[0];
      const result = handler(path);
      res.writeHead(result.status, { "content-type": "application/json" });
      res.end(result.body);
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

test("a probe reports the round trip and the status code", async () => {
  const { server, url } = await stubServer(() => ({ status: 200, body: "{}" }));
  try {
    const result = await probe(`${url}/api/health`, 2000);
    assert.equal(result.ok, true);
    assert.equal(result.status, 200);
    assert.ok(result.latencyMs >= 0);
  } finally {
    server.close();
  }
});

test("a refused connection is a result, not an exception", async () => {
  const result = await probe("http://127.0.0.1:1/api/health", 2000);
  assert.equal(result.ok, false);
  assert.equal(result.status, null);
  assert.ok(result.detail.length > 0);
});

test("a subsystem that answers with an error status is down", async () => {
  const { server, url } = await stubServer(() => ({ status: 503, body: "{}" }));
  try {
    const result = await probe(`${url}/api/health`, 2000);
    assert.equal(result.ok, false);
    assert.equal(result.status, 503);
  } finally {
    server.close();
  }
});

test("a deployment with nothing attached reports the database as healthy and the rest as unconfigured", async () => {
  const db = freshDb();
  const report = await collectSubsystems(db, {});
  const byId = new Map(report.subsystems.map((entry) => [entry.id, entry]));
  assert.equal(byId.get("database")?.status, "healthy");
  assert.equal(byId.get("control_plane")?.status, "healthy");
  assert.equal(byId.get("realtime")?.status, "unconfigured");
  assert.equal(byId.get("edge_engine")?.status, "unconfigured");
  assert.equal(byId.get("dns_authority")?.status, "unconfigured");
  // An absent subsystem is not an incident.
  assert.equal(report.status, "healthy");
});

test("a reachable gateway is healthy and a broken one fails the report", async () => {
  const db = freshDb();
  const { server, url } = await stubServer((path) =>
    path === "/api/health" ? { status: 200, body: "{}" } : { status: 404, body: "{}" });
  try {
    const healthy = await collectSubsystems(db, { realtimeUrl: url });
    assert.equal(healthy.subsystems.find((entry) => entry.id === "realtime")?.status, "healthy");
    assert.equal(healthy.status, "healthy");
  } finally {
    server.close();
  }

  const broken = await collectSubsystems(db, { realtimeUrl: "http://127.0.0.1:1" });
  assert.equal(broken.subsystems.find((entry) => entry.id === "realtime")?.status, "down");
  assert.equal(broken.status, "down");
});

test("the edge engine and the DNS authority are probed on their own routes", async () => {
  const db = freshDb();
  const seen: string[] = [];
  const { server, url } = await stubServer((path) => {
    seen.push(path);
    return { status: 200, body: "{}" };
  });
  try {
    const report = await collectSubsystems(db, { engineUrl: url, dnsApiUrl: url });
    assert.equal(report.subsystems.find((entry) => entry.id === "edge_engine")?.status, "healthy");
    assert.equal(report.subsystems.find((entry) => entry.id === "dns_authority")?.status, "healthy");
    assert.ok(seen.includes("/healthz"));
    assert.ok(seen.includes("/api/v1/dns/health"));
  } finally {
    server.close();
  }
});

test("a probe that exceeds the timeout is down rather than a hang", async () => {
  const server = createServer(() => {
    // Never answers.
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    const result = await probe(`http://127.0.0.1:${port}/api/health`, 150);
    assert.equal(result.ok, false);
    assert.match(result.detail, /No answer within/);
  } finally {
    server.close();
  }
});
