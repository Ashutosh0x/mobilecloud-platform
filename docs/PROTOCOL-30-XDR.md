# Protocol 30 XDR Compatibility — Wire-Format Invariants

Status: `DEPLOYED` (Protocol 30 endpoint fingerprint `rpc 30.0.1-6b6ec60c`;
frozen toolchain `stellar-xdr =22.1.0`, `soroban-sdk 22.0.11`).

## Why a whole document exists for one flag

During the 2026-11-21 testnet baseline, a hand-rolled Python byte synthesis of
`ScVal::Vec` omitted the 4-byte RFC 4506 `Option<T>` presence flag. The RPC
parser then read the **vector length as the boolean flag** and aborted with
`cannot unmarshal key value`. The corrected encoder produced byte-exact keys
that the live endpoint accepted. The invariants below are pinned by automated
tests so this class of drift can never recur.

## The golden wire layout

`ScVal::Vec(Some([Symbol("LatestRecord"), Symbol("ANT")]))` — the exact bytes
accepted by `getLedgerEntries` (test: `vec_some_encodes_option_presence_flag`):

```text
00000010  ScValType::Vec = 16
00000001  RFC 4506 Option presence flag: Some   ← the flag manual encoders omit
00000002  vector length = 2
0000000f  ScValType::Symbol = 15
0000000c  "LatestRecord" length = 12
4c61746573745265636f7264  "LatestRecord"
0000000f  ScValType::Symbol = 15
00000003  "ANT" length = 3
414e5400  "ANT" + 1 byte zero padding (4-byte alignment)
```

## The four invariants under test (`tools/por-xdr-toolkit`, 4/4 pass)

1. **`Option<ScVec>` presence flag** — `Some` encodes `0x00000001` *before*
   the vector length; omitting it corrupts the parse.
2. **`ScVal::Vec(None)`** — encodes the type tag plus a **zero** flag
   (8 bytes: `00000010 00000000`). Writing zeros for an "empty vector"
   silently parses as `Vec(None)`.
3. **Symbol alignment** — 4-byte length + ASCII + zero padding to a 4-byte
   boundary.
4. **`LedgerKey::ContractData` round-trip** — encode → decode → encode is
   byte-identical for every per-asset key variant (`LatestRecord`,
   `AssetPolicy`, `AssetStatus`, `LastSequence`), with the presence flag at
   its documented offset inside the key bytes.

## Tooling

- `tools/por-xdr-toolkit` — canonical encoder/decoder library + `por-xdr` CLI
  (`key` / `decode`), standalone crate pinned to `stellar-xdr =22.1.0`,
  excluded from the platform workspace (same discipline as the frozen
  baseline tool `tools/xdrkey`, which it supersedes).
- README: `tools/por-xdr-toolkit/README.md`.

## Version posture

Protocol 30 (`stellar-xdr` 30.x) alignment is a Phase 3 migration item; the
RFC 4506 invariants tested here are version-independent. Toolchain fingerprint
and offline-build discipline are frozen in
`audit/TESTNET_BASELINE_2026-11-21/versions.txt`.
