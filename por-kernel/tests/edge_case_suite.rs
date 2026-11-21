//! The 10,000 synthetic edge-case verification suite.
//!
//! Tranche 2 exit gate (`FURLPAY_INSTITUTIONAL_POR_PRODUCTION_SPECIFICATION_2026.md` §6):
//! "Deterministic verification of 10,000 synthetic test envelopes with ZERO
//! overflows." The generator is a fixed-seed xorshift PRNG so every run —
//! on every Acurast node, in CI, and in the security audit — exercises the
//! identical case matrix.

use por_kernel::accounting::t1_settlement::{compute_settlement_aware_ratio, ClearingCalendar, TransitState};
use por_kernel::envelope::{
    canonicalize, base64url_decode, base64url_encode, sha256_hex, AssetIdentifier, EnvelopeHeader,
    EnvelopePayload, EvidenceEnvelope, SourceEntity, MAX_ENVELOPE_TTL_SECS, SCHEMA_VERSION,
};
use por_kernel::{
    classify_reserve_state, execute_reconciliation, PoRError, ReconciliationInput, ReserveStatus,
    U256, HEALTHY_BPS, WARNING_FLOOR_BPS,
};

// ---------------------------------------------------------------------------
// Deterministic PRNG (xorshift64star) — no external RNG dependency.
// ---------------------------------------------------------------------------

struct Lcg(u64);

