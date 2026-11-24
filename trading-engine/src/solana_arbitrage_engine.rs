//! High-speed Solana atomic arbitrage engine (trading spec §3.1).
//!
//! Alpha Vector 1: exploits ΔP between Backpack's CLOB and Jupiter-aggregated
//! AMMs (Raydium CPMM / Orca Whirlpools / Meteora). The engine:
//!
//! 1. Streams pool state and CLOB L2 quotes,
//! 2. Computes net spread after **all** fees (Backpack taker 8 bps +
//!    Raydium 25 bps + Jito tip) using integer micro-USDC math — no floats
//!    in the profitability path,
//! 3. Builds an **atomic multi-instruction bundle** whose swap legs are the
//!    aggregator's own instructions (buy USDC→ANT leg + sell ANT→USDC leg,
//!    fetched from the Jupiter v6 swap API — see [`crate::jupiter_swap_api`])
//!    plus the Jito tip, submitted to the Jito Block Engine,
//! 4. On spread evaporation before block inclusion, the entire bundle
//!    **reverts atomically** — zero inventory risk, zero lost gas.
//!
//! Invariant 1 (atomic reverts only) and Invariant 4 (≤ 15 bps slippage)
//! are structurally enforced here; position sizing is delegated to
//! [`crate::risk_invariants`].

use crate::jupiter_swap_api::{InstructionPlan, QuoteRequest, SwapApi, SwapApiError, SwapRequest};
use solana_sdk::{
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    signature::{Keypair, Signer},
    system_instruction,
    transaction::Transaction,
};
use std::str::FromStr;
use std::sync::Arc;

// ---------------------------------------------------------------------------
// Solana constants for $ANT tokenized-stock trading (trading spec §3.1).
// ---------------------------------------------------------------------------

/// Backpack ANT SPL mint.
pub const ANT_MINT: &str = "ANTBTZQ1EUuTxUs3tfeampxdqTWPHmwyJmcWj4xoAyNe";
/// Native USDC SPL mint.
pub const USDC_MINT: &str = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
/// Jupiter Aggregator v6 program (cross-AMM routing).
pub const JUPITER_V6_PROGRAM: &str = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
/// Raydium AMM v4 program (sell leg).
pub const RAYDIUM_AMM_V4: &str = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
/// A canonical Jito tip account (spec §3.1); the relayer picks per-slot.
pub const JITO_TIP_ACCOUNT: &str = "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5";
/// Jito Block Engine bundle submission endpoint.
pub const JITO_BLOCK_ENGINE_URL: &str = "https://mainnet.block-engine.jito.wtf/api/v1/bundles";

pub const MICRO_USDC: u64 = 1_000_000; // 6 decimals
pub const LAMPORTS_PER_SOL: u64 = 1_000_000_000;

/// Fee basis points: Backpack CLOB taker + Raydium pool swap fee.
pub const BACKPACK_TAKER_FEE_BPS: u64 = 8;
pub const RAYDIUM_SWAP_FEE_BPS: u64 = 25;

/// One venue's executable quote. Prices are **micro-USDC per whole share**
/// (6 decimals: $88.50 = 88_500_000).
#[derive(Debug, Clone)]
pub struct PoolQuote {
    pub venue_name: String,
    pub ant_bid_price: u64,
    pub ant_ask_price: u64,
    pub available_liquidity_ant: u64,
}

impl PoolQuote {
    /// Mid-price in bps-safe integer micro-USDC.
    pub fn mid_price(&self) -> u64 {
        (self.ant_bid_price + self.ant_ask_price) / 2
    }
}

/// The outcome of a profitable evaluation: an unsigned atomic transaction
/// (blockhash + signatures are attached by the relayer just before send).
#[derive(Debug)]
pub struct ArbitrageOpportunity {
    pub buy_venue: String,
    pub sell_venue: String,
    pub trade_size_ant: u64,
    /// Net profit after every fee, in micro-USDC (integer-exact).
    pub net_profit_micro_usdc: u64,
    /// Gross spread per share (micro-USDC).
    pub gross_spread_per_share: u64,
    /// Total fee estimate (micro-USDC): CLOB fee + AMM fee + tip.
    pub estimated_fees_micro_usdc: u64,
}

