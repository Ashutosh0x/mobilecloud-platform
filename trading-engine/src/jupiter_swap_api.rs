//! Jupiter Aggregator v6 Swap API client (trading spec §3.1 — execution legs).
//!
//! The arbitrage bundle's swap legs are **not** hand-assembled. Reconstructing
//! Jupiter v6 / Raydium AMM v4 account metas and Anchor 8-byte instruction
//! discriminators from memory is fragile: a routed swap references a
//! program-defined account list (Jupiter v6 needs ~18–25 accounts) and
//! privilege flags the caller cannot derive, so a hand-built bundle fails
//! on-chain simulation.
//!
//! Instead the engine follows the industry-standard integration: it asks the
//! aggregator's own API for the exact instructions —
//! `GET /swap/v1/quote` then `POST /swap/v1/swap-instructions` — and
//! deserializes the returned `swapInstruction`, `setupInstructions`,
//! `computeBudgetInstructions` and `addressLookupTableAddresses` *verbatim*
//! into the transaction. The account layout and discriminators therefore come
//! from the aggregator, never from this crate.
//!
//! All network access sits behind [`SwapApi`]. Production wiring composes
//! [`JupiterSwapApi`] with a concrete [`HttpTransport`] such as
//! [`HyperJsonTransport`]; unit tests inject [`RecordedSwapApi`] backed by a
//! hand-written fixture mirroring the documented Jupiter v6 response schema.
//!
//! Raydium AMM v4 is deliberately **not** called directly here: a direct
//! Raydium pool interaction needs the pool's own account ordering and the
//! AMM's discriminator, so the sell leg is routed through the same aggregator
//! (Raydium appears as the `label` in the quote's `routePlan`). This avoids
//! inventing a layout we do not own.

use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Jupiter v6 Swap API base host (documented public endpoint).
pub const JUPITER_SWAP_API_BASE: &str = "https://lite-api.jup.ag";
/// `GET` quote path.
pub const JUPITER_QUOTE_PATH: &str = "/swap/v1/quote";
/// `POST` swap-instructions path.
pub const JUPITER_SWAP_INSTRUCTIONS_PATH: &str = "/swap/v1/swap-instructions";
/// Jupiter Aggregator v6 program id, as returned by the aggregator itself.
pub const JUPITER_V6_PROGRAM_ID: &str = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";

/// Errors surfaced by the swap-API layer.
#[derive(Debug, Error)]
pub enum SwapApiError {
    /// No [`SwapApi`] was bound to the engine.
    #[error("swap API transport is not configured on this engine")]
    NotConfigured,
    /// Transport/HTTP failure (non-2xx, IO, or body decode).
    #[error("swap API HTTP error: {0}")]
    Http(String),
    /// Response body could not be parsed into the documented schema.
    #[error("swap API JSON error: {0}")]
    Json(#[from] serde_json::Error),
    /// An instruction `data` field was not valid base64.
    #[error("instruction data is not valid base64: {0}")]
    Base64(#[from] base64::DecodeError),
    /// A returned account/public key was not a valid 32-byte Solana pubkey.
    #[error("invalid Solana pubkey: {0}")]
    Pubkey(String),
}

// ---------------------------------------------------------------------------
// `/swap/v1/quote`
// ---------------------------------------------------------------------------

/// Query parameters for `GET /swap/v1/quote`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuoteRequest {
    pub input_mint: String,
    pub output_mint: String,
    /// Amount in the input mint's base units (u64 range covers all practical
    /// sizes; the API accepts it as a decimal string).
    pub amount: u64,
    pub slippage_bps: u32,
    pub swap_mode: String,
}

impl QuoteRequest {
    /// `ExactIn`: spend exactly `amount` of `input_mint`.
    pub fn exact_in(
        input_mint: impl Into<String>,
        output_mint: impl Into<String>,
        amount: u64,
        slippage_bps: u32,
    ) -> Self {
        Self {
            input_mint: input_mint.into(),
            output_mint: output_mint.into(),
            amount,
            slippage_bps,
            swap_mode: "ExactIn".to_string(),
        }
    }

