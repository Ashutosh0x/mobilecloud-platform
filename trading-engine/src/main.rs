//! `mobilecloud-trading` — headless edge trading daemon entrypoint.
//!
//! Boots the hardware supervisor, wires the market-data pipelines, and
//! enters the arbitration loop. Phase-1 default is PAPER mode (no live
//! capital) per the execution roadmap (trading spec §6).

use por_kernel::U256;
use trading_engine::edge_runtime_daemon::AndroidThermalSupervisor;
use trading_engine::risk_invariants::{evaluate_trade, RiskDecision};
use trading_engine::soroban_circuit_breaker::{ReserveVerificationEvent, SorobanCircuitBreaker, U256Serde};

#[cfg(feature = "solana")]
use trading_engine::solana_arbitrage_engine::{ArbitrageEngine, PoolQuote};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,trading_engine=debug".into()),
        )
        .init();

    tracing::info!("MobileCloud edge trading daemon starting (PAPER MODE — no live capital)");

    // 1. Hardware supervisor: thermals + bypass-charging verification.
    let supervisor = AndroidThermalSupervisor::new();
    tokio::spawn(async move {
        supervisor.run_supervisor_loop().await;
    });

    // 2. Soroban circuit breaker on the institutional reserve feed.
    let breaker = SorobanCircuitBreaker::new("CA7N3K2EXAMPLE");
    let tick = ReserveVerificationEvent {
        asset_symbol: "ANT".into(),
        issuer_id: "backpack-securities".into(),
        total_token_supply: U256Serde(U256::from_u128(1_000_000_000_000_000_000_000_000)),
        verified_dtc_reserves: U256Serde(U256::from_u128(1_000_000_000_000_000_000_000_000)),
        coverage_ratio_bps: 10_000,
        timestamp_utc: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
    };
    tracing::info!("{}", breaker.process_oracle_tick(&tick));

    // 3. Arbitration evaluation loop skeleton (paper mode): quotes arrive
    //    from the Geyser/CLOB ingest pipelines; every candidate passes the
    //    four risk invariants before any bundle is built. The Solana wire
    //    format compiles under `--features solana`.
    #[cfg(feature = "solana")]
    demo_arbitrage_paper_mode();

    tracing::info!("daemon idle — connect live Geyser/CLOB feeds to enter the execution loop");
    Ok(())
}

/// Paper-mode walk-through of the ANT/USDC worked example (trading spec §1.1).
#[cfg(feature = "solana")]
fn demo_arbitrage_paper_mode() {
    use std::sync::Arc;

    let payer = Arc::new(solana_sdk::signature::Keypair::new()); // PAPER key
    let engine = ArbitrageEngine::new(payer, 0.012, 0.001); // 12 bps min net

    let clob = PoolQuote {
        venue_name: "Backpack CLOB".into(),
        ant_bid_price: 88_400_000,
        ant_ask_price: 88_400_000,
        available_liquidity_ant: 50_000,
    };
    let amm = PoolQuote {
        venue_name: "Raydium CPMM".into(),
        ant_bid_price: 89_500_000,
        ant_ask_price: 89_600_000,
        available_liquidity_ant: 25_000,
    };

    if let Some(opp) = engine.evaluate_arbitrage(&clob, &amm, 2_000) {
        let decision = evaluate_trade(
            (opp.trade_size_ant as u64 * clob.ant_ask_price as u64) / 1_000_000,
            50_000 * 1_000_000, // $50k paper equity (roadmap Phase 3)
            0,
            10_000 * 1_000_000,
            8,
            true, // Jito bundle = atomic
        );
        match decision {
            RiskDecision::Permit => {
                tracing::info!(
                    "arbitrage permitted: buy {} → sell {}, net {} micro-USDC (spread {} / fees {})",
                    opp.buy_venue,
                    opp.sell_venue,
                    opp.net_profit_micro_usdc,
                    opp.gross_spread_per_share,
                    opp.estimated_fees_micro_usdc
                );
                // Paper mode: bundle is logged, not submitted.
            }
            RiskDecision::Reject { violations } => {
                tracing::error!("arbitrage rejected: {violations:?}");
            }
        }
    }
}