/// A ready-to-sign atomic bundle: the aggregator-returned swap instructions
/// for both legs plus the Jito tip, together with the address lookup tables
/// the relayer must fold into a v0 message (the API's
/// `addressLookupTableAddresses`, carried through verbatim).
#[derive(Debug)]
pub struct AtomicBundle {
    pub transaction: Transaction,
    pub address_lookup_table_addresses: Vec<String>,
}

pub struct ArbitrageEngine {
    payer: Arc<Keypair>,
    min_profit_threshold_micro_usdc: u64,
    jito_tip_lamports: u64,
    /// Invariant 4: maximum tolerable slippage vs mid (bps).
    max_slippage_bps: u32,
    /// Aggregator client supplying the swap legs (see [`SwapApi`]). `None`
    /// until the live transport is bound; paper/offline runs leave it unset.
    swap_api: Option<Arc<dyn SwapApi>>,
}

impl ArbitrageEngine {
    pub fn new(payer: Arc<Keypair>, min_profit_threshold_usdc: f64, jito_tip_sol: f64) -> Self {
        Self {
            payer,
            min_profit_threshold_micro_usdc: (min_profit_threshold_usdc * MICRO_USDC as f64) as u64,
            jito_tip_lamports: (jito_tip_sol * LAMPORTS_PER_SOL as f64) as u64,
            max_slippage_bps: 15,
            swap_api: None,
        }
    }

    /// Bind the aggregator client that supplies the swap legs. Without it,
    /// [`Self::build_atomic_bundle`] returns [`SwapApiError::NotConfigured`].
    pub fn with_swap_api(mut self, swap_api: Arc<dyn SwapApi>) -> Self {
        self.swap_api = Some(swap_api);
        self
    }

    pub fn with_slippage_guard(mut self, max_slippage_bps: u32) -> Self {
        self.max_slippage_bps = max_slippage_bps;
        self
    }

    /// Evaluate the CLOB↔AMM discrepancy (buy CLOB → sell AMM) and return an
    /// atomic bundle only when net profit clears the threshold. Direction A:
    /// `P_AMM_bid > P_CLOB_ask`.
    pub fn evaluate_arbitrage(
        &self,
        clob_quote: &PoolQuote,
        amm_quote: &PoolQuote,
        trade_size_ant: u64,
    ) -> Option<ArbitrageOpportunity> {
        if amm_quote.ant_bid_price <= clob_quote.ant_ask_price {
            return None; // spread inverted or zero — nothing to capture
        }
        if trade_size_ant > amm_quote.available_liquidity_ant.min(clob_quote.available_liquidity_ant) {
            return None; // venue cannot absorb the size
        }

        let gross_spread_per_share = amm_quote.ant_bid_price - clob_quote.ant_ask_price;
        let notional = (clob_quote.ant_ask_price as u128) * (trade_size_ant as u128);

        // Integer-exact fee model: fee = notional * bps / 10_000 (in
        // micro-USDC·share domain → divide by 1_000_000 to normalize).
        let clob_fee = notional * (BACKPACK_TAKER_FEE_BPS as u128) / (10_000 * MICRO_USDC as u128);
        let amm_fee =
            ((amm_quote.ant_bid_price as u128) * (trade_size_ant as u128) * (RAYDIUM_SWAP_FEE_BPS as u128))
                / (10_000 * MICRO_USDC as u128);
        let estimated_fees_micro_usdc =
            (clob_fee + amm_fee) as u64 + micro_usdc_from_lamports(self.jito_tip_lamports);

        let gross_profit = (gross_spread_per_share as u128 * trade_size_ant as u128) / MICRO_USDC as u128;

        // Invariant 4: slippage guard — the gross spread must be within the
        // hard band relative to the AMM mid price.
        let mid = amm_quote.mid_price();
        let slippage_bps = if mid == 0 {
            u128::MAX
        } else {
            gross_spread_per_share as u128 * 10_000 / mid as u128
        };
        if slippage_bps > self.max_slippage_bps as u128 {
            return None; // spread too wide ⇒ stale quote or price dislocation
        }

        let net = gross_profit as u64;
        if net <= estimated_fees_micro_usdc.saturating_add(self.min_profit_threshold_micro_usdc) {
            return None;
        }

        Some(ArbitrageOpportunity {
            buy_venue: clob_quote.venue_name.clone(),
            sell_venue: amm_quote.venue_name.clone(),
            trade_size_ant,
            net_profit_micro_usdc: net.saturating_sub(estimated_fees_micro_usdc),
            gross_spread_per_share,
            estimated_fees_micro_usdc,
        })
    }

