# Stellar Soroban Mechanics — Protocol 30, TTL & Archival

Status: `DEPLOYED` (all numbers below are from the frozen live baseline).

## Deployment facts

| Item | Value |
| :--- | :--- |
| Contract | `CDWNCMD6NG652YNX5PV2VLAWW4HMJGFICVE55NSDMSPS76H2VSLOEDPI` |
| WASM hash | `8ebcebc32894d39cbd50867249952f8fb0d9b04e6ae1251ccf34c26aad013648` |
| Network / Protocol | Stellar Testnet / Protocol 30 |
| SDK / XDR crate | `soroban-sdk 22.0.11` / `stellar-xdr 22.1.0` |
| Upgrade path | **None** — `initialize` is once-only (`AlreadyInitialized = 1`); redeploy ⇒ new contract ID ⇒ new `seq = 1` series |

## Storage model

| Key (per asset) | Contents | Durability |
| :--- | :--- | :--- |
| `LatestRecord(asset)` | seq, epoch, reserves, supply, ratio_bps, `valid_until` | Persistent |
| `AssetStatus(asset)` | committed status symbol (`HEALTHY` / `WARNING` / `CRITICAL`) | Persistent |
| `AssetPolicy(asset)` | Gate 7 tier policy (absent ⇒ `DEFAULT_POLICY` 10,000/9,950) | Persistent |
| Instance | signers registry (5 Ed25519 keys), threshold, admin | Persistent |

Verification is **O(N) over the signer registry** with strictly ascending
public-key order enforced (`SignerOrderInvalid = 3`).

## TTL & the archival trap — measured, not theoretical

At audit close (ledger 5,847,384) the live entry showed:

```text
lastModified 5,847,384 → liveUntil 5,957,979  (= +110,595 ledgers ≈ 6.4 days)
```

> The **deployed WASM predates the 120-day source constants** — its entries
> get a ~6.4-day bump per write, not ~120 days. The 120-day figure applies to
> the current source (`TTL_EXTEND_TO_LEDGERS`). Consequence: on this
> deployment, an asset that skips attestations for roughly a week can have
> its `AssetPolicy` / `AttestationRecord` keys **archived**; the next
> `submit_attestation` then traps at the VM level unless the entry is
> restored first. `por-keeper` automation (restore-or-bump) is the required
> mitigation, and the fix compounds with redeployment onto current-source
> WASM.

## Events (consumer contract)

| Event | Data shape | Meaning |
| :--- | :--- | :--- |
| `POR_AUDIT(asset)` | `ScVal::U32` — committed ratio bps | one per committed attestation (6 recovered live via `getEvents`) |
| `GOVERNANCE_CONFIG(asset)` | `ScVal::Vec` of **4 × `ScVal::U32`** — `[old_healthy, old_warning_floor, new_healthy, new_warning_floor]` | per-asset policy change (see GOVERNANCE.md) |
| `GOVERNANCE_FREEZE(asset)` | freeze/unfreeze marker | issuer-governance freeze state change |

## Error surface (ABI-stable, never renumber)

`PoRError` 1–12 as tabulated in `specs/FP-ENG-2026-DOC-01.md` §4. Freshness
rejects with `AttestationExpired(6)`; `EvidenceStale(11)` is reserved
(Phase 3 sliding window).

## Gas & costs

No gas figures are quoted in these docs: every published number must be
reproducible from the frozen baseline, and per-op fees vary with network
state. Read the actual resource usage from your own simulation/invoke results
(`stellar contract invoke` prints it) — see INTEGRATION-GUIDE.md.
