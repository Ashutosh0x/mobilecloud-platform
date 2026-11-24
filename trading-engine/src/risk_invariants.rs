//! The four non-negotiable risk invariants (trading spec §5).
//!
//! Every execution path MUST pass all four gates before an order reaches
//! the wire:
//!
//! | # | Invariant                | Enforcement |
//! |---|--------------------------|-------------|
//! | 1 | Atomic reverts only      | Jito bundle construction; no naked legs |
//! | 2 | Max 2.5% equity exposure | Per-position hard cap |
//! | 3 | 20% T+1 clearing buffer  | Overnight capital reserve in USDC/USDY |
//! | 4 | ≤ 15 bps slippage        | Depth-checked execution guard |

/// Invariant 2: maximum share of portfolio equity per single position.
pub const MAX_POSITION_EQUITY_BPS: u64 = 250; // 2.5%

/// Invariant 3: minimum T+1 clearing buffer held in overnight yield assets.
pub const T1_CLEARING_BUFFER_BPS: u64 = 2_000; // 20%

/// Invariant 4: maximum slippage band vs prevailing mid (basis points).
pub const MAX_SLIPPAGE_BPS: u32 = 15;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum RiskViolation {
    #[error("invariant 2: position {requested_micro_usdc} exceeds 2.5% equity cap ({allowed_micro_usdc})")]
    PositionCapExceeded {
        requested_micro_usdc: u64,
        allowed_micro_usdc: u64,
    },
    #[error("invariant 3: T+1 buffer degraded — reserve {reserve_micro_usdc} below 20% of {open_exposure_micro_usdc}")]
    T1BufferBreached {
        reserve_micro_usdc: u64,
        open_exposure_micro_usdc: u64,
    },
    #[error("invariant 4: projected slippage {observed_bps} bps exceeds {MAX_SLIPPAGE_BPS} bps hard limit")]
    SlippageExceeded { observed_bps: u32 },
    #[error("invariant 1: attempted naked (non-atomic) execution")]
    NakedExecution,
}

/// The risk supervisor verdict for one proposed execution.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RiskDecision {
    /// All four invariants hold — permit execution.
    Permit,
    /// At least one invariant failed — abort and alert the node supervisor.
    Reject { violations: Vec<RiskViolation> },
}

/// Evaluate a proposed trade against all four invariants.
///
/// * `portfolio_equity_micro_usdc` — total USDC equity across venues.
/// * `open_exposure_micro_usdc` — notional currently deployed in open trades.
/// * `overnight_reserve_micro_usdc` — capital parked in USDC/USDY for NSCC margin.
/// * `projected_slippage_bps` — worst-case execution slippage for the size.
pub fn evaluate_trade(
    requested_size_micro_usdc: u64,
    portfolio_equity_micro_usdc: u64,
    open_exposure_micro_usdc: u64,
    overnight_reserve_micro_usdc: u64,
    projected_slippage_bps: u32,
    is_atomic_bundle: bool,
) -> RiskDecision {
    let mut violations = Vec::new();

    // Invariant 1: strict atomicity — no naked legs ever.
    if !is_atomic_bundle {
        violations.push(RiskViolation::NakedExecution);
    }

    // Invariant 2: per-position equity cap (integer-exact).
    // Widen to u128 before multiplying: equity is denominated in micro-USDC, so
    // a naive u64 multiply by the bps constant overflows above ~$73.8M and
    // panics (debug) or wraps to a near-zero cap (release).
    let allowed =
        (u128::from(portfolio_equity_micro_usdc) * u128::from(MAX_POSITION_EQUITY_BPS) / 10_000)
            as u64;
    if requested_size_micro_usdc > allowed {
        violations.push(RiskViolation::PositionCapExceeded {
            requested_micro_usdc: requested_size_micro_usdc,
            allowed_micro_usdc: allowed,
        });
    }

    // Invariant 3: T+1 clearing buffer on total open exposure.
    // Same u128 widening: open exposure above ~$9.2M overflows a u64 multiply
    // by 2_000 bps, which would silently understate the required buffer.
    let required_buffer =
        (u128::from(open_exposure_micro_usdc) * u128::from(T1_CLEARING_BUFFER_BPS) / 10_000) as u64;
    if overnight_reserve_micro_usdc < required_buffer {
        violations.push(RiskViolation::T1BufferBreached {
            reserve_micro_usdc: overnight_reserve_micro_usdc,
            open_exposure_micro_usdc,
        });
    }

    // Invariant 4: slippage hard band.
    if projected_slippage_bps > MAX_SLIPPAGE_BPS {
        violations.push(RiskViolation::SlippageExceeded {
            observed_bps: projected_slippage_bps,
        });
    }

    if violations.is_empty() {
        RiskDecision::Permit
    } else {
        RiskDecision::Reject { violations }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const EQUITY: u64 = 50_000 * 1_000_000; // $50,000

    #[test]
    fn compliant_trade_is_permitted() {
        // 2% of equity ($1,000) with full buffer and tight slippage.
        let decision = evaluate_trade(
            1_000 * 1_000_000,
            EQUITY,
            0,
            5_000 * 1_000_000,
            9,
            true,
        );
        assert_eq!(decision, RiskDecision::Permit);
    }

    #[test]
    fn position_over_cap_is_rejected() {
        // 3% of equity exceeds the 2.5% cap.
        let decision = evaluate_trade(1_500 * 1_000_000, EQUITY, 0, 20_000 * 1_000_000, 5, true);
        match decision {
            RiskDecision::Reject { violations } => {
                assert!(matches!(
                    violations[0],
                    RiskViolation::PositionCapExceeded { .. }
                ));
            }
            other => panic!("expected rejection, got {other:?}"),
        }
    }

    #[test]
    fn degraded_t1_buffer_is_rejected() {
        // $30k open exposure requires $6k buffer; only $1k parked.
        let decision = evaluate_trade(
            500 * 1_000_000,
            EQUITY,
            30_000 * 1_000_000,
            1_000 * 1_000_000,
            5,
            true,
        );
        assert!(matches!(
            decision,
            RiskDecision::Reject { .. }
        ));
    }

    #[test]
    fn wide_slippage_is_rejected() {
        let decision = evaluate_trade(
            500 * 1_000_000,
            EQUITY,
            0,
            20_000 * 1_000_000,
            16,
            true,
        );
        assert!(matches!(
            decision,
            RiskDecision::Reject { violations } if matches!(violations[0], RiskViolation::SlippageExceeded { observed_bps: 16 })
        ));
    }

    #[test]
    fn naked_execution_is_always_rejected() {
        let decision = evaluate_trade(
            100 * 1_000_000,
            EQUITY,
            0,
            20_000 * 1_000_000,
            1,
            false,
        );
        assert!(matches!(
            decision,
            RiskDecision::Reject { violations } if violations.contains(&RiskViolation::NakedExecution)
        ));
    }
}