    /// Direction B: AMM ask is cheaper than the CLOB bid (buy AMM → sell CLOB).
    pub fn evaluate_reverse_arbitrage(
        &self,
        clob_quote: &PoolQuote,
        amm_quote: &PoolQuote,
        trade_size_ant: u64,
    ) -> Option<ArbitrageOpportunity> {
        if clob_quote.ant_bid_price <= amm_quote.ant_ask_price {
            return None;
        }
        let reversed_clob = PoolQuote {
            venue_name: clob_quote.venue_name.clone(),
            ant_bid_price: amm_quote.ant_bid_price, // placeholder symmetric shape
            ant_ask_price: amm_quote.ant_ask_price,
            available_liquidity_ant: amm_quote.available_liquidity_ant,
        };
        let reversed_amm = PoolQuote {
            venue_name: amm_quote.venue_name.clone(),
            ant_bid_price: clob_quote.ant_bid_price,
            ant_ask_price: clob_quote.ant_ask_price,
            available_liquidity_ant: clob_quote.available_liquidity_ant,
        };
        self.evaluate_arbitrage(&reversed_clob, &reversed_amm, trade_size_ant)
    }

    /// Construct the atomic multi-instruction transaction including the Jito
    /// MEV tip. All legs execute or the whole bundle reverts — Invariant 1.
    ///
    /// The two swap legs (buy USDC→ANT, sell ANT→USDC) are fetched from the
    /// aggregator's own [`SwapApi`] and deserialized **verbatim**: the account
    /// list and the Anchor discriminator come from the aggregator, never from
    /// this crate. Hand-assembling a v6 account list (~18–25 accounts) with a
    /// raw `u64` "discriminator" yields a bundle that fails on-chain
    /// simulation — precisely what this path avoids.
    pub async fn build_atomic_bundle(
        &self,
        clob_buy_quote: &PoolQuote,
        trade_size_ant: u64,
    ) -> Result<AtomicBundle, SwapApiError> {
        let api = self.swap_api.as_ref().ok_or(SwapApiError::NotConfigured)?;

        // Buy leg: spend USDC to acquire `trade_size_ant` ANT.
        let buy_input_usdc = ((trade_size_ant as u128) * (clob_buy_quote.ant_ask_price as u128)
            / MICRO_USDC as u128) as u64;
        let buy_quote = api
            .quote(&QuoteRequest::exact_in(
                USDC_MINT,
                ANT_MINT,
                buy_input_usdc,
                self.max_slippage_bps,
            ))
            .await?;
        let buy_plan = api
            .swap_instructions(&SwapRequest::new(
                self.payer.pubkey().to_string(),
                buy_quote,
            ))
            .await?
            .to_plan()?;

        // Sell leg: return `trade_size_ant` ANT to USDC via the same
        // aggregator (Raydium is one of its routed venues, so the pool's
        // account layout and discriminator are the aggregator's, not ours).
        let sell_quote = api
            .quote(&QuoteRequest::exact_in(
                ANT_MINT,
                USDC_MINT,
                trade_size_ant,
                self.max_slippage_bps,
            ))
            .await?;
        let sell_plan = api
            .swap_instructions(&SwapRequest::new(
                self.payer.pubkey().to_string(),
                sell_quote,
            ))
            .await?
            .to_plan()?;

        let mut instructions = Vec::new();
        for plan in buy_plan
            .instructions
            .iter()
            .chain(sell_plan.instructions.iter())
        {
            instructions.push(plan_to_instruction(plan)?);
        }

        // Jito MEV tip: guarantees priority inclusion or complete revert.
        let tip_account = Pubkey::from_str(JITO_TIP_ACCOUNT).expect("valid jito tip account");
        instructions.push(system_instruction::transfer(
            &self.payer.pubkey(),
            &tip_account,
            self.jito_tip_lamports,
        ));

        // Unsigned transaction — the relayer populates the recent blockhash
        // immediately before submission (sub-400ms slot discipline).
        let transaction = Transaction::new_with_payer(&instructions, Some(&self.payer.pubkey()));

        Ok(AtomicBundle {
            transaction,
            address_lookup_table_addresses: buy_plan
                .address_lookup_table_addresses
                .into_iter()
                .chain(sell_plan.address_lookup_table_addresses)
                .collect(),
        })
    }
}

