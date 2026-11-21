# por-xdr-toolkit — Canonical Soroban Storage-Key Encoder/Decoder

Canonical `LedgerKey` construction and verification for FurlPay Proof-of-Reserve
audits. This crate is the **promotion of the frozen baseline reference encoder
`tools/xdrkey`** (retired 2026-11-21) with the same pinned toolchain and four
automated round-trip regression tests pinning the exact RFC 4506 wire layout.

## Why this crate exists

During the 2026-11-21 testnet baseline, hand-rolled Python byte synthesis of
`ScVal::Vec` omitted the 4-byte RFC 4506 `Option<T>` presence flag, so the RPC
parser read the vector length as the boolean flag and aborted
(`cannot unmarshal key value`). These regression tests pin the exact wire
layout so manual-encoding drift can never recur.

## Toolchain pinning

| Dependency   | Version    | Note                                        |
| :----------- | :--------- | :------------------------------------------ |
| `stellar-xdr`| `=22.1.0`  | Frozen audit toolchain (`versions.txt`)     |
| Protocol     | 30         | Endpoint fingerprint: `rpc 30.0.1-6b6ec60c` |

Protocol 30 (`stellar-xdr` 30.x) alignment is a Phase 3 migration; the RFC 4506
invariants tested here are version-independent.

## Library API (`por_xdr_toolkit`)

- `sym(&str)` — build a `Symbol` `ScVal`.
- `two_symbol_key_val(variant, asset)` — `ScVal::Vec(Some([Symbol, Symbol]))`,
  the encoding used by every per-asset `DataKey` tuple variant
  (`LatestRecord`, `AssetPolicy`, `AssetStatus`, …).
- `contract_data_key(hash32, variant, asset)` — persistent
  `LedgerKey::ContractData`.
- `encode_key(&LedgerKey) -> Vec<u8>` / `decode_key(&[u8]) -> LedgerKey` —
  canonical wire bytes (base64-wrap at the JSON-RPC layer).
- `hex(&[u8]) -> String` — lowercase hex rendering.

## CLI (`por-xdr`)

```text
por-xdr key <contract_hash_hex> <variant> <asset> <outfile>
por-xdr decode <raw_entry_bytes_file>
```

`key` writes canonical XDR bytes and performs a decode self-check before
emitting; `decode` parses raw ledger-entry bytes captured from RPC
(`LedgerEntryData`, falling back to `LedgerEntry`).

## Protocol 30 XDR encoding notes (the invariants under test)

1. **`Option<ScVec>` presence flag** — an `ScVal::Vec(Some(..))` encodes as:
   `00000010` (type tag `ScValType::Vec = 16`) **`00000001` (Option::Some
   flag)** then the vector length. Omitting the flag makes the parser read the
   length as the boolean — the exact baseline failure mode.
2. **`ScVal::Vec(None)`** — encodes as the type tag plus a **zero** flag
   (`00000010 00000000`, 8 bytes total). Writing zeros for an "empty vector"
   silently parses as `Vec(None)`.
3. **Symbol alignment** — `ScSymbol` is 4-byte length + ASCII bytes + zero
   padding to a 4-byte boundary (e.g. `"ANT"` → `00000003 414e5400`).
4. **`LedgerKey::ContractData` round-trip** — encode → decode → encode is
   byte-identical for every per-asset key variant; the embedded `ScVal` keeps
   its presence flag at the documented offset inside the key wire bytes.

## Tests

```text
cargo test   # 4 tests, standalone crate (excluded from the platform workspace)
```

- `vec_some_encodes_option_presence_flag` — golden wire layout from the audit
  byte-comparison table (`LatestRecord`/`ANT`).
- `vec_none_encodes_zero_flag` — 8-byte `Vec(None)` layout + round-trip.
- `symbol_vecs_round_trip_exactly` — byte-exact round-trip across all
  per-asset key variants.
- `ledger_key_contract_data_round_trips` — full persistent
  `LedgerKey::ContractData` round-trip with flag-offset assertion.

## Reference

- Audit baseline: `audit/TESTNET_BASELINE_2026-11-21/` (`versions.txt`,
  `state/key_crate.b64`, `endpoint/fingerprint.txt`).
- Baseline report: Protocol 30 XDR compatibility & independent PoR
  verification report, §3.2 (byte-comparison table).
