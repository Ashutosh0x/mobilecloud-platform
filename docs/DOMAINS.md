# MobileCloud Domain Configuration — Status Ledger

**Audience:** platform engineers.

This ledger is the honest status of the domain lifecycle specified in
[`DOMAIN-CONFIGURATION-UI-UX-2026.md`](DOMAIN-CONFIGURATION-UI-UX-2026.md).
A capability is only reported as `implemented` when it is present in the source
tree; where a passing test covers it, the test file is named. Nothing is ever
marked ready from a timer, and a spinner never implies success.

## Status taxonomy

| Tag | Meaning |
| :--- | :--- |
| `implemented` | Present in the source tree (a passing test is named where one exists) |
| `partial` | Present but missing a required part — the gap is stated |
| `absent` | Does not exist |
| `proposed` | Designed in the spec, not yet built |

## Phase 1 — Foundation · `implemented`

| Capability | Status | Where | Test |
| :--- | :--- | :--- | :--- |
| Extended `Domain` model (independent DNS/SSL/health signals, tunnel target, verification token, last error) | `implemented` | `apps/web-dashboard/lib/types.ts`, `android-app/.../console/Models.kt` | `lib/server/api.test.ts`, `db.test.ts` |
| Lifecycle state machine (`deriveStatus`) | `implemented` | `apps/web-dashboard/lib/domain-status.ts` | `lib/server/domain-status.test.ts` |
| Database migration v10 — `recorded` → `pending_dns`, no data loss, idempotent | `implemented` | `apps/web-dashboard/lib/server/db.ts` | `lib/server/db.test.ts` |
| Domain lifecycle REST routes (list / get / create / update / verify / delete / propagation / certificate / detect-provider) | `implemented` | `apps/web-dashboard/lib/server/api.ts` | `lib/server/api.test.ts` |
| DNS provider auto-detection (NS lookup, curated public-suffix list) | `implemented` | `apps/web-dashboard/lib/server/dns.ts` | `lib/server/dns.test.ts` |
| Hostname validation (server) with an inline client mirror | `implemented` | `lib/server/domain-validation.ts`; mirrors in `components/FeatureViews.tsx`, `ui/console/components/DnsCard.kt` | `lib/server/api.test.ts` (server); `DomainStatusTest.kt` (Android mirror) |
| Domain webhook events (`domain.created`, `domain.dns_verified`, `domain.dns_failed`, `domain.deleted`, …) | `implemented` | `lib/server/events.ts`, `lib/realtime.ts` | `lib/server/domain-events.test.ts` |
| Web DNS instruction card, three independent signal tiles, lifecycle pill | `implemented` | `apps/web-dashboard/components/DomainDnsCard.tsx`, `components/FeatureViews.tsx` | — (presentational) |
| Android domain cards: lifecycle pill, three signal tiles, DNS instruction card with copy-to-clipboard | `implemented` | `android-app/.../ui/console/components/{StatusPill,DnsCard}.kt`, `ui/console/pages/InfraPages.kt` | `DomainStatusTest.kt` |

## Phase 2 — Cloudflare integration · `absent`

Auto-configuration (writing DNS records), background verification polling,
SSL provisioning and renewal through the Cloudflare API, the certificate detail
view, and passkey step-up for destructive domain operations. Not started.

## Phase 3 — Mobile excellence · `absent`

Push notifications for domain events, biometric-gated emergency actions, origin
health probing, and the SSL-expiry push schedule. Not started.

## Phase 4 — Polish & observability · `partial`

| Capability | Status | Note |
| :--- | :--- | :--- |
| Global propagation status | `partial` | `verify` records one `public-resolver` region; there is no multi-region map yet |
| Domain event audit log | `partial` | Domain events are published to the transactional outbox and logged; there is no dedicated audit view |

## Honest limitations

- **SSL is recorded, not provisioned.** `ssl_status` stays `none` until Phase 2
  wires the Cloudflare API, so a domain can reach `dns_verified` and deliberately
  go no further. Nothing is shown as `active` on a timer.
- **Provider auto-configuration is not implemented.** The dashboard tells the
  operator which records to add and then verifies them; it never writes DNS. The
  API says so in its own response: _Automatic record configuration is not enabled
  in this build. Add the records shown, then verify._
- **Health is never probed yet,** so `health_status` stays `unknown` and the
  health tile reads "Unknown · Not probed yet".
- **The three signals are never collapsed.** `deriveStatus` gates the lifecycle on
  DNS alone and deliberately does not fold health into it — a live domain with a
  down origin keeps a green lifecycle tone and a red health tone at the same time.
- **`recorded` → `pending_dns` is a downgrade by design.** The previous
  record-only status claimed nothing; the new status says, truthfully, that DNS
  has not been verified yet. `created_at` is preserved.

## How to verify

```bash
# Web dashboard
cd apps/web-dashboard
npx tsc --noEmit
node --experimental-strip-types --test lib/server/*.test.ts
npm run build

# Android
cd android-app
./gradlew assembleDebug testDebugUnitTest
```
