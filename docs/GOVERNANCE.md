# Governance — Gate 7 Parameterized Tier Policies

Status: `VERIFIED_SOURCE` (9 Gate 7 tests) + `DEPLOYED` (live policy
classification sweep). Full spec: `specs/FP-ENG-2026-DOC-01.md` (rev 2.0).

## What Gate 7 adds

Per-asset threshold governance: an admin can override the deployed default
tier policy (`healthy 10,000 / warning floor 9,950 bps`) for any asset, with
validation, authorization, an event contract, and a hard non-retroactivity
guarantee.

## ABI

| Function | Access | Behavior |
| :--- | :--- | :--- |
| `set_asset_policy(asset, healthy_bps, warning_floor_bps)` | admin only (`UnauthorizedGovernance = 10`) | validates, persists, emits `GOVERNANCE_CONFIG` |
| `get_asset_policy(asset)` | public | stored policy or `DEFAULT_POLICY` (delegates to `storage::asset_policy`) |

**Validation rule** (`InvalidPolicyParams = 12`):
`0 < warning_floor_bps < healthy_bps ≤ 10_000`.

## The `GOVERNANCE_CONFIG` event — shipped shape is a `Vec<u32>`

Integrators MUST deserialize the data value as an XDR `ScVal::Vec` of four
`ScVal::U32` elements — `[old_healthy, old_warning_floor, new_healthy,
new_warning_floor]` (`lib.rs:332–346`, pinned by snapshot `g7_reg_02_…`):

```rust
// ACTUAL SHIPPED CONTRACT (lib.rs:332-346)
let mut payload: Vec<u32> = Vec::new(&env);
payload.push_back(old.healthy_bps);
payload.push_back(old.warning_floor_bps);
payload.push_back(healthy_bps);
payload.push_back(warning_floor_bps);
env.events().publish(
    (Symbol::new(&env, "GOVERNANCE_CONFIG"), asset_symbol),
    payload,
);
```

> A draft once illustrated this as a 4-tuple with a helper named
> `storage::get_policy` — neither exists in the shipped source. Indexers
> parsing a tuple will fail to deserialize.

## Non-retroactivity invariant (`G7-REG-03`)

Policy changes apply **prospectively only**. Changing a policy never rewrites
or re-classifies historical committed `AttestationRecord` / `AssetStatus`
data — proven by
`g7_reg_03_policy_change_cannot_retroactively_clear_committed_status`.

## Gate 7 test register (9 tests, real IDs)

| ID | Test | Snapshot |
| :--- | :--- | :--- |
| `G7-DEF-01` | default policy matches baseline boundaries | `g7_def_01_….1.json` |
| `G7-SET-01` | custom policy 9000/8000 reclassifies boundaries | `g7_set_01_….1.json` |
| `G7-SET-02` | `get_asset_policy`: default then governed per asset | `g7_set_02_….1.json` |
| `G7-AUTH-01` | non-admin cannot `set_asset_policy` | `g7_auth_01_….1.json` |
| `G7-VAL-01` | rejects `warning_floor ≥ healthy` | `g7_val_01_….1.json` |
| `G7-VAL-02` | rejects `healthy > 10_000` | `g7_val_02_….1.json` |
| `G7-VAL-03` | rejects zero warning floor | `g7_val_03_….1.json` |
| `G7-REG-02` | `GOVERNANCE_CONFIG` event carries transition payload | `g7_reg_02_….1.json` |
| `G7-REG-03` | policy change cannot retroactively clear committed status | `g7_reg_03_….1.json` |

## Advisory model

Status publication does not autonomously halt trading/minting; external
wiring (circuit breaker / transfer hook) decides enforcement. See
SECURITY-MODEL.md for the honest compromised-admin threat analysis (Phase 3
Timelock + Multi-sig requirement).
