import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openDb } from "./db.ts";
import { POR_STATUSES, insertAttestation, porState, validateAttestation } from "./por.ts";

const db = openDb(join(mkdtempSync(join(tmpdir(), "mc-por-")), "t.db"));
const owner = "owner-1";

const valid = {
  status: "healthy",
  reserveRatioBps: 10050,
  totalBackingBase: "1000000000000000000000",
  totalLiabilitiesBase: "995000000000000000000",
  netDifferenceBase: "5000000000000000000",
  evidenceAgeSec: 120,
  ledgerSequence: 42,
  digest: "abcdef0123456789",
  quorum: "3-of-5",
  observedAt: 1_700_000_000_000,
};

test("attestation validation rejects anything the kernel did not produce", () => {
  assert.equal(validateAttestation(valid).ok, true);
  assert.deepEqual(POR_STATUSES.length, 6);

  const bad = (input: Record<string, unknown>) => {
    const result = validateAttestation(input);
    assert.equal(result.ok, false, `expected rejection for ${JSON.stringify(input)}`);
  };
  bad({ ...valid, status: "trust-me" });
  bad({ ...valid, reserveRatioBps: 1.5 });
  bad({ ...valid, reserveRatioBps: -1 });
  bad({ ...valid, reserveRatioBps: 2_000_000 });
  bad({ ...valid, totalBackingBase: "-5" });
  bad({ ...valid, totalBackingBase: "1e18" });
  bad({ ...valid, totalLiabilitiesBase: 995_000 });
  bad({ ...valid, evidenceAgeSec: -1 });
  bad({ ...valid, ledgerSequence: 1.2 });
  bad({ ...valid, digest: "not-hex" });
  bad({ ...valid, quorum: "x".repeat(200) });
});

test("an account with no published attestation is explicitly unverified", () => {
  const state = porState(db, "nobody");
  assert.equal(state.verified, false);
  assert.equal(state.status, "unverified");
  assert.equal(state.attestation, null);
  assert.match(state.reason, /unverified/i);
});

test("a stored attestation is served back verbatim, with base units unrounded", () => {
  const input = validateAttestation(valid);
  assert.equal(input.ok, true);
  if (!input.ok) return;
  const recorded = insertAttestation(db, owner, input.value);
  assert.equal(recorded.totalBackingBase, valid.totalBackingBase);

  const state = porState(db, owner);
  assert.equal(state.verified, true);
  assert.equal(state.status, "healthy");
  assert.equal(state.attestation?.reserveRatioBps, 10050);
  assert.equal(state.attestation?.totalBackingBase, valid.totalBackingBase);
  assert.equal(state.attestation?.netDifferenceBase, valid.netDifferenceBase);
  assert.equal(state.attestation?.digest, valid.digest);
});

test("a newer attestation supersedes the previous one", () => {
  const next = validateAttestation({ ...valid, status: "critical", reserveRatioBps: 9000, digest: "ffeeddccbbaa9988" });
  assert.equal(next.ok, true);
  if (!next.ok) return;
  insertAttestation(db, owner, next.value);
  const state = porState(db, owner);
  assert.equal(state.status, "critical");
  assert.equal(state.attestation?.digest, "ffeeddccbbaa9988");
});

test("attestations never leak between accounts", () => {
  const state = porState(db, "someone-else");
  assert.equal(state.verified, false);
});
