//! NSCC / DTC **T+1 clearing transit mathematics** (SEC Rule 15c6-1).
//!
//! The core false-positive hazard in tokenized-stock Proof-of-Reserve: a user
//! buys 150,000 dShares at 14:15 EST; the tokens mint instantly via
//! `OrderProcessor.sol`, but the underlying common shares do not settle at DTC
//! until the next business day. A naive oracle comparing DTC settled shares to
//! circulating supply reports a phantom 150,000-share deficit for 24 hours.
//!
//! This module implements the settlement-aware accounting from the case study
//! (§3) and the 10/10 blueprint (§4):
//!
//! ```text
//! Eligible Backing = C_t^settled + P_t^transit_deposits - R_t^pending_redeems
//! Backing Ratio    = Eligible Backing / Global Circulating Tokens * 10_000 bps
//! ```
//!
//! Time model:
//! * Market close: 16:00 America/New_York on business day T.
//! * Trades executed **before close** settle at DTC on business day T+1 by
//!   11:30 ET; trades executed **after close** settle T+2 (the next business
//!   day after T+1).
//! * Weekends and an injectable NYSE holiday calendar roll settlement forward.
//! * DST (EDT/EST) is derived deterministically from the civil date
//!   (2nd Sunday of March 02:00 → 1st Sunday of November 02:00).
//!
//! Internal representation: a *local day index* (days from 1970-01-01 in the
//! New York civil calendar) drives all day arithmetic; zone offsets only
//! convert instants ↔ day indices. This keeps every branch deterministic.

use crate::{execute_reconciliation, PoRError, ReconciliationInput, ReconciliationOutput};
use serde::{Deserialize, Serialize};

/// Wall-clock seconds from local midnight to the official market close (16:00 ET).
pub const MARKET_CLOSE_LOCAL_SECS: i64 = 16 * 3600;
/// Wall-clock seconds from local midnight to DTC settlement completion (11:30 ET).
pub const DTC_SETTLE_LOCAL_SECS: i64 = 11 * 3600 + 30 * 60;

/// The state of custodian cash backing an executed-but-unsettled purchase.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum TransitState {
    /// Trade executed; cash confirmed in the segregated customer sweep
    /// account; shares settle at DTC by `settle_by_utc`. Eligible backing.
    InT1Window { settle_by_utc: i64 },
    /// Past the settlement deadline — transit cash is no longer trustworthy
    /// and must be investigated (counted as neither settled nor eligible).
    Expired,
    /// The observation predates the trade — a chronology violation.
    ChronologyViolation,
}

/// Business-day calendar with an injectable NYSE holiday set.
///
/// `holidays` holds **local day indices** (days from 1970-01-01 in the New
/// York civil calendar) that DTC is closed, sorted ascending.
#[derive(Clone, Debug, Default)]
pub struct ClearingCalendar {
    pub holidays: Vec<i64>,
}

impl ClearingCalendar {
    /// Advance from `base_local_day` by the smallest number of days that
    /// lands on a business day (never fewer than `min_days_ahead`).
    fn next_business_day(&self, base_local_day: i64, min_days_ahead: i64) -> i64 {
        let mut days = min_days_ahead.max(1);
        loop {
            let candidate = base_local_day + days;
            if weekday_of_day_index(candidate) >= 5 || self.holidays.contains(&candidate) {
                days += 1;
                continue;
            }
            return candidate;
        }
    }

    /// UTC instant of New York local midnight for a civil day index.
    /// Resolves the EST/EDT offset with a 3-step fixed point so DST
    /// transition days land on the correct midnight instant.
    fn local_midnight_utc(local_day_index: i64) -> i64 {
        let mut instant = local_day_index * 86_400 + 5 * 3600; // EST guess
        for _ in 0..3 {
            let candidate = local_day_index * 86_400 + Self::et_to_utc_offset_secs(instant);
            if candidate == instant {
                break;
            }
            instant = candidate;
        }
        instant
    }

