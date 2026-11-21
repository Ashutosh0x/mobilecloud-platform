//! Source evidence parsers.
//!
//! Each parser authenticates **one pillar** of the Three-Pillar Evidence
//! Ingestion Pipeline before the envelope is allowed anywhere near the
//! reconciliation kernel:
//!
//! * [`alpaca_jws`]   — Pillar B: Alpaca Securities custody positions (RFC 7515 JWS, PS256).
//! * [`swift_iso20022`] — Pillar B (institutional custodians): ISO 20022 `semt.002`
//!   custody reports authenticated via W3C XMLDSig (Exclusive C14N + RSA-SHA256).
//! * [`dinari_ta`]    — Pillar C: SEC-registered Transfer Agent master ledger (Ed25519).

pub mod alpaca_jws;
pub mod dinari_ta;
pub mod swift_iso20022;