    /// Query-string fragment for [`JUPITER_QUOTE_PATH`].
    pub fn query(&self) -> String {
        // Solana mints are base58 (no reserved URL characters), so no
        // percent-encoding is required.
        format!(
            "inputMint={}&outputMint={}&amount={}&slippageBps={}&swapMode={}",
            self.input_mint, self.output_mint, self.amount, self.slippage_bps, self.swap_mode
        )
    }
}

/// One hop in a route as returned by the aggregator.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SwapInfo {
    pub amm_key: String,
    pub label: String,
    pub input_mint: String,
    pub output_mint: String,
    pub in_amount: String,
    pub out_amount: String,
    pub fee_amount: String,
    pub fee_mint: String,
}

/// A routing step (a venue plus the share of the order routed through it).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutePlan {
    pub swap_info: SwapInfo,
    pub percent: u8,
}

/// `GET /swap/v1/quote` response (documented fields; amounts are strings).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuoteResponse {
    pub input_mint: String,
    pub in_amount: String,
    pub output_mint: String,
    pub out_amount: String,
    pub other_amount_threshold: String,
    pub swap_mode: String,
    pub slippage_bps: u32,
    #[serde(default)]
    pub price_impact_pct: String,
    #[serde(default)]
    pub route_plan: Vec<RoutePlan>,
    #[serde(default)]
    pub context_slot: Option<u64>,
    #[serde(default)]
    pub time_taken: Option<f64>,
}

// ---------------------------------------------------------------------------
// `/swap/v1/swap-instructions`
// ---------------------------------------------------------------------------

/// One account meta exactly as serialized by the aggregator.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountMetaDto {
    pub pubkey: String,
    pub is_signer: bool,
    pub is_writable: bool,
}

/// One instruction exactly as serialized by the aggregator. `data` is base64.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstructionDto {
    pub program_id: String,
    pub accounts: Vec<AccountMetaDto>,
    pub data: String,
}

/// `POST /swap/v1/swap-instructions` request body (documented fields).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SwapRequest {
    pub user_public_key: String,
    pub quote_response: QuoteResponse,
    pub wrap_and_unwrap_sol: bool,
    pub use_shared_accounts: bool,
    pub dynamic_compute_unit_limit: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compute_unit_price_micro_lamports: Option<u64>,
    pub as_legacy_transaction: bool,
    pub use_token_ledger: bool,
}

impl SwapRequest {
    /// Sensible defaults for an atomic bundle leg: no wrapped-SOL handling is
    /// needed for an SPL↔SPL route, and the bundle is built legacy-compatible
    /// (account lookups are applied by the relayer).
    pub fn new(user_public_key: impl Into<String>, quote_response: QuoteResponse) -> Self {
        Self {
            user_public_key: user_public_key.into(),
            quote_response,
            wrap_and_unwrap_sol: true,
            use_shared_accounts: true,
            dynamic_compute_unit_limit: true,
            compute_unit_price_micro_lamports: None,
            as_legacy_transaction: false,
            use_token_ledger: false,
        }
    }
}

/// `POST /swap/v1/swap-instructions` response (documented fields).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SwapInstructionsResponse {
    #[serde(default)]
    pub token_ledger_instruction: Option<InstructionDto>,
    #[serde(default)]
    pub compute_budget_instructions: Vec<InstructionDto>,
    #[serde(default)]
    pub setup_instructions: Vec<InstructionDto>,
    /// The routed swap itself — the instruction carrying the aggregator's
    /// full account layout and discriminator.
    pub swap_instruction: InstructionDto,
    #[serde(default)]
    pub cleanup_instruction: Option<InstructionDto>,
    #[serde(default)]
    pub other_instructions: Vec<InstructionDto>,
    /// Addresses the relayer feeds into a v0 message's lookup table list.
    #[serde(default)]
    pub address_lookup_table_addresses: Vec<String>,
    #[serde(default)]
    pub compute_unit_estimate: Option<u64>,
}