    /// Effective New York ↔ UTC offset (seconds, `UTC = local + offset`):
    /// EDT = 4h during DST, EST = 5h otherwise. DST spans from the second
    /// Sunday of March 02:00 local to the first Sunday of November 02:00 local.
    pub fn et_to_utc_offset_secs(timestamp_utc: i64) -> i64 {
        let year = unix_year(timestamp_utc);
        // 2nd Sunday of March at 02:00 local — that instant is still EST,
        // i.e. 07:00 UTC (02:00 EST). DST begins at or after it.
        let march_1 = local_midnight_of_civil(year, 3, 1);
        let march_dst_start =
            (march_1 + first_sunday_offset_from(march_1) + 7) * 86_400 + 2 * 3600 + 5 * 3600;
        // 1st Sunday of November at 02:00 local — that instant is EDT,
        // i.e. 06:00 UTC. DST ends at or after it.
        let nov_1 = local_midnight_of_civil(year, 11, 1);
        let nov_dst_end =
            (nov_1 + first_sunday_offset_from(nov_1)) * 86_400 + 2 * 3600 + 4 * 3600;
        if timestamp_utc >= march_dst_start && timestamp_utc < nov_dst_end {
            4 * 3600
        } else {
            5 * 3600
        }
    }

    /// Classify transit cash for a purchase executed at `executed_utc`,
    /// observed at `snapshot_utc`.
    pub fn classify_cash_transit(&self, executed_utc: i64, snapshot_utc: i64) -> TransitState {
        if executed_utc < 0 || snapshot_utc < 0 || snapshot_utc < executed_utc {
            return TransitState::ChronologyViolation;
        }
        let offset = Self::et_to_utc_offset_secs(executed_utc);
        let local_day = (executed_utc - offset).div_euclid(86_400);
        let day_start_utc = Self::local_midnight_utc(local_day);
        let market_close_utc = day_start_utc + MARKET_CLOSE_LOCAL_SECS;

        // T+1 for pre-close executions; T+2 for after-close executions.
        let base_days = if executed_utc < market_close_utc { 1 } else { 2 };
        let settle_local_day = self.next_business_day(local_day, base_days);
        let settle_day_start_utc = Self::local_midnight_utc(settle_local_day);
        let settle_by_utc = settle_day_start_utc + DTC_SETTLE_LOCAL_SECS;

        if snapshot_utc >= settle_by_utc {
            TransitState::Expired
        } else {
            TransitState::InT1Window { settle_by_utc }
        }
    }
}

/// Weekday of a civil day index (0 = Monday … 6 = Sunday).
/// Day 0 (1970-01-01) was a Thursday, hence the `+ 3`.
pub fn weekday_of_day_index(day_index: i64) -> i64 {
    (day_index + 3).rem_euclid(7)
}

fn unix_year(timestamp_utc: i64) -> i64 {
    // Civil-from-days (Howard Hinnant's algorithm), exact for 1970–2100.
    let days = timestamp_utc.div_euclid(86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    // Hinnant's month reconstruction: mp is month-minus-3 (March-based);
    // mp < 10 => Mar..Dec (m = mp + 3), else Jan/Feb of the next year.
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    y + i64::from(m <= 2)
}

/// Day index of `year-month-01` (Howard Hinnant's days_from_civil).
fn local_midnight_of_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Days from the 1st of the month until the first Sunday
/// (0 when the 1st is itself a Sunday; weekday 6 = Sunday).
fn first_sunday_offset_from(day_index: i64) -> i64 {
    (6 - weekday_of_day_index(day_index)).rem_euclid(7)
}

/// Full settlement-aware reconciliation snapshot binding the Four Proofs
/// together: supply ($S_t$), custody ($C_t$), entitlement ($E_t$), solvency ($\Sigma_t$).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SettlementAwareSnapshot {
    pub reconciliation: ReconciliationOutput,
    /// Whether verified T+1 transit cash was counted as eligible backing.
    pub transit_active: bool,
    /// Earliest DTC settlement deadline among counted transit batches.
    pub transit_settle_by_utc: Option<i64>,
    /// The gated input actually reconciled (audit trail).
    pub input: ReconciliationInput,
}

