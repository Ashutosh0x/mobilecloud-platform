# Solvency Model — Basis Points, Thresholds & Ratio Math

Status: `VERIFIED_SOURCE` (checked math + 10,000-case table test) and
`DEPLOYED` (live threshold sweep, see VERIFIED-BASELINE.md).

## The scale

Reserve adequacy is expressed in **basis points (bps)** of the circulating
supply:

```
ratio_bps = (reserves × 10,000) / supply     (checked math; overflow ⇒ PoRError::ArithmeticOverflow)
```

| ratio_bps | Meaning |
| :--- | :--- |
| 10,000 | 100% backed — fully reserved |
| 9,950–9,999 | `WARNING` band (deployed default floor: 9,950) |
| < 9,950 | `CRITICAL` |

- All amounts use the **18-decimal share convention** (`u128`); the case-study
  values (10²⁴ base units = 1,000,000 shares) are carried end-to-end on-chain
  with no truncation.
- **Zero-supply convention:** `supply == 0 ⇒ ratio = 10,000` (fully backed by
  convention — snapshot `zero_supply_is_fully_backed_by_convention`).

## Deployed default policy (Gate 7)

| Parameter | Value | Source |
| :--- | :--- | :--- |
| `HEALTHY_BPS` | 10,000 | `storage.rs:84` |
| `WARNING_FLOOR_BPS` | **9,950** | `storage.rs:85` |

> **Correction history:** stale roadmap notes said 9,500. The deployed
> contract uses 9,950 — proven live: 9,700 bps committed `CRITICAL` (T9) and
> 9,970 bps committed `WARNING` (T10). The on-chain kernel-side classification
> agrees with the contract; the old documents were the outlier.

Per-asset governance can override the defaults via `set_asset_policy`
(validation: `0 < warning_floor < healthy ≤ 10,000`) — see GOVERNANCE.md.

## Live classification evidence

| Ratio | Classification | Evidence |
| :--- | :--- | :--- |
| 9,300 bps | `CRITICAL` | T11, ledger 5,847,380 |
| 9,700 bps | `CRITICAL` | T9, ledger 5,847,359 (below the 9,950 floor) |
| 9,970 bps | `WARNING` | T10, ledger 5,847,376 (inside 9,950–9,999) |
| 10,000 bps | `HEALTHY` | T1/T4/T12 (ledgers 5,847,205 / 5,847,300 / 5,847,384) |

## Test coverage of the model [VERIFIED_SOURCE]

- `ten_thousand_classification_cases` — exhaustive classification table test.
- `status_tiers_follow_basis_point_thresholds` — tier boundaries.
- `g7_def_01` / `g7_set_01` — default and custom (9000/8000) boundaries.
- Kernel-side: 58 `por-kernel` tests cover the reconciliation math that
  produces `reserves` and `supply` (multi-chain circulation vs DTC-settled +
  T+1 transit).

## Status is advisory

The contract commits and publishes the classification; it does not halt third
parties by itself. Response actions (monitoring escalation, external circuit
breaker) are wiring decisions — see GOVERNANCE.md and
`specs/FP-ENG-2026-QRP-01.md` §6.
