# Audit Evidence — Integrity Manifests, Verification Scripts & Commit Anchors

Status: `DEPLOYED` evidence + reproducible verification. Everything here can
be re-executed by anyone.

## Commit anchors

| Anchor | SHA |
| :--- | :--- |
| Sources, specs, toolkit, audit baseline (commit 1) | `31d3e7160c0a466c608ab3cfa8bf8dce71f17072` |
| Documentation set + integrity manifest + versions.txt (commit 2) | recorded in root `versions.txt` after this commit |

## Integrity sealing

```bash
# repo-wide (26 snapshots + contract sources + Cargo manifests + docs set)
sha256sum -c INTEGRITY_MANIFEST.sha256

# the release contract binaries, verified against a local release build
cargo build -p por-verifier --target wasm32-unknown-unknown --release
sha256sum -c audit/RELEASE_WASM.sha256

# frozen 2026-11-21 testnet baseline (crypto/, endpoint/, events/, state/, …)
cd audit/TESTNET_BASELINE_2026-11-21 && sha256sum -c MANIFEST.sha256
```

`INTEGRITY_MANIFEST.sha256` (repo root) seals: all 26 regression snapshots
(`contracts/por-verifier/test_snapshots/test/`), contract sources
(`lib.rs`, `storage.rs`, `errors.rs`, `test.rs`), root `Cargo.toml` +
`Cargo.lock`, `tools/por-xdr-toolkit` sources, the `specs/` set, and this
documentation set.

The release contract binaries are sealed separately, in
`audit/RELEASE_WASM.sha256`. They are build outputs under `target/`, which
git ignores, so they cannot be committed and CI cannot verify them on a clean
checkout; their digests are pinned to the release they shipped in and checked
against a local release build.

## Independent cryptographic verification (pure Python, zero shared code)

`audit/TESTNET_BASELINE_2026-11-21/crypto/verify_baseline.py` — an
RFC 8032 Ed25519 verifier written from scratch (no Rust, no crypto
libraries). Re-run against the frozen quorum record:

```bash
python -I audit/TESTNET_BASELINE_2026-11-21/crypto/verify_baseline.py
```

Verified result (seq 7, ledger 5,847,384):

- Digest recomputed byte-for-byte:
  `e825ef9dfd79611ff7458a236534b83ce427d3c73b2c46b0938c1a550da1ea77`
- 3/5 quorum signatures **VALID**, keys ⊆ on-chain registry, ascending order.

Digest preimage (62 bytes): `"FURLPAY_POR_V1" ‖ seq u64-BE ‖ epoch u64-BE ‖
reserves u128-BE ‖ supply u128-BE`.

## XDR tooling regression tests

```bash
cd tools/por-xdr-toolkit && cargo test   # 4/4 pass
```

Pins: `Option<ScVec>` presence flag (`0x00000001`/`0x00000000`),
`ScVal::Vec(None)` layout, symbol-vector round-trips, `LedgerKey::ContractData`
byte-identical round-trips (see PROTOCOL-30-XDR.md).

## Test corpus facts (recounted 2026-11-21)

- **107 workspace tests**: 16 `core-engine`, 23 `por-verifier`, 58
  `por-kernel`, 10 `trading-engine`.
- **26 snapshots**: 17 baseline (byte-identical) + 9 Gate 7
  (`g7_def_01`, `g7_set_01`, `g7_set_02`, `g7_auth_01`, `g7_val_01`,
  `g7_val_02`, `g7_val_03`, `g7_reg_02`, `g7_reg_03`).
- Zero secret keys: strict `S[AV-Z0-9]{55}` scan — 0 hits.

## Frozen baseline contents

`audit/TESTNET_BASELINE_2026-11-21/`:

| Path | Contents |
| :--- | :--- |
| `transactions.md` | tx ↔ seq ↔ event ↔ digest map (T1–T12) |
| `crypto/` | digest preimage, quorum record (seq 7), verifier + its output |
| `endpoint/` | network/version/fingerprint (Protocol 30, rpc 30.0.1) |
| `events/` | raw `POR_AUDIT` event dump (6 events) |
| `state/` | raw RPC ledger-entry bytes + decoded records |
| `versions.txt` | frozen toolchain fingerprint |
| `MANIFEST.sha256` | per-file SHA-256 sealing of the above |

## Audit trail

- Pre-publication audit & remediation record:
  `specs/FP-ENG-2026-AUD-01.md` (all P0/P1/P2 items closed same day).
- Corrected engineering specs: `specs/FP-ENG-2026-DOC-01.md` (rev 2.0),
  `specs/FP-ENG-2026-QRP-01.md` (rev 2.0).