// ---------------------------------------------------------------------------
// Solana-independent instruction plan (base64 decoded, order preserved)
// ---------------------------------------------------------------------------

/// A decoded account meta (no Solana dependency).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountPlan {
    pub pubkey: String,
    pub is_signer: bool,
    pub is_writable: bool,
}

/// A decoded instruction: the exact layout the aggregator returned.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstructionPlan {
    pub program_id: String,
    pub accounts: Vec<AccountPlan>,
    /// Decoded from the response's base64 `data`.
    pub data: Vec<u8>,
}

/// The full set of decoded instructions for one swap leg, in execution order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SwapPlan {
    pub instructions: Vec<InstructionPlan>,
    pub address_lookup_table_addresses: Vec<String>,
}

impl InstructionDto {
    /// Decode this DTO's base64 `data` and copy its metas verbatim.
    pub fn to_plan(&self) -> Result<InstructionPlan, SwapApiError> {
        use base64::Engine as _;
        Ok(InstructionPlan {
            program_id: self.program_id.clone(),
            accounts: self
                .accounts
                .iter()
                .map(|a| AccountPlan {
                    pubkey: a.pubkey.clone(),
                    is_signer: a.is_signer,
                    is_writable: a.is_writable,
                })
                .collect(),
            data: base64::engine::general_purpose::STANDARD.decode(&self.data)?,
        })
    }
}

impl SwapInstructionsResponse {
    /// Decode every returned instruction, preserving the aggregator's order:
    /// token-ledger, compute-budget, setup, swap, cleanup, other.
    pub fn to_plan(&self) -> Result<SwapPlan, SwapApiError> {
        let mut instructions = Vec::new();
        if let Some(ix) = &self.token_ledger_instruction {
            instructions.push(ix.to_plan()?);
        }
        for ix in &self.compute_budget_instructions {
            instructions.push(ix.to_plan()?);
        }
        for ix in &self.setup_instructions {
            instructions.push(ix.to_plan()?);
        }
        instructions.push(self.swap_instruction.to_plan()?);
        if let Some(ix) = &self.cleanup_instruction {
            instructions.push(ix.to_plan()?);
        }
        for ix in &self.other_instructions {
            instructions.push(ix.to_plan()?);
        }
        Ok(SwapPlan {
            instructions,
            address_lookup_table_addresses: self.address_lookup_table_addresses.clone(),
        })
    }
}

// ---------------------------------------------------------------------------
// Network seam
// ---------------------------------------------------------------------------

/// Minimal HTTP transport so the aggregator client is testable without a live
/// socket. A concrete implementation wraps whatever HTTP stack the embedding
/// binary links (see [`HyperJsonTransport`]).
#[async_trait::async_trait]
pub trait HttpTransport: Send + Sync {
    /// `GET` `url`, returning the response body.
    async fn get_json(&self, url: &str) -> Result<String, SwapApiError>;
    /// `POST` `body` (already-serialized JSON) to `url`, returning the body.
    async fn post_json(&self, url: &str, body: &str) -> Result<String, SwapApiError>;
}

/// The aggregator integration point.
#[async_trait::async_trait]
pub trait SwapApi: Send + Sync {
    /// Fetch an executable quote.
    async fn quote(&self, request: &QuoteRequest) -> Result<QuoteResponse, SwapApiError>;
    /// Fetch the exact instructions for a quoted swap.
    async fn swap_instructions(
        &self,
        request: &SwapRequest,
    ) -> Result<SwapInstructionsResponse, SwapApiError>;
}

/// Real Jupiter v6 client: builds the documented requests and delegates the
/// round-trip to an injected [`HttpTransport`].
pub struct JupiterSwapApi<C: HttpTransport> {
    transport: C,
    base_url: String,
}

