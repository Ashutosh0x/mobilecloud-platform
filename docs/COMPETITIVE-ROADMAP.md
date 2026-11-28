# Competitive Roadmap (P1–P10)

> Prepared 2026-11-28. This is a **strategy and status document, not a source-code
> audit**. "What MobileCloud has" below means what this repository actually ships
> (`features/status.json` is the source of truth); "what competitors have" means
> what their public posts claim, recorded verbatim-free in
> [`data/radar/items.json`](../data/radar/items.json) and labelled unverified.

## Why this exists

Vercel, Cloudflare, Netlify, Fly.io and Supabase are retooling around AI agents
as the primary customer: persistent agent workspaces, credential brokering,
connectors and MCP, long-running servers, and agent-native billing. MobileCloud's
strongest assets are its identity stack, realtime sync, terminal, tunnel and DNS
work. Its weakest points are that real deployments are disabled, isolation is not
safe for hostile code, there is no billing, and there is no published release.

The ten items below are ordered by how much they unblock. **P1 gates most of the
rest.**

## Scope honesty

This document records what is **landed in this repository**, what is **partial**,
what is **not started**, and what is **blocked by the environment**. It is
deliberately conservative: nothing is marked done here that is not enforced by a
test or a CI check.

Two items cannot be built or verified in an ordinary checkout and are recorded as
such rather than faked:

- **P2 (agent workspaces on phones)** needs an Android runtime to exercise the
  workspace lifecycle; the server-side shape is sketched, the device side is not.
- **P9 (attested phone fleet)** needs physical, attested hardware. Nothing is
  claimed until it has been measured.

## Status at a glance

| Item | Theme | Status | Evidence |
| :--- | :--- | :--- | :--- |
| P1 | Real, isolated execution | partial | `apps/web-dashboard/lib/server/isolate.ts`, `isolate.test.ts` (9 hostile-code tests) |
| P2 | Agent workspaces on phones | not started (device-blocked) | — |
| P3 | Credential brokering + DPoP | not started | device-bound sessions already exist (`identity.ts`) |
| P4 | MobileCloud MCP server | not started | — |
| P5 | Observability that feeds agents | not started | signed webhooks + event log already exist (`webhook.ts`, `events.ts`) |
| P6 | Durable, long-running work | not started | in-process workflow worker (`workflows.ts`) |
| P7 | Radar competitor self-audit | partial | `data/radar/`, `scripts/radar.mjs`, CI step |
| P8 | Spend caps → billing → agent payments | partial | spend caps in `metering.ts`, enforced in `api.ts` |
| P9 | Attested phone fleet | not started (hardware-blocked) | — |
| P10 | Trust and distribution | partial | `SECURITY.md`; this document |

---

## P1 — Real, isolated execution — **partial**

**Competitors.** Vercel made Sandbox startup up to 4× faster and ships device-bound
sessions; Fly.io's whole product is Firecracker VMs (Sprites) that isolate coding
agents; Cloudflare is building Dynamic Workers for fast sandboxing. Speed and
isolation are the bar.

**What MobileCloud had.** A bounded `node:vm` runtime (`runtime.ts`): frozen
globals, 32 KB source, 256 KB output, a 250 ms budget, `codeGeneration` disabled,
and fail-closed in production. `vm` isolates *globals*, not the *process* — a
handler that allocates without bound still runs inside the server.

**What landed.** A **process-isolated runner**, `lib/server/isolate.ts`. Each
invocation runs the handler in a fresh child process:

- a hard V8 old-space ceiling (`--max-old-space-size=128`),
- a wall-clock budget enforced inside the child *and* a parent backstop that kills
  a child that ignores it,
- the child still evaluates inside `vm` with `codeGeneration` disabled, so the
  "no host globals" property is preserved,
- the OS process boundary absorbs crashes, `process.exit` and out-of-memory.

It is **opt-in** (`MOBILECLOUD_ISOLATED_RUNTIME=1`) so the production default stays
fail-closed; the function and workflow call sites pick it up automatically through
`executeFunction`. The acceptance test is a hostile-code suite
(`isolate.test.ts`): runaway loops, memory hunger, host-global access, thrown
errors, oversized output and async handlers — each asserting the *server* survives.

**Honest limit.** This is process and resource isolation, **not a filesystem or
network jail**. The child shares the host kernel and filesystem namespace. An
operator who needs a syscall/interfaces boundary must place the server inside one
(seccomp, gVisor, a container). It is not a VM; do not present it as one.

## P2 — Agent workspaces on phones — **not started (device-blocked)**