/// Compute the settlement-aware ratio with the full T+1 eligibility gate.
///
/// * `transit_states` — per-batch classification of custodian cash awaiting
///   NSCC clearing. Only [`TransitState::InT1Window`] batches are eligible.
/// * Any [`TransitState::Expired`] or [`TransitState::ChronologyViolation`]
///   batch fails the entire snapshot — a failed settlement must be
///   investigated, never silently counted or silently dropped.
/// * Transit with no verified window (empty `transit_states` but non-zero
///   `pending_deposits_transit`) equally fails: amounts without evidence
///   gate are uncountable.
pub fn compute_settlement_aware_ratio(
    input: &ReconciliationInput,
    transit_states: &[TransitState],
) -> Result<SettlementAwareSnapshot, PoRError> {
    let mut transit_active = false;
    let mut earliest_settle_by: Option<i64> = None;

    for state in transit_states {
        match state {
            TransitState::InT1Window { settle_by_utc } => {
                transit_active = true;
                earliest_settle_by = Some(match earliest_settle_by {
                    Some(existing) => existing.min(*settle_by_utc),
                    None => *settle_by_utc,
                });
            }
            TransitState::Expired | TransitState::ChronologyViolation => {
                return Err(PoRError::InvalidSettlementState);
            }
        }
    }
    if !transit_active && input.pending_deposits_transit > 0 {
        return Err(PoRError::InvalidSettlementState);
    }

    let eligible_transit = if transit_active {
        input.pending_deposits_transit
    } else {
        0
    };

    let gated_input = ReconciliationInput {
        onchain_supply: input.onchain_supply,
        settled_custody_shares: input.settled_custody_shares,
        pending_deposits_transit: eligible_transit,
        pending_redeem_transit: input.pending_redeem_transit,
    };
    let reconciliation = execute_reconciliation(&gated_input)?;
    Ok(SettlementAwareSnapshot {
        reconciliation,
        transit_active,
        transit_settle_by_utc: earliest_settle_by,
        input: gated_input,
    })
}

/// Stock-split reconciliation (accounting boundary rule 4): the DTC custody
/// position and the on-chain token supply must reflect the split
/// **concurrently** on the DTC ex-date. Scales custody by `num/den` in
/// 256-bit checked math and requires exact equality with on-chain supply.
pub fn reconcile_split(
    custody_shares: u128,
    onchain_supply: u128,
    split_factor_num: u128,
    split_factor_den: u128,
) -> Result<(u128, u128), PoRError> {
    if split_factor_den == 0 || split_factor_num == 0 {
        return Err(PoRError::InvalidSettlementState);
    }
    let custody_scaled = mul_div_u128(custody_shares, split_factor_num, split_factor_den)?;
    if custody_scaled != onchain_supply {
        return Err(PoRError::InvalidSettlementState);
    }
    Ok((custody_shares, onchain_supply))
}