impl<C: HttpTransport> JupiterSwapApi<C> {
    /// Use the documented public endpoint.
    pub fn new(transport: C) -> Self {
        Self {
            transport,
            base_url: JUPITER_SWAP_API_BASE.to_string(),
        }
    }

    /// Override the base URL (self-hosted proxy / test server).
    pub fn with_base_url(transport: C, base_url: impl Into<String>) -> Self {
        Self {
            transport,
            base_url: base_url.into(),
        }
    }

    /// Fully-formed quote URL for `request`.
    pub fn quote_url(&self, request: &QuoteRequest) -> String {
        format!(
            "{}{}?{}",
            self.base_url.trim_end_matches('/'),
            JUPITER_QUOTE_PATH,
            request.query()
        )
    }

    /// Fully-formed swap-instructions URL.
    pub fn swap_instructions_url(&self) -> String {
        format!(
            "{}{}",
            self.base_url.trim_end_matches('/'),
            JUPITER_SWAP_INSTRUCTIONS_PATH
        )
    }
}

#[async_trait::async_trait]
impl<C: HttpTransport> SwapApi for JupiterSwapApi<C> {
    async fn quote(&self, request: &QuoteRequest) -> Result<QuoteResponse, SwapApiError> {
        let body = self.transport.get_json(&self.quote_url(request)).await?;
        Ok(serde_json::from_str(&body)?)
    }

    async fn swap_instructions(
        &self,
        request: &SwapRequest,
    ) -> Result<SwapInstructionsResponse, SwapApiError> {
        let body = serde_json::to_string(request)?;
        let response = self
            .transport
            .post_json(&self.swap_instructions_url(), &body)
            .await?;
        Ok(serde_json::from_str(&response)?)
    }
}

/// Concrete [`HttpTransport`] over the workspace's Hyper 1.x client stack
/// (the same stack `core-engine` uses for its loopback HTTP client).
///
/// NOTE (TLS): `HyperConnector`/`HttpConnector` speaks plain HTTP/1.1 only.
/// Jupiter's public endpoints are HTTPS, so in production this transport must
/// either point at a TLS-terminating local proxy or be swapped for a
/// TLS-capable connector (e.g. `hyper-rustls`). No TLS connector is wired
/// here because none is a dependency of this workspace.
pub struct HyperJsonTransport {
    client: hyper_util::client::legacy::Client<
        hyper_util::client::legacy::connect::HttpConnector,
        http_body_util::Full<hyper::body::Bytes>,
    >,
}

impl Default for HyperJsonTransport {
    fn default() -> Self {
        Self::new()
    }
}

impl HyperJsonTransport {
    pub fn new() -> Self {
        let client = hyper_util::client::legacy::Client::builder(
            hyper_util::rt::TokioExecutor::new(),
        )
        .build(hyper_util::client::legacy::connect::HttpConnector::new());
        Self { client }
    }

    async fn send(
        &self,
        request: hyper::Request<http_body_util::Full<hyper::body::Bytes>>,
    ) -> Result<String, SwapApiError> {
        let response = self
            .client
            .request(request)
            .await
            .map_err(|e| SwapApiError::Http(e.to_string()))?;
        let status = response.status();
        let bytes = http_body_util::BodyExt::collect(response.into_body())
            .await
            .map_err(|e| SwapApiError::Http(e.to_string()))?
            .to_bytes();
        let text = String::from_utf8(bytes.to_vec()).map_err(|e| SwapApiError::Http(e.to_string()))?;
        if !status.is_success() {
            return Err(SwapApiError::Http(format!("HTTP {status}: {text}")));
        }
        Ok(text)
    }
}

#[async_trait::async_trait]
impl HttpTransport for HyperJsonTransport {
    async fn get_json(&self, url: &str) -> Result<String, SwapApiError> {
        let request = hyper::Request::builder()
            .method(hyper::Method::GET)
            .uri(url)
            .body(http_body_util::Full::new(hyper::body::Bytes::new()))
            .map_err(|e| SwapApiError::Http(e.to_string()))?;
        self.send(request).await
    }

