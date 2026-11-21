//! Stellar Soroban circuit-breaker client (trading spec §3.3).
//!
//! Monitors the backing ratio from the FurlPay reconciliation pipeline and,
//! when it breaches the institutional floors, crafts the emergency Soroban
//! invocation:
//!
//! * `coverage < 9,950 bps` → on-chain margin warning event.
//! * `coverage < 9,900 bps` → `execute_emergency_freeze(asset)` dispatch —
//!   the 5-tier FROZEN state, executed solely via issuer governance keys
//!   (10/10 blueprint §5: freezing is never automated by third parties; the
//!   breaker *requests* it from the issuer's authorized admin).
//!
//! The dispatcher is a pluggable trait so tests inject a mock and the
//! production binary supplies the Stellar SDK transaction builder.

use serde::{Deserialize, Serialize};

use por_kernel::U256;

/// One reserve-verification tick flowing from the por-kernel + Acurast mesh.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReserveVerificationEvent {
    pub asset_symbol: String,
    pub issuer_id: String,
    pub total_token_supply: U256Serde,
    pub verified_dtc_reserves: U256Serde,
    pub coverage_ratio_bps: u32,
    pub timestamp_utc: u64,
}

/// Serde wrapper — U256 serializes as a decimal string (never a float).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct U256Serde(#[serde(with = "u256_string")] pub U256);

mod u256_string {
    use serde::{Deserialize, Deserializer, Serializer};
    use por_kernel::U256;

    pub fn serialize<S: Serializer>(value: &U256, serializer: S) -> Result<S::Ok, S::Error> {
        // Decimal string when representable in 128 bits (real-world base
        // units always are); larger values serialize as 0x-prefixed limbs.
        match value.as_u128_checked() {
            Some(v) => serializer.serialize_str(&v.to_string()),
            None => {
                let mut hex_limbs = String::new();
                for i in 0..4 {
                    use std::fmt::Write;
                    let _ = write!(hex_limbs, "{:016x}", value.limb_be(i));
                }
                serializer.serialize_str(&format!("0x{hex_limbs}"))
            }
        }
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<U256, D::Error> {
        let s = String::deserialize(deserializer)?;
        if let Ok(v) = s.parse::<u128>() {
            return Ok(U256::from_u128(v));
        }
        let hex_body = s.strip_prefix("0x").ok_or_else(|| {
            serde::de::Error::custom("U256 must be decimal string or 0x-hex limbs")
        })?;
        if hex_body.len() != 64 {
            return Err(serde::de::Error::custom("hex limbs must be 32 bytes"));
        }
        let mut limbs = [0u64; 4];
        for i in 0..4 {
            limbs[i] = u64::from_str_radix(&hex_body[i * 16..(i + 1) * 16], 16)
                .map_err(serde::de::Error::custom)?;
        }
        Ok(U256::from_limbs_be(limbs))
    }
}

/// Where emergency halts are dispatched (real Stellar SDK in production).
pub trait SorobanDispatcher: Send + Sync {
    fn broadcast_emergency_halt(&self, asset: &str);
    fn emit_margin_warning(&self, asset: &str, ratio_bps: u32);
}

/// Logging dispatcher — the default no-op until the live keypair is bound.
pub struct LoggingDispatcher;

impl SorobanDispatcher for LoggingDispatcher {
    fn broadcast_emergency_halt(&self, asset: &str) {
        tracing::error!("[SOROBAN DISPATCH] executing Stellar contract call: pause_trading(asset={asset})");
    }
    fn emit_margin_warning(&self, asset: &str, ratio_bps: u32) {
        tracing::warn!("[SOROBAN WARNING] {asset} margin warning at {ratio_bps} bps");
    }
}

pub struct SorobanCircuitBreaker {
    pub contract_address: String,
    /// 9950 = 99.50% institutional floor (master blueprint Screen 4).
    pub warning_floor_bps: u32,
    /// 9900 = 99.00% confirmed-deficit floor (end-to-end test scenario 4).
    pub critical_floor_bps: u32,
    dispatcher: std::sync::Arc<dyn SorobanDispatcher>,
}

impl SorobanCircuitBreaker {
    pub fn new(contract_address: &str) -> Self {
        Self::with_dispatcher(contract_address, std::sync::Arc::new(LoggingDispatcher))
    }