/// Checked `(a * num) / den` in 256-bit space, requiring a u128 result.
fn mul_div_u128(a: u128, num: u128, den: u128) -> Result<u128, PoRError> {
    use crate::U256;
    if den == 0 {
        return Err(PoRError::DivisionByZero);
    }
    let product = U256::from_u128(a)
        .checked_mul(&U256::from_u128(num))
        .ok_or(PoRError::ArithmeticOverflow)?;
    let divided = product
        .checked_div(&U256::from_u128(den))
        .ok_or(PoRError::DivisionByZero)?;
    divided.as_u128_checked().ok_or(PoRError::ArithmeticOverflow)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SHARE: u128 = 1_000_000_000_000_000_000;

    // 2026-11-19 is a Thursday. Day index derived from days_from_civil.
    const THU_NOV19: i64 = {
        // const-eval friendly duplication of local_midnight_of_civil(2026,11,19)
        let y = 2026;
        let era = y / 400; // 5 (integer div, y >= 0)
        let yoe = y % 400; // 26
        let mp = (11 + 9) % 12; // 8
        let doy = (153 * mp + 2) / 5 + 19 - 1; // 263
        let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy; // 9759
        era * 146_097 + doe - 719_468 // 20776
    };

    #[test]
    fn weekday_math_is_correct() {
        assert_eq!(weekday_of_day_index(THU_NOV19), 3); // Thursday
        assert_eq!(weekday_of_day_index(0), 3); // 1970-01-01 was a Thursday
        assert_eq!(weekday_of_day_index(THU_NOV19 + 2), 5); // Saturday
        assert_eq!(weekday_of_day_index(THU_NOV19 + 4), 0); // Monday
    }

    #[test]
    fn pre_close_trade_settles_next_business_day() {
        let calendar = ClearingCalendar::default();
        // Thursday 2026-11-19 14:00 EST == 19:00 UTC.
        let executed = THU_NOV19 * 86_400 + 19 * 3600;
        // Snapshot at official market close: Thursday 16:00 EST == 21:00 UTC.
        let snapshot = THU_NOV19 * 86_400 + 21 * 3600;
        let state = calendar.classify_cash_transit(executed, snapshot);
        match state {
            TransitState::InT1Window { settle_by_utc } => {
                // Friday 2026-11-20 11:30 EST == 16:30 UTC.
                assert_eq!(settle_by_utc, (THU_NOV19 + 1) * 86_400 + 16 * 3600 + 30 * 60);
            }
            other => panic!("expected InT1Window, got {other:?}"),
        }
    }

    #[test]
    fn friday_trade_settles_monday() {
        let calendar = ClearingCalendar::default();
        // Friday 2026-11-20 10:00 EST == 15:00 UTC.
        let executed = (THU_NOV19 + 1) * 86_400 + 15 * 3600;
        let snapshot = executed + 3600;
        let state = calendar.classify_cash_transit(executed, snapshot);
        match state {
            TransitState::InT1Window { settle_by_utc } => {
                // Monday 2026-11-23 11:30 EST == 16:30 UTC.
                assert_eq!(settle_by_utc, (THU_NOV19 + 4) * 86_400 + 16 * 3600 + 30 * 60);
            }
            other => panic!("expected InT1Window, got {other:?}"),
        }
    }

    #[test]
    fn transit_expires_after_dtc_deadline() {
        let calendar = ClearingCalendar::default();
        let executed = THU_NOV19 * 86_400 + 19 * 3600; // Thursday 14:00 EST
        let after_deadline = (THU_NOV19 + 1) * 86_400 + 16 * 3600 + 30 * 60 + 1;
        assert_eq!(
            calendar.classify_cash_transit(executed, after_deadline),
            TransitState::Expired
        );
    }

    #[test]
    fn holiday_rolls_settlement_forward() {
        let calendar = ClearingCalendar {
            holidays: vec![THU_NOV19 + 1], // Friday 2026-11-20 closed
        };
        let executed = THU_NOV19 * 86_400 + 19 * 3600; // Thursday pre-close
        let state = calendar.classify_cash_transit(executed, THU_NOV19 * 86_400 + 21 * 3600);
        match state {
            TransitState::InT1Window { settle_by_utc } => {
                // Rolls Friday → Monday 2026-11-23 11:30 EST.
                assert_eq!(settle_by_utc, (THU_NOV19 + 4) * 86_400 + 16 * 3600 + 30 * 60);
            }
            other => panic!("expected InT1Window, got {other:?}"),
        }
    }

    #[test]
    fn after_close_execution_settles_two_days_out() {
        let calendar = ClearingCalendar::default();
        // Thursday 20:00 EST == Friday 01:00 UTC.
        let executed = (THU_NOV19 + 1) * 86_400 + 3600;
        let snapshot = executed + 600;
        let state = calendar.classify_cash_transit(executed, snapshot);
        match state {
            TransitState::InT1Window { settle_by_utc } => {
                // T+2 from Thursday's perspective: Friday is T+1 (weekend-
                // skipped), so settlement lands Monday 11:30 EST.
                assert_eq!(settle_by_utc, (THU_NOV19 + 4) * 86_400 + 16 * 3600 + 30 * 60);
            }
            other => panic!("expected InT1Window, got {other:?}"),
        }
    }

    #[test]
    fn chronology_violation_when_snapshot_precedes_trade() {
        let calendar = ClearingCalendar::default();
        let executed = THU_NOV19 * 86_400 + 19 * 3600;
        assert_eq!(
            calendar.classify_cash_transit(executed, executed - 1),
            TransitState::ChronologyViolation
        );
    }

    #[test]
    fn dst_spring_forward_monday_settlement_uses_edt() {
        // Monday 2026-03-09 is the day after the 2nd-Sunday-of-March DST
        // start (Sunday 2026-03-08). A Friday 2026-03-06 pre-close trade
        // settles Monday 11:30 **EDT** == 15:30 UTC.
        let fri_mar6 = local_midnight_of_civil(2026, 3, 6);
        let calendar = ClearingCalendar::default();
        let executed = fri_mar6 * 86_400 + 19 * 3600; // Friday 14:00 EST
        let snapshot = fri_mar6 * 86_400 + 21 * 3600;
        let state = calendar.classify_cash_transit(executed, snapshot);
        match state {
            TransitState::InT1Window { settle_by_utc } => {
                // Monday 11:30 EDT = Monday 15:30 UTC.
                assert_eq!(settle_by_utc, (fri_mar6 + 3) * 86_400 + 15 * 3600 + 30 * 60);
            }
            other => panic!("expected InT1Window, got {other:?}"),
        }
    }

    #[test]
    fn settlement_aware_ratio_counts_eligible_transit() {
        let input = ReconciliationInput {
            onchain_supply: 1_000_000 * SHARE,
            settled_custody_shares: 850_000 * SHARE,
            pending_deposits_transit: 150_000 * SHARE,
            pending_redeem_transit: 0,
        };
        let states = vec![TransitState::InT1Window { settle_by_utc: 1_774_163_400 }];
        let snapshot = compute_settlement_aware_ratio(&input, &states).unwrap();
        assert_eq!(snapshot.reconciliation.reserve_ratio_bps, 10_000);
        assert!(snapshot.transit_active);
    }

    #[test]
    fn expired_transit_rejects_whole_snapshot() {
        let input = ReconciliationInput {
            onchain_supply: 1_000_000 * SHARE,
            settled_custody_shares: 850_000 * SHARE,
            pending_deposits_transit: 150_000 * SHARE,
            pending_redeem_transit: 0,
        };
        assert_eq!(
            compute_settlement_aware_ratio(&input, &[TransitState::Expired]),
            Err(PoRError::InvalidSettlementState)
        );
    }

    #[test]
    fn transit_without_verified_window_is_uncountable() {
        let input = ReconciliationInput {
            onchain_supply: 1_000_000 * SHARE,
            settled_custody_shares: 850_000 * SHARE,
            pending_deposits_transit: 150_000 * SHARE,
            pending_redeem_transit: 0,
        };
        // No transit states provided → the 150k transit cannot be counted.
        assert_eq!(
            compute_settlement_aware_ratio(&input, &[]),
            Err(PoRError::InvalidSettlementState)
        );
    }

    #[test]
    fn settled_only_snapshot_skips_transit() {
        let input = ReconciliationInput {
            onchain_supply: 1_000_000 * SHARE,
            settled_custody_shares: 1_000_000 * SHARE,
            pending_deposits_transit: 0,
            pending_redeem_transit: 0,
        };
        let snapshot = compute_settlement_aware_ratio(&input, &[]).unwrap();
        assert!(!snapshot.transit_active);
        assert_eq!(snapshot.reconciliation.reserve_ratio_bps, 10_000);
    }

    #[test]
    fn split_reconciliation_detects_asymmetry() {
        // 2:1 split: pre-split custody 1,000,000 scaled to 2,000,000 must
        // match the rebased on-chain supply exactly.
        assert!(reconcile_split(1_000_000 * SHARE, 2_000_000 * SHARE, 2, 1).is_ok());
        // Supply not rebased concurrently: mismatch rejected.
        assert_eq!(
            reconcile_split(1_000_000 * SHARE, 1_000_000 * SHARE, 2, 1),
            Err(PoRError::InvalidSettlementState)
        );
    }

    #[test]
    fn mul_div_handles_256_bit_intermediates() {
        // (u128::MAX * 2) / 2 == u128::MAX, with a 256-bit intermediate.
        let max = u128::MAX;
        assert_eq!(mul_div_u128(max, 2, 2).unwrap(), max);
        // (u128::MAX * 2) / 3 truncates toward zero — the intermediate
        // product exceeds u128, so the 256-bit path is mandatory.
        let expected = crate::U256::from_u128(max)
            .checked_mul(&crate::U256::from_u64(2))
            .unwrap()
            .checked_div(&crate::U256::from_u64(3))
            .unwrap()
            .as_u128_checked()
            .unwrap();
        assert_eq!(mul_div_u128(max, 2, 3).unwrap(), expected);
    }
}