    async fn post_json(&self, url: &str, body: &str) -> Result<String, SwapApiError> {
        let request = hyper::Request::builder()
            .method(hyper::Method::POST)
            .uri(url)
            .header(hyper::header::CONTENT_TYPE, "application/json")
            .body(http_body_util::Full::new(hyper::body::Bytes::from(
                body.to_string(),
            )))
            .map_err(|e| SwapApiError::Http(e.to_string()))?;
        self.send(request).await
    }
}

// ---------------------------------------------------------------------------
// Recorded fixtures (HAND-WRITTEN)
// ---------------------------------------------------------------------------
//
// The two constants below are HAND-WRITTEN fixtures that follow the *documented*
// Jupiter v6 response schema. They are NOT captured live traffic and are not
// presented as such. They exist so the deserialization + verbatim-to-plan path
// is exercised deterministically offline.

/// Hand-written `/swap/v1/quote` fixture matching the documented schema.
pub const RECORDED_QUOTE_FIXTURE: &str = r#"{
  "inputMint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "inAmount": "885000000",
  "outputMint": "ANTBTZQ1EUuTxUs3tfeampxdqTWPHmwyJmcWj4xoAyNe",
  "outAmount": "10000000",
  "otherAmountThreshold": "9950000",
  "swapMode": "ExactIn",
  "slippageBps": 15,
  "priceImpactPct": "0.000184213",
  "routePlan": [
    {
      "swapInfo": {
        "ammKey": "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
        "label": "Raydium",
        "inputMint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        "outputMint": "ANTBTZQ1EUuTxUs3tfeampxdqTWPHmwyJmcWj4xoAyNe",
        "inAmount": "885000000",
        "outAmount": "10000000",
        "feeAmount": "2212500",
        "feeMint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
      },
      "percent": 100
    }
  ],
  "contextSlot": 289123456,
  "timeTaken": 0.00133
}"#;

/// Hand-written `/swap/v1/swap-instructions` fixture matching the documented
/// schema. `swapInstruction` carries the aggregator's real program id and an
/// 18-account layout; its `data` is opaque base64 that this crate copies
/// verbatim (no discriminator is reconstructed here).
pub const RECORDED_SWAP_INSTRUCTIONS_FIXTURE: &str = r#"{
  "tokenLedgerInstruction": null,
  "computeBudgetInstructions": [
    {
      "programId": "ComputeBudget111111111111111111111111111111",
      "accounts": [],
      "data": "AkBCDwA="
    }
  ],
  "setupInstructions": [
    {
      "programId": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
      "accounts": [
        {"pubkey": "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T", "isSigner": true, "isWritable": true},
        {"pubkey": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "isSigner": false, "isWritable": false},
        {"pubkey": "11111111111111111111111111111111", "isSigner": false, "isWritable": false},
        {"pubkey": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "isSigner": false, "isWritable": false},
        {"pubkey": "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin", "isSigner": false, "isWritable": true}
      ],
      "data": "AQ=="
    }
  ],
  "swapInstruction": {
    "programId": "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
    "accounts": [
      {"pubkey": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "isSigner": false, "isWritable": false},
      {"pubkey": "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T", "isSigner": false, "isWritable": true},
      {"pubkey": "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin", "isSigner": false, "isWritable": true},
      {"pubkey": "9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E", "isSigner": false, "isWritable": true},
      {"pubkey": "ANTBTZQ1EUuTxUs3tfeampxdqTWPHmwyJmcWj4xoAyNe", "isSigner": false, "isWritable": false},
      {"pubkey": "So11111111111111111111111111111111111111112", "isSigner": false, "isWritable": false},
      {"pubkey": "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", "isSigner": false, "isWritable": false},
      {"pubkey": "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5", "isSigner": false, "isWritable": true},
      {"pubkey": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "isSigner": false, "isWritable": false},
      {"pubkey": "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T", "isSigner": false, "isWritable": true},
      {"pubkey": "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin", "isSigner": false, "isWritable": true},
      {"pubkey": "9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E", "isSigner": false, "isWritable": true},
      {"pubkey": "ANTBTZQ1EUuTxUs3tfeampxdqTWPHmwyJmcWj4xoAyNe", "isSigner": false, "isWritable": false},
      {"pubkey": "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", "isSigner": false, "isWritable": true},
      {"pubkey": "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5", "isSigner": false, "isWritable": false},
      {"pubkey": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "isSigner": false, "isWritable": true},
      {"pubkey": "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T", "isSigner": false, "isWritable": false},
      {"pubkey": "BPFLoaderUpgradeab1e11111111111111111111111", "isSigner": false, "isWritable": false}
    ],
    "data": "5RfLl3rjrSqAlpgAAAAAAA=="
  },
  "cleanupInstruction": null,
  "otherInstructions": [],
  "addressLookupTableAddresses": ["9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin"],
  "computeUnitEstimate": 218754
}"#;