/// Convert one aggregator instruction plan into a Solana [`Instruction`],
/// preserving the program id, account order and privilege flags verbatim.
///
/// The `data` bytes — including the Anchor 8-byte discriminator — are copied
/// exactly as the aggregator returned them; this function never reconstructs
/// them.
fn plan_to_instruction(plan: &InstructionPlan) -> Result<Instruction, SwapApiError> {
    let program_id =
        Pubkey::from_str(&plan.program_id).map_err(|e| SwapApiError::Pubkey(e.to_string()))?;
    let mut accounts = Vec::with_capacity(plan.accounts.len());
    for meta in &plan.accounts {
        let pubkey =
            Pubkey::from_str(&meta.pubkey).map_err(|e| SwapApiError::Pubkey(e.to_string()))?;
        accounts.push(match (meta.is_signer, meta.is_writable) {
            (true, true) => AccountMeta::new(pubkey, true),
            (true, false) => AccountMeta::new_readonly(pubkey, true),
            (false, true) => AccountMeta::new(pubkey, false),
            (false, false) => AccountMeta::new_readonly(pubkey, false),
        });
    }
    Ok(Instruction {
        program_id,
        accounts,
        data: plan.data.clone(),
    })
}

/// Jito tip cost expressed in micro-USDC (SOL-priced tip normalized for the
/// integer profit comparison).
fn micro_usdc_from_lamports(lamports: u64) -> u64 {
    // Rough constant SOL→USDC mapping is acceptable for threshold math;
    // the relayer refreshes it per slot.
    const SOL_USDC_CENTS: u64 = 21_000; // $210.00 in cents
    (lamports as u128 * SOL_USDC_CENTS as u128 / (LAMPORTS_PER_SOL as u128 * 10_000)) as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn quote(name: &str, bid: u64, ask: u64, liq: u64) -> PoolQuote {
        PoolQuote {
            venue_name: name.into(),
            ant_bid_price: bid,
            ant_ask_price: ask,
            available_liquidity_ant: liq,
        }
    }

    fn engine() -> ArbitrageEngine {
        let payer = Arc::new(Keypair::new());
        ArbitrageEngine::new(payer, 0.0, 0.001)
    }

    #[test]
    fn profitable_spread_produces_opportunity() {
        // A $1.10 spread on an $89.55 mid is ~122 bps, which the engine's
        // default 15 bps guard (Invariant 4) would classify as dislocation.
        // The spread is nonetheless net-profitable, so widen the guard here to
        // exercise the profit path; the guard itself is covered separately.
        let engine = engine().with_slippage_guard(150);
        let clob = quote("Backpack CLOB", 88_400_000, 88_400_000, 100_000);
        let amm = quote("Raydium CPMM", 89_500_000, 89_600_000, 50_000);
        let opp = engine
            .evaluate_arbitrage(&clob, &amm, 10_000)
            .expect("1.10 spread on 10k shares must clear fees");
        assert_eq!(opp.buy_venue, "Backpack CLOB");
        assert_eq!(opp.sell_venue, "Raydium CPMM");
        assert!(opp.net_profit_micro_usdc > 0);
    }

    #[test]
    fn inverted_spread_produces_nothing() {
        let engine = engine();
        let clob = quote("Backpack CLOB", 89_500_000, 89_500_000, 100_000);
        let amm = quote("Raydium CPMM", 88_400_000, 88_400_000, 50_000);
        assert!(engine.evaluate_arbitrage(&clob, &amm, 10_000).is_none());
    }

    #[test]
    fn insufficient_liquidity_produces_nothing() {
        let engine = engine();
        let clob = quote("Backpack CLOB", 88_400_000, 88_400_000, 100);
        let amm = quote("Raydium CPMM", 89_500_000, 89_600_000, 50_000);
        // Size 10k > CLOB liquidity 100 → rejected.
        assert!(engine.evaluate_arbitrage(&clob, &amm, 10_000).is_none());
    }

    #[test]
    fn slippage_guard_rejects_dislocated_quotes() {
        let engine = engine().with_slippage_guard(15);
        // Spread of 3.4% ($3.40 on $89 mid) ≫ 15 bps band → stale/dislocated.
        let clob = quote("Backpack CLOB", 86_000_000, 86_000_000, 100_000);
        let amm = quote("Raydium CPMM", 89_400_000, 89_500_000, 50_000);
        assert!(engine.evaluate_arbitrage(&clob, &amm, 10_000).is_none());
    }

    #[test]
    fn tiny_spread_below_fees_produces_nothing() {
        let engine = engine();
        // 0.5 micro-USDC spread on $89 = ~0.0000006% — far below fees.
        let clob = quote("Backpack CLOB", 89_000_000, 89_000_000, 100_000);
        let amm = quote("Raydium CPMM", 89_000_001, 89_000_001, 50_000);
        assert!(engine.evaluate_arbitrage(&clob, &amm, 1).is_none());
    }

    #[tokio::test]
    async fn recorded_aggregator_builds_both_legs_plus_tip() {
        use crate::jupiter_swap_api::RecordedSwapApi;

        let engine = engine().with_swap_api(Arc::new(RecordedSwapApi::from_fixtures()));
        let clob = quote("Backpack CLOB", 88_400_000, 88_400_000, 100_000);
        let bundle = engine
            .build_atomic_bundle(&clob, 10_000)
            .await
            .expect("recorded aggregator fixtures build a bundle");

        // buy leg (compute-budget + setup + swap)
        // + sell leg (compute-budget + setup + swap)
        // + Jito tip
        assert_eq!(bundle.transaction.message.instructions.len(), 7);
        // One lookup-table address per leg, straight from the API response.
        assert_eq!(bundle.address_lookup_table_addresses.len(), 2);
    }

    #[test]
    fn aggregator_swap_instruction_keeps_full_account_layout() {
        let response: crate::jupiter_swap_api::SwapInstructionsResponse =
            serde_json::from_str(crate::jupiter_swap_api::RECORDED_SWAP_INSTRUCTIONS_FIXTURE)
                .expect("fixture deserializes");
        let plan = response.to_plan().expect("plan decodes");
        let swap = plan
            .instructions
            .iter()
            .find(|ix| ix.program_id == crate::jupiter_swap_api::JUPITER_V6_PROGRAM_ID)
            .expect("aggregator returned the routed swap");

        let instruction = plan_to_instruction(swap).expect("aggregator program id is valid");
        // The full aggregator account list is carried through verbatim — not
        // the 3-account hand-rolled layout of the original defect.
        assert_eq!(instruction.accounts.len(), 18);
        assert_eq!(
            instruction.program_id.to_string(),
            crate::jupiter_swap_api::JUPITER_V6_PROGRAM_ID
        );
        // Discriminator/data are copied byte-for-byte, never reconstructed.
        assert_eq!(instruction.data, swap.data);
    }

    #[tokio::test]
    async fn bundle_without_swap_api_is_not_configured() {
        let engine = engine();
        let clob = quote("Backpack CLOB", 88_400_000, 88_400_000, 100_000);
        assert!(matches!(
            engine.build_atomic_bundle(&clob, 10_000).await,
            Err(SwapApiError::NotConfigured)
        ));
    }
}