Persistent agent computers are now table stakes (Sprites, Vercel Drives,
Cloudflare snapshots). MobileCloud already has a PTY, persistent tmux, file
transfer and a tunnel. The missing piece is a lifecycle API — create, sleep,
wake, snapshot, restore, with a reachable address — and an explicit **isolation
level label** per workspace (process, proot, or VM where the device supports it),
because Android cannot run Firecracker and implying VM-grade isolation would be
false.

Not implemented: no device runtime is available in this environment, and the
lifecycle cannot be tested without one.

## P3 — Credential brokering and proof-of-possession tokens — **not started**

Vercel is binding sessions to devices and working on DPoP for its CLI; Fly keeps
credentials out of the agent's reach. MobileCloud's auth work is its most mature
area — device-bound sessions, rotating refresh tokens and step-up tokens already
exist — which is why this is the area where it can lead. The work (DPoP-bound
tokens for the CLI, secrets injected at egress so they never enter a workspace) is
designed but **not built** here.

## P4 — A MobileCloud MCP server — **not started**

Fly offers one MCP server that connects an agent to its compute and selected apps
with no token pasting. The cheap, high-visibility move is to wrap the existing API
the same way: read-only by default, scoped per project, every call written to the
audit trail. Not implemented.

## P5 — Observability that feeds agents — **not started**

Cloudflare's Issues groups errors and routes stack traces, logs and traces to
coding agents or webhooks. MobileCloud already has signed webhooks and an event
log; the missing work is error grouping and a "send to agent" action. Not
implemented.

## P6 — Durable, long-running work — **not started**

Vercel's Workflow SDK 5 continues async code through crashes, deployments and long
waits; Netlify Server covers long-running backends. MobileCloud's workflow worker
(`workflows.ts`) is in-process and stops at the first failure. Persisting step
state in SQLite, resuming after a restart and adding retries is the plan — and it
depends on P1 for a safe place to run the steps. Not implemented.

## P7 — The search-bar feature: Radar and self-audit — **partial**

A console feature that audits competitors against MobileCloud's own feature status.

**What landed (backend + guard).**

- **Feeds.** [`data/radar/feeds.json`](../data/radar/feeds.json) is the allowlist of
  public sources (HTTPS only). Private/loopback targets are refused with the same
  policy as webhook delivery.
- **Records.** [`data/radar/items.json`](../data/radar/items.json) stores one row per
  competitor claim: `source` URL, `date`, a short summary **in our own words**, the
  `mapsTo` status.json component, and a `verdict` (`have` / `partial` / `absent`).
- **Mapping.** Each row must name a real `features/status.json` component, so the
  audit can never reference a capability that was not assessed.
- **Safeguards.** `scripts/radar.mjs` requires a source link on every row, that the
  host is allowlisted and public, that summaries are bounded, and that the newest
  record is fresh. Every output is labelled **UNVERIFIED** — a summary is a
  condensation and may misstate a competitor.
- **CI.** The `docs-integrity` job runs `node scripts/radar.mjs --check`, so the
  audit cannot go stale or reference an unassessed capability.

**Not yet wired.** The console button beside the search bar (the UI that renders the
ranked gaps) and scheduled live feed fetching are **not** built; the CI job
validates the curated data, it does not poll the web.

## P8 — Spend caps, then billing, then agent payments — **partial**

Vercel's CLI now has spend management, Cloudflare's Monetization Gateway charges
agents via HTTP 402, and Acurast settles compute in USDC over x402.

**What landed (spend caps).** `metering.ts` already had append-only meters; it now
enforces a **hard per-period cap** per meter. `quotaBreach()` returns the breach
when recording one more unit would exceed `MOBILECLOUD_QUOTA_<METER>`, and the API
rejects the operation with **429** at the function-invocation and workflow-run call
sites. The usage report surfaces the same cap and stays `billable: false`.

**Not built.** Invoicing and agent payments (x402 / HTTP 402). No payment provider
is wired, on purpose.

## P9 — An attested phone fleet — **not started (hardware-blocked)**

MobileCloud cannot win on node count against Acurast's self-reported network.
The strategy is to compete on **verifiability** instead: Android key attestation
for node identity, the existing signed heartbeats, and the first real
device-to-device transport on hardware. Nothing is claimed until it has been
measured; no hardware is available here.

## P10 — Trust and distribution — **partial**

Vercel has just completed ISO/IEC 42001 certification. MobileCloud has no releases,
one contributor and an open signing-credential question.

**What exists.** [`SECURITY.md`](../SECURITY.md) is a real disclosure policy
(security@furlpay.com, 72-hour acknowledgement). This roadmap document is landed
under version control.

**Still outstanding.** A signed release, DNSSEC on the authoritative zones, a
public status page, and **real** k6 results — `benchmarks/k6-load-test.js` declares
its thresholds (`p(95)<35 ms`, error rate `<0.1%`) but no measured run is published
yet, so the README must keep describing them as targets rather than results.