/// Deterministic [`SwapApi`] double: returns fixture JSON without any socket.
pub struct RecordedSwapApi {
    quote_json: String,
    swap_instructions_json: String,
}

impl RecordedSwapApi {
    pub fn new(
        quote_json: impl Into<String>,
        swap_instructions_json: impl Into<String>,
    ) -> Self {
        Self {
            quote_json: quote_json.into(),
            swap_instructions_json: swap_instructions_json.into(),
        }
    }

    /// Build the double from the module's hand-written fixtures.
    pub fn from_fixtures() -> Self {
        Self::new(RECORDED_QUOTE_FIXTURE, RECORDED_SWAP_INSTRUCTIONS_FIXTURE)
    }
}

#[async_trait::async_trait]
impl SwapApi for RecordedSwapApi {
    async fn quote(&self, _request: &QuoteRequest) -> Result<QuoteResponse, SwapApiError> {
        Ok(serde_json::from_str(&self.quote_json)?)
    }

    async fn swap_instructions(
        &self,
        _request: &SwapRequest,
    ) -> Result<SwapInstructionsResponse, SwapApiError> {
        Ok(serde_json::from_str(&self.swap_instructions_json)?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quote_fixture_deserializes_into_documented_schema() {
        let quote: QuoteResponse = serde_json::from_str(RECORDED_QUOTE_FIXTURE).unwrap();
        assert_eq!(quote.input_mint, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
        assert_eq!(quote.output_mint, "ANTBTZQ1EUuTxUs3tfeampxdqTWPHmwyJmcWj4xoAyNe");
        assert_eq!(quote.in_amount, "885000000");
        assert_eq!(quote.out_amount, "10000000");
        assert_eq!(quote.swap_mode, "ExactIn");
        assert_eq!(quote.slippage_bps, 15);
        assert_eq!(quote.route_plan.len(), 1);
        assert_eq!(quote.route_plan[0].swap_info.label, "Raydium");
        assert_eq!(quote.route_plan[0].percent, 100);
    }

    #[test]
    fn swap_instructions_fixture_preserves_aggregator_layout() {
        let response: SwapInstructionsResponse =
            serde_json::from_str(RECORDED_SWAP_INSTRUCTIONS_FIXTURE).unwrap();

        // The routed swap comes from the aggregator, not from this crate.
        assert_eq!(response.swap_instruction.program_id, JUPITER_V6_PROGRAM_ID);
        assert_eq!(response.swap_instruction.accounts.len(), 18);
        assert_eq!(response.compute_budget_instructions.len(), 1);
        assert_eq!(response.setup_instructions.len(), 1);
        assert_eq!(response.address_lookup_table_addresses.len(), 1);
        assert_eq!(response.compute_unit_estimate, Some(218754));
    }

    #[test]
    fn plan_decodes_base64_and_keeps_account_flags_verbatim() {
        let response: SwapInstructionsResponse =
            serde_json::from_str(RECORDED_SWAP_INSTRUCTIONS_FIXTURE).unwrap();
        let plan = response.to_plan().unwrap();

        // Order: compute-budget, setup, swap (no token-ledger/cleanup/other).
        assert_eq!(plan.instructions.len(), 3);
        assert_eq!(plan.address_lookup_table_addresses.len(), 1);

        let swap = plan
            .instructions
            .iter()
            .find(|ix| ix.program_id == JUPITER_V6_PROGRAM_ID)
            .expect("swap instruction present");

        assert_eq!(swap.accounts.len(), 18);
        // First meta is exactly what the aggregator returned (readonly).
        assert_eq!(
            swap.accounts[0],
            AccountPlan {
                pubkey: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA".to_string(),
                is_signer: false,
                is_writable: false,
            }
        );
        // The opaque aggregator data is copied byte-for-byte.
        assert_eq!(
            swap.data,
            vec![
                0xE5, 0x17, 0xCB, 0x97, 0x7A, 0xE3, 0xAD, 0x2A, 0x80, 0x96, 0x98, 0x00, 0x00,
                0x00, 0x00, 0x00
            ]
        );

        // A setup instruction must preserve its signer flag.
        let setup = plan
            .instructions
            .iter()
            .find(|ix| ix.program_id == "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL")
            .expect("setup instruction present");
        assert!(setup.accounts[0].is_signer);
        assert_eq!(setup.data, vec![0x01]);
    }

    #[tokio::test]
    async fn recorded_swap_api_flow_yields_plan_offline() {
        let api = RecordedSwapApi::from_fixtures();

        let quote = api
            .quote(&QuoteRequest::exact_in(
                "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
                "ANTBTZQ1EUuTxUs3tfeampxdqTWPHmwyJmcWj4xoAyNe",
                885_000_000,
                15,
            ))
            .await
            .unwrap();
        let response = api
            .swap_instructions(&SwapRequest::new(
                "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T",
                quote,
            ))
            .await
            .unwrap();
        let plan = response.to_plan().unwrap();

        assert_eq!(plan.instructions.len(), 3);
        assert!(plan
            .instructions
            .iter()
            .any(|ix| ix.program_id == JUPITER_V6_PROGRAM_ID));
    }

    #[test]
    fn quote_request_builds_documented_query_string() {
        let request = QuoteRequest::exact_in(
            "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
            "ANTBTZQ1EUuTxUs3tfeampxdqTWPHmwyJmcWj4xoAyNe",
            885_000_000,
            15,
        );
        assert_eq!(
            request.query(),
            "inputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&outputMint=ANTBTZQ1EUuTxUs3tfeampxdqTWPHmwyJmcWj4xoAyNe&amount=885000000&slippageBps=15&swapMode=ExactIn"
        );
    }

    #[test]
    fn jupiter_client_builds_endpoint_urls() {
        let client = JupiterSwapApi::with_base_url(HyperJsonTransport::new(), "https://proxy.local/");
        assert_eq!(
            client.swap_instructions_url(),
            "https://proxy.local/swap/v1/swap-instructions"
        );
        let request = QuoteRequest::exact_in(
            "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
            "ANTBTZQ1EUuTxUs3tfeampxdqTWPHmwyJmcWj4xoAyNe",
            1,
            15,
        );
        assert!(client
            .quote_url(&request)
            .starts_with("https://proxy.local/swap/v1/quote?inputMint="));
    }

    #[test]
    fn non_base64_instruction_data_is_rejected() {
        let dto = InstructionDto {
            program_id: JUPITER_V6_PROGRAM_ID.to_string(),
            accounts: vec![],
            data: "not base64!!".to_string(),
        };
        assert!(matches!(dto.to_plan(), Err(SwapApiError::Base64(_))));
    }
}