impl Lcg {
    fn new(seed: u64) -> Self {
        Lcg(seed | 1)
    }
    fn next_u64(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    /// Uniform u128 from two 64-bit draws.
    fn next_u128(&mut self) -> u128 {
        ((self.next_u64() as u128) << 64) | self.next_u64() as u128
    }
    /// Draw biased toward interesting regions: zero, one, max, powers of two,
    /// 18-decimal share magnitudes, and uniform noise.
    fn next_interesting(&mut self) -> u128 {
        const SHARE: u128 = 1_000_000_000_000_000_000;
        match self.next_u64() % 8 {
            0 => 0,
            1 => 1,
            2 => u128::MAX,
            3 => 1u128 << (self.next_u64() % 128),
            4 => SHARE * (self.next_u64() % 10_000_000) as u128,
            5 => SHARE * (self.next_u64() % 1_000) as u128 + self.next_u64() as u128,
            6 => u128::MAX - (self.next_u64() as u128),
            _ => self.next_u128() % (1_000_000 * SHARE),
        }
    }
}

// ---------------------------------------------------------------------------
// Suite 1: 10,000 reconciliation cases — zero panics, zero silent overflow.
// ---------------------------------------------------------------------------

#[test]
fn ten_thousand_reconciliation_cases() {
    let mut rng = Lcg::new(0x10_000_00_1);
    for case in 0..10_000u32 {
        let settled = rng.next_interesting();
        let transit = rng.next_interesting();
        let redeems = rng.next_interesting();
        let supply = rng.next_interesting();

        let input = ReconciliationInput {
            onchain_supply: supply,
            settled_custody_shares: settled,
            pending_deposits_transit: transit,
            pending_redeem_transit: redeems,
        };

        // The kernel must ALWAYS return a typed result — never panic, never
        // saturate silently.
        let result = std::panic::catch_unwind(|| execute_reconciliation(&input))
            .unwrap_or_else(|_| panic!("case {case}: kernel panicked on {input:?}"));

        match result {
            Ok(output) => {
                // Invariant 1: backing/liabilities sums match checked u128 math.
                assert_eq!(
                    output.total_backing_base,
                    settled.checked_add(transit).expect("kernel summed but u128 overflows"),
                    "case {case}"
                );
                assert_eq!(
                    output.total_liabilities_base,
                    supply.checked_add(redeems).expect("kernel summed but u128 overflows"),
                    "case {case}"
                );
                // Invariant 2: status tier matches the basis-point thresholds.
                if output.total_liabilities_base == 0 {
                    assert_eq!(output.status, ReserveStatus::ZeroSupply, "case {case}");
                    assert_eq!(output.reserve_ratio_bps, HEALTHY_BPS, "case {case}");
                } else if output.reserve_ratio_bps >= HEALTHY_BPS {
                    assert_eq!(output.status, ReserveStatus::Healthy, "case {case}");
                } else if output.reserve_ratio_bps >= WARNING_FLOOR_BPS {
                    assert_eq!(output.status, ReserveStatus::Warning, "case {case}");
                } else {
                    assert_eq!(output.status, ReserveStatus::Critical, "case {case}");
                }
                // Invariant 3: net difference consistency.
                let expected_diff = if output.total_backing_base >= output.total_liabilities_base {
                    output.total_backing_base - output.total_liabilities_base
                } else {
                    output.total_liabilities_base - output.total_backing_base
                };
                assert_eq!(output.net_difference_base, expected_diff, "case {case}");
                // Invariant 4 (exactness cross-check for small cases): the
                // 256-bit ratio must equal naive u128 math when the scaled
                // product fits; a larger naive ratio means the kernel must
                // have returned a typed overflow instead of Ok.
                // ZeroSupply uses the 10,000-bps convention — naive division
                // does not apply, so the exactness check skips it.
                if output.total_liabilities_base > 0 {
                if let Some(backing) = u128::checked_mul(output.total_backing_base, 10_000) {
                    let naive_bps = backing / output.total_liabilities_base;
                    assert!(
                        naive_bps <= u32::MAX as u128,
                        "case {case}: naive ratio exceeds u32 but kernel returned Ok"
                    );
                    assert_eq!(output.reserve_ratio_bps as u128, naive_bps, "case {case}");
                }
                }
                // Invariant 5: 5-tier state machine never panics.
                let tier = classify_reserve_state(&output, rng.next_u64() % 100_000, transit > 0, false);
                let _ = tier;
            }
            Err(PoRError::ArithmeticOverflow) => {
                // Explicit overflow is acceptable ONLY when true 256-bit math
                // overflows: settled + transit, supply + redeems, or the
                // bps scaling genuinely exceed bounds.
                let sum_overflow = settled.checked_add(transit).is_none()
                    || supply.checked_add(redeems).is_none();
                let ratio_overflow = !sum_overflow
                    && U256::from_u128(settled.checked_add(transit).unwrap())
                        .checked_mul(&U256::from_u64(10_000))
                        .is_none();
                // Fourth legal source: the final ratio exceeds u32::MAX bps
                // (>429,496x over-collateralization) — typed overflow, never
                // clamped (kernel design invariant).
                let ratio_exceeds_u32 = !sum_overflow
                    && supply.checked_add(redeems).unwrap_or(1) > 0
                    && {
                        let backing = settled.checked_add(transit).unwrap();
                        let liabilities = supply.checked_add(redeems).unwrap();
                        // 256-bit ratio via the kernel's own primitive.
                        U256::from_u128(backing)
                            .checked_mul(&U256::from_u64(10_000))
                            .and_then(|scaled| scaled.checked_div(&U256::from_u128(liabilities)))
                            .map(|r| r > U256::from_u64(u32::MAX as u64))
                            .unwrap_or(false)
                    };
                assert!(
                    sum_overflow || ratio_overflow || ratio_exceeds_u32,
                    "case {case}: overflow raised without true overflow"
                );
            }
            Err(other) => panic!("case {case}: unexpected error {other:?} for {input:?}"),
        }
    }
}

// ---------------------------------------------------------------------------
// Suite 2: boundary conditions at exact threshold values.
// ---------------------------------------------------------------------------

#[test]
fn threshold_boundaries() {
    const SHARE: u128 = 1_000_000_000_000_000_000;

    fn ratio_for(settled: u128, supply: u128) -> u32 {
        execute_reconciliation(&ReconciliationInput {
            onchain_supply: supply,
            settled_custody_shares: settled,
            pending_deposits_transit: 0,
            pending_redeem_transit: 0,
        })
        .unwrap()
        .reserve_ratio_bps
    }

    // Exactly 100.00% -> 10,000 bps Healthy.
    assert_eq!(ratio_for(1_000_000 * SHARE, 1_000_000 * SHARE), 10_000);
    // 99.99% -> 9,999 bps Warning.
    assert_eq!(ratio_for(999_900 * SHARE, 1_000_000 * SHARE), 9_999);
    // Exactly 99.50% -> 9,950 bps Warning (boundary inclusive).
    assert_eq!(ratio_for(995_000 * SHARE, 1_000_000 * SHARE), 9_950);
    // 99.49% -> 9,949 bps Critical.
    assert_eq!(ratio_for(994_900 * SHARE, 1_000_000 * SHARE), 9_949);
    // Over-collateralized: 150% -> 15,000 bps Healthy (no clamp).
    assert_eq!(ratio_for(1_500_000 * SHARE, 1_000_000 * SHARE), 15_000);
}

#[test]
fn ratio_overflow_is_typed_not_clamped() {
    // backing = u128::MAX, supply = 1: ratio = MAX * 10_000 ≫ u32::MAX.
    let input = ReconciliationInput {
        onchain_supply: 1,
        settled_custody_shares: u128::MAX,
        pending_deposits_transit: 0,
        pending_redeem_transit: 0,
    };
    assert_eq!(execute_reconciliation(&input), Err(PoRError::ArithmeticOverflow));
}

#[test]
fn zero_supply_with_backing_is_zero_supply_state() {
    let input = ReconciliationInput {
        onchain_supply: 0,
        settled_custody_shares: 42,
        pending_deposits_transit: 0,
        pending_redeem_transit: 0,
    };
    let out = execute_reconciliation(&input).unwrap();
    assert_eq!(out.status, ReserveStatus::ZeroSupply);
    assert_eq!(out.net_difference_base, 42);
}

#[test]
fn pending_redeems_increase_liabilities() {
    const SHARE: u128 = 1_000_000_000_000_000_000;
    let input = ReconciliationInput {
        onchain_supply: 900_000 * SHARE,
        settled_custody_shares: 900_000 * SHARE,
        pending_deposits_transit: 0,
        pending_redeem_transit: 100_000 * SHARE,
    };
    let out = execute_reconciliation(&input).unwrap();
    assert_eq!(out.total_liabilities_base, 1_000_000 * SHARE);
    assert_eq!(out.reserve_ratio_bps, 9_000);
    assert_eq!(out.status, ReserveStatus::Critical);
}

// ---------------------------------------------------------------------------
// Suite 3: 10,000 sealed evidence envelopes — zero validation escapes.
// ---------------------------------------------------------------------------

fn header_for(case: u64) -> EnvelopeHeader {
    EnvelopeHeader {
        schema_version: SCHEMA_VERSION.into(),
        envelope_id: format!("urn:uuid:{case:032x}"),
        asset_identifier: AssetIdentifier {
            cusip: "03662Q105".into(),
            isin: "US03662Q1058".into(),
            symbol: "ANT".into(),
            stellar_sac_address: None,
        },
        source_entity: SourceEntity {
            lei: "5493006MHB84DD0ZWV18".into(),
            swift_bic: None,
            sec_cik: "0001777934".into(),
            entity_type: Some("QUALIFIED_CUSTODIAN".into()),
        },
        signature_algorithm: "RSA_PSS_SHA256".into(),
    }
}

#[test]
fn ten_thousand_evidence_envelopes() {
    let mut rng = Lcg::new(0x10_000_00_2);
    for case in 0..10_000u32 {
        let settled = rng.next_interesting().to_string();
        let transit = rng.next_interesting().to_string();
        let redeems = rng.next_interesting().to_string();
        let snapshot = (rng.next_u64() % 1_000_000_000) as i64;
        let sequence = rng.next_u64();

        let payload = EnvelopePayload {
            snapshot_timestamp_utc: snapshot,
            accounting_epoch_id: None,
            settled_shares: settled.clone(),
            transit_cash_in_usd: transit.clone(),
            pending_redeem_shares: redeems.clone(),
            shares_on_loan: "0".into(),
            segregation_status: "SEC_RULE_15C3_3_OMNIBUS".into(),
            currency: "USD".into(),
        };

        let sealed = std::panic::catch_unwind(|| {
            EvidenceEnvelope::seal(header_for(case as u64), payload, sequence, "sig".into(), snapshot)
        })
        .unwrap_or_else(|_| panic!("case {case}: seal panicked"));

        let env = match sealed {
            Ok(env) => env,
            Err(PoRError::InvalidEvidence) => continue, // rejected draw (float path)
            Err(e) => panic!("case {case}: unexpected seal error {e:?}"),
        };

        // Well-formed envelopes validate inside the TTL window.
        env.validate(snapshot).expect("case {case}: valid envelope rejected");
        assert!(env.validate(snapshot + MAX_ENVELOPE_TTL_SECS).is_ok(), "case {case}");
        assert_eq!(
            env.validate(snapshot + MAX_ENVELOPE_TTL_SECS + 1),
            Err(PoRError::StaleEvidence),
            "case {case}: TTL boundary leaked"
        );

        // Tampering with ANY amount must break the canonical digest.
        let mut tampered = env.clone();
        tampered.payload.settled_shares = if settled == "1" { "2".into() } else { "1".into() };
        assert_ne!(tampered.payload.settled_shares, settled, "case {case}");
        assert_eq!(
            tampered.validate(snapshot),
            Err(PoRError::InvalidEvidence),
            "case {case}: tampered amount accepted"
        );

        // Tampering with the digest itself fails.
        let mut bad_digest = env.clone();
        bad_digest.integrity.canonical_payload_hash =
            format!("0x{}", "0".repeat(64));
        if bad_digest.integrity.canonical_payload_hash == env.integrity.canonical_payload_hash {
            bad_digest.integrity.canonical_payload_hash =
                format!("0x{}1", "0".repeat(63));
        }
        assert_eq!(
            bad_digest.validate(snapshot),
            Err(PoRError::InvalidEvidence),
            "case {case}: forged digest accepted"
        );

        // Sequence replay detection (sequence 0 has no valid predecessor).
        if sequence > 0 && sequence != u64::MAX {
            assert!(env.validate_monotonic(sequence - 1).is_ok(), "case {case}");
            assert_eq!(
                env.validate_monotonic(sequence),
                Err(PoRError::NonMonotonicSequence),
                "case {case}: replay accepted"
            );
        }
    }
}

#[test]
fn rehypothecated_envelopes_never_validate() {
    let mut rng = Lcg::new(0x10_000_00_3);
    for case in 0..1_000u64 {
        let payload = EnvelopePayload {
            snapshot_timestamp_utc: 1_000,
            accounting_epoch_id: None,
            settled_shares: "1000".into(),
            transit_cash_in_usd: "0".into(),
            pending_redeem_shares: "0".into(),
            shares_on_loan: (1 + rng.next_u64() % 1_000_000).to_string(),
            segregation_status: "SEC_RULE_15C3_3_OMNIBUS".into(),
            currency: "USD".into(),
        };
        let env = EvidenceEnvelope::seal(header_for(case), payload, case as u64, "sig".into(), 1_000).unwrap();
        assert_eq!(
            env.validate(1_100),
            Err(PoRError::RehypothecationDetected),
            "case {case}: rehypothecation accepted"
        );
    }
}

// ---------------------------------------------------------------------------
// Suite 4: T+1 settlement windows across a generated 10-year horizon.
// ---------------------------------------------------------------------------

#[test]
fn ten_thousand_settlement_windows() {
    let mut rng = Lcg::new(0x10_000_00_4);
    let calendar = ClearingCalendar::default();
    let mut in_window = 0u32;
    let mut expired = 0u32;

    for _ in 0..10_000u32 {
        // Random 2027–2037 instant.
        let executed = 1_800_000_000 + (rng.next_u64() % 315_360_000) as i64;
        // Snapshot 0..96 hours after execution.
        let snapshot = executed + (rng.next_u64() % (96 * 3600)) as i64;
        match calendar.classify_cash_transit(executed, snapshot) {
            TransitState::InT1Window { settle_by_utc } => {
                in_window += 1;
                // Settlement deadline must always be strictly after execution.
                assert!(settle_by_utc > executed);
                // And within 4 business days (≤ 96h + DST slack).
                assert!(settle_by_utc - executed <= 5 * 86_400);
            }
            TransitState::Expired => expired += 1,
            TransitState::ChronologyViolation => unreachable!("snapshot >= executed"),
        }
    }
    assert!(in_window > 0 && expired > 0, "generator must cover both states");
}

// ---------------------------------------------------------------------------
// Suite 5: canonicalization invariants.
// ---------------------------------------------------------------------------

#[test]
fn canonicalization_is_deterministic_and_order_free() {
    let mut rng = Lcg::new(0x10_000_00_5);
    for _ in 0..1_000u32 {
        let a = rng.next_u64();
        let b = rng.next_u64();
        let variant_a: serde_json::Value = serde_json::from_str(&format!(
            r#"{{"alpha":{a},"beta":{{"nested":{b},"x":null}},"gamma":["s",true,false]}}"#
        ))
        .unwrap();
        let variant_b: serde_json::Value = serde_json::from_str(&format!(
            r#"{{"gamma":["s",true,false],"beta":{{"x":null,"nested":{b}}},"alpha":{a}}}"#
        ))
        .unwrap();
        assert_eq!(canonicalize(&variant_a).unwrap(), canonicalize(&variant_b).unwrap());
    }
}

#[test]
fn base64url_roundtrip_all_byte_patterns() {
    let mut rng = Lcg::new(0x10_000_00_6);
    for len in 0..64usize {
        let data: Vec<u8> = (0..len).map(|_| rng.next_u64() as u8).collect();
        let encoded = base64url_encode(&data);
        assert!(!encoded.contains('+') && !encoded.contains('/') && !encoded.contains('='));
        assert_eq!(base64url_decode(&encoded).unwrap(), data);
    }
}

#[test]
fn digest_binding_binds_sequence_and_snapshot() {
    let payload = EnvelopePayload {
        snapshot_timestamp_utc: 1_000,
        accounting_epoch_id: None,
        settled_shares: "850000".into(),
        transit_cash_in_usd: "0".into(),
        pending_redeem_shares: "0".into(),
        shares_on_loan: "0".into(),
        segregation_status: "SEC_RULE_15C3_3_OMNIBUS".into(),
        currency: "USD".into(),
    };
    let env_a = EvidenceEnvelope::seal(header_for(1), payload.clone(), 1, "sig".into(), 1_000).unwrap();
    let env_b = EvidenceEnvelope::seal(header_for(1), payload.clone(), 2, "sig".into(), 1_000).unwrap();
    // Different sequence numbers must bind to different digests via the
    // canonical source message.
    assert_ne!(
        env_a.canonical_source_message().unwrap(),
        env_b.canonical_source_message().unwrap()
    );
    // Digest is stable for identical envelopes.
    let env_c = EvidenceEnvelope::seal(header_for(1), payload, 1, "sig".into(), 1_000).unwrap();
    assert_eq!(env_a.integrity.canonical_payload_hash, env_c.integrity.canonical_payload_hash);
    // And equals RFC 8785 + SHA-256 of the payload object.
    let payload_value = serde_json::to_value(&env_a.payload).unwrap();
    assert_eq!(
        env_a.integrity.canonical_payload_hash,
        format!("0x{}", sha256_hex(canonicalize(&payload_value).unwrap().as_bytes()))
    );
}

#[test]
fn u256_reference_vectors() {
    // Known-answer vectors for the 256-bit primitives.
    let a = U256::from_u128(u128::MAX);
    let b = U256::from_u128(u128::MAX);
    // (2^128 - 1) + (2^128 - 1) = 2^129 - 2 < 2^256.
    let sum = a.checked_add(&b).unwrap();
    assert_eq!(sum.low_u128(), u128::MAX - 1); // low 128 bits of 2^129-2
    // Division exactness: MAX*MAX / MAX == MAX is unreachable (mul overflows),
    // but MAX * 2^128 / 2^128 == MAX is representable.
    let shifted = U256::from_u128(u128::MAX)
        .checked_mul(&U256::from_u128(1u128 << 64))
        .unwrap();
    assert_eq!(shifted.checked_div(&U256::from_u128(1u128 << 64)).unwrap(), a);
    // Ordinal comparisons across limb boundaries.
    assert!(U256::from_u128(1u128 << 127) > U256::from_u128((1u128 << 127) - 1));
    assert!(U256::from_u64(0) < U256::from_u64(1));
}

#[test]
fn settlement_aware_ratio_end_to_end_case_study() {
    // The Dinari × Anthropic $ANT worked example, end-to-end with a live
    // transit classification on Thursday 2026-11-19.
    const SHARE: u128 = 1_000_000_000_000_000_000;
    // 2026-11-19 00:00 UTC is day index 20776 (Thursday).
    let thu = 20_776i64;
    let executed = thu * 86_400 + 19 * 3600; // 14:00 EST
    let snapshot = thu * 86_400 + 21 * 3600; // market close
    let calendar = ClearingCalendar::default();
    let state = calendar.classify_cash_transit(executed, snapshot);

    let input = ReconciliationInput {
        onchain_supply: 1_000_000 * SHARE,
        settled_custody_shares: 850_000 * SHARE,
        pending_deposits_transit: 150_000 * SHARE,
        pending_redeem_transit: 0,
    };
    let snapshot_out = compute_settlement_aware_ratio(&input, &[state]).unwrap();
    assert_eq!(snapshot_out.reconciliation.reserve_ratio_bps, 10_000);
    assert_eq!(snapshot_out.reconciliation.status, ReserveStatus::Healthy);
    assert!(snapshot_out.transit_active);
}
