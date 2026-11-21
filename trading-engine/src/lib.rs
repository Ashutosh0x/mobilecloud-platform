//! FurlPay × MobileCloud Edge Trading Engine.
//!
//! Executes the three alpha vectors from
//! `FURLPAY_MOBILECLOUD_EXECUTION_AND_BLOCKCHAIN_TRADING_STRATEGY_2026.md` on
//! bare-metal Android ARM64 silicon (1.97W, 0ms battery UPS):
//!
//! 1. [`solana_arbitrage_engine`] — Cross-DEX/CLOB atomic arbitrage with
//!    Jito MEV bundles (atomic revert = zero inventory risk).
//! 2. [`edge_runtime_daemon`] — Hardware supervisor: SoC thermals via sysfs,
//!    USB-PD PPS bypass-charging verification, sustained-trading governance.
//! 3. [`soroban_circuit_breaker`] — Reserve-ratio monitoring against the
//!    99.50% institutional floor with emergency Soroban halt dispatch.
//!
//! The four non-negotiable risk invariants (spec §5) are encoded as checked
//! gates in [`risk_invariants`] and every execution path must pass all four.

pub mod edge_runtime_daemon;
pub mod risk_invariants;
pub mod soroban_circuit_breaker;

// Solana wire-format module requires `--features solana` (see Cargo.toml).
#[cfg(feature = "solana")]
pub mod solana_arbitrage_engine;
