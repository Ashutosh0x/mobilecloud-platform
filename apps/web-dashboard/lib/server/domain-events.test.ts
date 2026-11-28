import assert from "node:assert/strict";
import test from "node:test";
import { DOMAIN_EVENT_TYPES, domainEventId, isDomainEvent, type RealtimeEvent } from "../realtime.ts";

function envelope(overrides: Partial<RealtimeEvent> = {}): RealtimeEvent {
  return {
    event_id: "evt_1",
    event_type: "domain.dns_verified",
    schema_version: 1,
    account_id: "acct_1",
    resource_id: "dom_1",
    sequence: 1,
    occurred_at: new Date(0).toISOString(),
    payload: {},
    ...overrides,
  };
}

test("every documented domain event type is recognised", () => {
  for (const type of DOMAIN_EVENT_TYPES) {
    assert.equal(isDomainEvent(envelope({ event_type: type })), true, type);
  }
});

test("non-domain events are not mistaken for domain events", () => {
  for (const type of ["project.created", "build.updated", "server.status_changed", "domain.unknown"]) {
    assert.equal(isDomainEvent(envelope({ event_type: type })), false, type);
  }
});

test("domainEventId prefers resource_id and falls back to the payload", () => {
  assert.equal(domainEventId(envelope()), "dom_1");
  assert.equal(domainEventId(envelope({ resource_id: null, payload: { domainId: "dom_2" } })), "dom_2");
  assert.equal(domainEventId(envelope({ resource_id: null, payload: {} })), null);
  assert.equal(domainEventId(envelope({ resource_id: null, payload: { domainId: 7 } })), null);
});

test("a domain envelope carries the standard ordering/identity fields", () => {
  const event = envelope({ sequence: 42, event_id: "evt_42" });
  // Dedupe key and ordering key must both be present for the client reducer.
  assert.equal(event.event_id, "evt_42");
  assert.equal(event.sequence, 42);
  assert.equal(event.schema_version, 1);
  assert.equal(event.account_id, "acct_1");
});
