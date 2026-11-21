//! Canonical Soroban `LedgerKey` construction & verification for FurlPay PoR
//! audits (promotion of the frozen `tools/xdrkey` reference encoder).
//!
//! Why this crate exists: during the 2026-11-21 testnet baseline, hand-rolled
//! Python byte synthesis of `ScVal::Vec` omitted the 4-byte RFC 4506
//! `Option<T>` presence flag, so the RPC parser read the vector length as the
//! boolean flag and aborted (`cannot unmarshal key value`). These regression
//! tests pin the exact wire layout so manual-encoding drift can never recur.
//!
//! Reference: `STELLAR_PROTOCOL_30_XDR_COMPATIBILITY_AND_INDEPENDENT_POR_VERIFICATION_REPORT_2026.md` §3.2.

use stellar_xdr::curr::{
    ContractDataDurability, Hash, LedgerKey, LedgerKeyContractData, Limits, ReadXdr, ScAddress,
    ScSymbol, ScVal, ScVec, StringM, VecM, WriteXdr,
};
use std::convert::TryFrom;

/// Build a `Symbol` ScVal (e.g. `"LatestRecord"`, `"ANT"`).
pub fn sym(s: &str) -> ScVal {
    ScVal::Symbol(ScSymbol(StringM::try_from(s.to_string()).expect("symbol <= 32 chars")))
}

/// Build the canonical two-symbol storage key for a contract data entry:
/// `ScVal::Vec(Some([variant, asset]))` — the encoding used by every
/// per-asset `DataKey` tuple variant (LatestRecord / AssetStatus / …).
pub fn two_symbol_key_val(variant: &str, asset: &str) -> ScVal {
    ScVal::Vec(Some(ScVec(VecM::try_from(vec![sym(variant), sym(asset)])
        .expect("two-element symbol vec"))))
}

/// Build the persistent `LedgerKey::ContractData` for a per-asset entry.
pub fn contract_data_key(contract_hash: [u8; 32], variant: &str, asset: &str) -> LedgerKey {
    LedgerKey::ContractData(LedgerKeyContractData {
        contract: ScAddress::Contract(Hash(contract_hash)),
        key: two_symbol_key_val(variant, asset),
        durability: ContractDataDurability::Persistent,
    })
}

/// XDR-encode a `LedgerKey` (canonical wire bytes; feed to `getLedgerEntries`
/// base64-wrapped by the JSON-RPC layer).
pub fn encode_key(key: &LedgerKey) -> Vec<u8> {
    key.to_xdr(Limits::none()).expect("LedgerKey encodes")
}

/// Decode XDR bytes back into a `LedgerKey`, consuming the stream exactly.
pub fn decode_key(bytes: &[u8]) -> LedgerKey {
    let mut lim = stellar_xdr::curr::Limited::new(bytes, Limits::none());
    LedgerKey::read_xdr_to_end(&mut lim).expect("LedgerKey decodes")
}

/// Lowercase hex rendering (dependency-free; the JSON-RPC layer base64-wraps).
pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Golden wire layout from the audit's byte-comparison table (§3.2):
    /// the RPC-accepted encoding of `Vec([Symbol("LatestRecord"), Symbol("ANT")])`.
    const LATEST_RECORD_ANT_HEX: &str = concat!(
        "00000010", // ScValType::Vec = 16
        "00000001", // RFC 4506 Option presence flag: Some  ← the flag manual encoders omitted
        "00000002", // vector length = 2
        "0000000f", // ScValType::Symbol = 15
        "0000000c", // "LatestRecord" length = 12
        "4c61746573745265636f7264", // "LatestRecord"
        "0000000f", // ScValType::Symbol = 15
        "00000003", // "ANT" length = 3
        "414e5400", // "ANT" + 1 byte 4-byte alignment padding
    );

    /// The presence flag MUST be `0x00000001` before the vector length —
    /// omitting it makes the parser read the length as the boolean flag.
    #[test]
    fn vec_some_encodes_option_presence_flag() {
        let val = two_symbol_key_val("LatestRecord", "ANT");
        let bytes = val.to_xdr(Limits::none()).unwrap();
        assert_eq!(hex(&bytes), LATEST_RECORD_ANT_HEX);
        assert_eq!(&bytes[..4], &[0, 0, 0, 16], "SCV_VEC discriminant");
        assert_eq!(&bytes[4..8], &[0, 0, 0, 1], "Option::Some flag");
        assert_eq!(&bytes[8..12], &[0, 0, 0, 2], "vector length");
    }

    /// `ScVal::Vec(None)` encodes the discriminant plus a ZERO flag — which
    /// is why writing zeros for an "empty vector" silently parsed as
    /// `Vec(None)` during the baseline investigation.
    #[test]
    fn vec_none_encodes_zero_flag() {
        let bytes = ScVal::Vec(None).to_xdr(Limits::none()).unwrap();
        assert_eq!(bytes.len(), 8);
        assert_eq!(&bytes[..4], &[0, 0, 0, 16], "SCV_VEC discriminant");
        assert_eq!(&bytes[4..8], &[0, 0, 0, 0], "Option::None flag");
        // Round-trips back to Vec(None).
        let mut lim = stellar_xdr::curr::Limited::new(bytes.as_slice(), Limits::none());
        let back = ScVal::read_xdr_to_end(&mut lim).unwrap();
        assert_eq!(back, ScVal::Vec(None));
    }

    /// Every per-asset key variant round-trips byte-exactly through
    /// encode → decode → encode.
    #[test]
    fn symbol_vecs_round_trip_exactly() {
        for (variant, asset) in [
            ("LatestRecord", "ANT"),
            ("AssetPolicy", "ANT"),
            ("AssetStatus", "ANT"),
            ("LastSequence", "SPACE"),
        ] {
            let val = two_symbol_key_val(variant, asset);
            let bytes = val.to_xdr(Limits::none()).unwrap();
            let mut lim = stellar_xdr::curr::Limited::new(bytes.as_slice(), Limits::none());
            let back = ScVal::read_xdr_to_end(&mut lim).unwrap();
            assert_eq!(back, val, "{variant}/{asset}");
            assert_eq!(
                back.to_xdr(Limits::none()).unwrap(),
                bytes,
                "{variant}/{asset} re-encode"
            );
        }
    }

    /// Full `LedgerKey::ContractData` (persistent) round-trip — the exact
    /// object `getLedgerEntries` accepted during the testnet baseline.
    #[test]
    fn ledger_key_contract_data_round_trips() {
        let contract = [0xABu8; 32];
        let key = contract_data_key(contract, "LatestRecord", "ANT");
        let bytes = encode_key(&key);
        let back = decode_key(&bytes);
        assert_eq!(back, key);
        assert_eq!(encode_key(&back), bytes, "re-encode is byte-identical");
        // The embedded ScVal keeps the presence flag at its documented offset:
        // find the SCV_VEC tag inside the LedgerKey wire bytes.
        let pos = bytes
            .windows(4)
            .position(|w| w == [0, 0, 0, 16])
            .expect("SCV_VEC tag present");
        assert_eq!(&bytes[pos + 4..pos + 8], &[0, 0, 0, 1], "Some flag after tag");
    }
}