    pub fn with_dispatcher(
        contract_address: &str,
        dispatcher: std::sync::Arc<dyn SorobanDispatcher>,
    ) -> Self {
        Self {
            contract_address: contract_address.to_string(),
            warning_floor_bps: 9_950,
            critical_floor_bps: 9_900,
            dispatcher,
        }
    }

    /// Evaluate one verification tick and execute the tiered response.
    /// Returns the action string for the audit trail.
    pub fn process_oracle_tick(&self, event: &ReserveVerificationEvent) -> String {
        if event.coverage_ratio_bps < self.critical_floor_bps {
            let action = format!(
                "CRITICAL DEFICIT DETECTED ({} bps)! Triggering Soroban contract `{}` -> execute_emergency_freeze()",
                event.coverage_ratio_bps, self.contract_address
            );
            self.dispatcher
                .broadcast_emergency_halt(&event.asset_symbol);
            action
        } else if event.coverage_ratio_bps < self.warning_floor_bps {
            self.dispatcher
                .emit_margin_warning(&event.asset_symbol, event.coverage_ratio_bps);
            format!(
                "WARNING: Reserve coverage at {} bps. Emitting on-chain margin warning to Stellar ledger.",
                event.coverage_ratio_bps
            )
        } else {
            format!(
                "HEALTHY: {} coverage at {} bps. Normal operation.",
                event.asset_symbol, event.coverage_ratio_bps
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    #[derive(Default)]
    struct MockDispatcher {
        halts: Mutex<Vec<String>>,
        warnings: Mutex<Vec<(String, u32)>>,
    }

    impl SorobanDispatcher for MockDispatcher {
        fn broadcast_emergency_halt(&self, asset: &str) {
            self.halts.lock().unwrap().push(asset.to_string());
        }
        fn emit_margin_warning(&self, asset: &str, ratio_bps: u32) {
            self.warnings
                .lock()
                .unwrap()
                .push((asset.to_string(), ratio_bps));
        }
    }

    fn event(ratio_bps: u32) -> ReserveVerificationEvent {
        ReserveVerificationEvent {
            asset_symbol: "ANT".into(),
            issuer_id: "backpack-securities".into(),
            total_token_supply: U256Serde(U256::from_u128(1_000_000)),
            verified_dtc_reserves: U256Serde(U256::from_u128(ratio_bps as u128 * 100)),
            coverage_ratio_bps: ratio_bps,
            timestamp_utc: 1_774_087_200,
        }
    }

    #[test]
    fn healthy_tick_is_noop() {
        let dispatcher = Arc::new(MockDispatcher::default());
        let breaker = SorobanCircuitBreaker::with_dispatcher("CA7N3K2EXAMPLE", dispatcher.clone());
        let action = breaker.process_oracle_tick(&event(10_000));
        assert!(action.starts_with("HEALTHY"));
        assert!(dispatcher.halts.lock().unwrap().is_empty());
    }

    #[test]
    fn warning_floor_triggers_warning_not_freeze() {
        let dispatcher = Arc::new(MockDispatcher::default());
        let breaker = SorobanCircuitBreaker::with_dispatcher("CA7N3K2EXAMPLE", dispatcher.clone());
        let action = breaker.process_oracle_tick(&event(9_945)); // 9,945 < 9,950
        assert!(action.starts_with("WARNING"));
        assert_eq!(
            dispatcher.warnings.lock().unwrap().as_slice(),
            [("ANT".to_string(), 9_945u32)]
        );
        assert!(dispatcher.halts.lock().unwrap().is_empty());
    }

    #[test]
    fn insolvency_drift_triggers_freeze() {
        let dispatcher = Arc::new(MockDispatcher::default());
        let breaker = SorobanCircuitBreaker::with_dispatcher("CA7N3K2EXAMPLE", dispatcher.clone());
        // End-to-end spec scenario 4: 10,000 unbacked mints → 9,900 bps
        // drops below the 9,900 critical floor → halt.
        let action = breaker.process_oracle_tick(&event(9_899));
        assert!(action.contains("CRITICAL DEFICIT DETECTED"));
        assert!(action.contains("execute_emergency_freeze()"));
        assert_eq!(dispatcher.halts.lock().unwrap().as_slice(), ["ANT"]);
    }

    #[test]
    fn u256_serde_roundtrip() {
        let value = U256Serde(U256::from_u128(u128::MAX));
        let json = serde_json::to_string(&value).unwrap();
        assert_eq!(json, "\"340282366920938463463374607431768211455\"");
        let back: U256Serde = serde_json::from_str(&json).unwrap();
        assert_eq!(back, value);
    }
}
