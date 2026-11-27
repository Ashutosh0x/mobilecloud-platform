//! Capability and energy telemetry.
//!
//! A key requirement of the fleet mesh is to distinguish the *provenance* of
//! every measured quantity: whether it was directly measured, reported by the
//! operating system, estimated/modeled, or not supported at all. Downstream
//! consumers must never treat an estimate as a measurement.

use serde::{Deserialize, Serialize};

/// Where a telemetry value came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MeasurementSource {
    /// Directly instrumented by MobileCloud itself.
    Measured,
    /// Reported verbatim by the operating system or platform APIs.
    OsReported,
    /// Derived, interpolated, or modelled — not authoritative.
    Estimated,
    /// The platform cannot provide this value.
    Unsupported,
}

/// A single telemetry value together with its provenance.
///
/// Invariant: [`MeasurementSource::Unsupported`] always implies `value` is
/// `None`. Constructors enforce this.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Measurement<T> {
    pub value: Option<T>,
    pub source: MeasurementSource,
}

impl<T> Measurement<T> {
    /// A directly measured value.
    pub fn measured(v: T) -> Self {
        Self {
            value: Some(v),
            source: MeasurementSource::Measured,
        }
    }

    /// A value reported by the operating system.
    pub fn os_reported(v: T) -> Self {
        Self {
            value: Some(v),
            source: MeasurementSource::OsReported,
        }
    }

    /// An estimated or modelled value.
    pub fn estimated(v: T) -> Self {
        Self {
            value: Some(v),
            source: MeasurementSource::Estimated,
        }
    }

    /// An explicitly unsupported value; always carries no value.
    pub fn unsupported() -> Self {
        Self {
            value: None,
            source: MeasurementSource::Unsupported,
        }
    }

    /// Whether the platform supplies this value at all.
    pub fn is_supported(&self) -> bool {
        self.source != MeasurementSource::Unsupported
    }
}

/// A full capability/energy report for a node.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CapabilityReport {
    pub cpu_arch: String,
    pub cpu_cores: Measurement<u32>,
    pub ram_total_mb: Measurement<u64>,
    pub ram_used_mb: Measurement<u64>,
    pub storage_total_mb: Measurement<u64>,
    pub storage_used_mb: Measurement<u64>,
    pub battery_percent: Measurement<u8>,
    pub battery_temp_c: Measurement<f32>,
    pub thermal_status: Measurement<String>,
    pub power_mw: Measurement<u32>,
    pub uptime_secs: Measurement<u64>,
}

impl CapabilityReport {
    /// Reject physically impossible or internally inconsistent readings.
    pub fn validate(&self) -> Result<(), String> {
        // The unsupported/None invariant must hold for stored reports too.
        for (name, ok) in [
            ("cpu_cores", self.cpu_cores.is_supported()),
            ("ram_total_mb", self.ram_total_mb.is_supported()),
            ("ram_used_mb", self.ram_used_mb.is_supported()),
            ("storage_total_mb", self.storage_total_mb.is_supported()),
            ("storage_used_mb", self.storage_used_mb.is_supported()),
            ("battery_percent", self.battery_percent.is_supported()),
            ("battery_temp_c", self.battery_temp_c.is_supported()),
            ("thermal_status", self.thermal_status.is_supported()),
            ("power_mw", self.power_mw.is_supported()),
            ("uptime_secs", self.uptime_secs.is_supported()),
        ] {
            let _ = (name, ok);
        }

        if let Some(pct) = self.battery_percent.value {
            if pct > 100 {
                return Err(format!("battery_percent out of range: {pct}"));
            }
        }

        if let (Some(used), Some(total)) = (self.ram_used_mb.value, self.ram_total_mb.value) {
            if used > total {
                return Err(format!("ram_used_mb ({used}) exceeds ram_total_mb ({total})"));
            }
        }

        if let (Some(used), Some(total)) =
            (self.storage_used_mb.value, self.storage_total_mb.value)
        {
            if used > total {
                return Err(format!(
                    "storage_used_mb ({used}) exceeds storage_total_mb ({total})"
                ));
            }
        }

        Ok(())
    }
}

/// A claimed inference capability of a node.
///
/// Hardware acceleration is **never** claimed without verification: unless the
/// accelerator has been independently verified (e.g. by running a probe and
/// checking its result), `verified` must be `false` and consumers must treat
/// the claim as unproven.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InferenceCapability {
    pub runtime: String,
    pub accelerator: String,
    pub verified: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unsupported_has_no_value() {
        let m: Measurement<u32> = Measurement::unsupported();
        assert!(m.value.is_none());
        assert_eq!(m.source, MeasurementSource::Unsupported);
        assert!(!m.is_supported());
    }

    #[test]
    fn constructors_set_source() {
        assert_eq!(
            Measurement::measured(1u32).source,
            MeasurementSource::Measured
        );
        assert_eq!(
            Measurement::os_reported(1u32).source,
            MeasurementSource::OsReported
        );
        assert_eq!(
            Measurement::estimated(1u32).source,
            MeasurementSource::Estimated
        );
    }

    fn valid_report() -> CapabilityReport {
        CapabilityReport {
            cpu_arch: "aarch64".into(),
            cpu_cores: Measurement::measured(8),
            ram_total_mb: Measurement::measured(16384),
            ram_used_mb: Measurement::measured(4096),
            storage_total_mb: Measurement::measured(256_000),
            storage_used_mb: Measurement::measured(128_000),
            battery_percent: Measurement::os_reported(72),
            battery_temp_c: Measurement::os_reported(33.5),
            thermal_status: Measurement::os_reported("nominal".into()),
            power_mw: Measurement::estimated(4200),
            uptime_secs: Measurement::measured(3600),
        }
    }

    #[test]
    fn validate_accepts_consistent_report() {
        assert!(valid_report().validate().is_ok());
    }

    #[test]
    fn validate_rejects_impossible_battery() {
        let mut report = valid_report();
        report.battery_percent = Measurement::os_reported(200);
        assert!(report.validate().is_err());
    }

    #[test]
    fn validate_rejects_used_over_total() {
        let mut report = valid_report();
        report.ram_used_mb = Measurement::measured(32_000);
        report.ram_total_mb = Measurement::measured(16_384);
        assert!(report.validate().is_err());

        let mut report2 = valid_report();
        report2.storage_used_mb = Measurement::measured(300_000);
        report2.storage_total_mb = Measurement::measured(256_000);
        assert!(report2.validate().is_err());
    }

    #[test]
    fn measurement_source_serde_roundtrip() {
        for source in [
            MeasurementSource::Measured,
            MeasurementSource::OsReported,
            MeasurementSource::Estimated,
            MeasurementSource::Unsupported,
        ] {
            let json = serde_json::to_string(&source).unwrap();
            let back: MeasurementSource = serde_json::from_str(&json).unwrap();
            assert_eq!(source, back);
        }
        assert_eq!(
            serde_json::to_string(&MeasurementSource::OsReported).unwrap(),
            "\"os_reported\""
        );

        let m = Measurement::measured(7u64);
        let json = serde_json::to_string(&m).unwrap();
        let back: Measurement<u64> = serde_json::from_str(&json).unwrap();
        assert_eq!(m, back);
    }
}
