//! CLI front-end for the canonical PoR storage-key encoder/decoder
//! (promotion of the frozen baseline tool `tools/xdrkey`, same pinned
//! `stellar-xdr =22.1.0` toolchain — see `versions.txt` in the audit baseline).
//!
//! Usage:
//!   por-xdr key   <contract_hash_hex> <variant> <asset> <outfile>
//!   por-xdr decode <raw_entry_bytes_file>
//!
//! `key` writes the canonical `LedgerKey::ContractData` (persistent) XDR
//! bytes for `ScVal::Vec([Symbol(variant), Symbol(asset)])` — the exact
//! encoding accepted by `getLedgerEntries` during the 2026-11-21 testnet
//! baseline. `decode` accepts raw ledger-entry bytes (as captured from RPC)
//! and prints the parsed `LedgerEntryData` (falling back to `LedgerEntry`).

use por_xdr_toolkit::{contract_data_key, decode_key, encode_key, hex};
use stellar_xdr::curr::{LedgerEntry, LedgerEntryData, Limits, ReadXdr};
use std::io::Cursor;

fn hex_decode(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 3 {
        eprintln!("usage: por-xdr key <hash_hex> <variant> <asset> <outfile> | decode <file>");
        std::process::exit(2);
    }
    match args[1].as_str() {
        "key" => {
            if args.len() != 6 {
                eprintln!("usage: por-xdr key <hash_hex> <variant> <asset> <outfile>");
                std::process::exit(2);
            }
            let hb = hex_decode(&args[2]);
            let contract: [u8; 32] = hb.try_into().expect("contract hash must be 32 bytes");
            let key = contract_data_key(contract, &args[3], &args[4]);
            let bytes = encode_key(&key);
            // Self-check: the encoder and decoder must agree before we emit.
            assert_eq!(decode_key(&bytes), key, "round-trip self-check");
            println!("key bytes: {} | b64-ready | {}", bytes.len(), hex(&bytes));
            std::fs::write(&args[5], bytes).unwrap();
        }
        "decode" => {
            let bytes = std::fs::read(&args[2]).unwrap();
            let mut lim = stellar_xdr::curr::Limited::new(Cursor::new(bytes.clone()), Limits::none());
            match LedgerEntryData::read_xdr_to_end(&mut lim) {
                Ok(d) => println!("LedgerEntryData: {d:?}"),
                Err(e) => {
                    let mut lim2 =
                        stellar_xdr::curr::Limited::new(Cursor::new(bytes), Limits::none());
                    match LedgerEntry::read_xdr_to_end(&mut lim2) {
                        Ok(le) => println!("LedgerEntry: {le:?}"),
                        Err(e2) => {
                            eprintln!("decode failed (not LedgerEntryData/LedgerEntry bytes): {e} | {e2}");
                            std::process::exit(1);
                        }
                    }
                }
            }
        }
        _ => {
            eprintln!("mode must be key|decode");
            std::process::exit(2);
        }
    }
}
