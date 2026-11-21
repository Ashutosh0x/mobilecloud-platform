# Frozen Testnet Transaction ↔ Sequence ↔ Event ↔ Digest Map

Network: Stellar Testnet (`Test SDF Network ; September 2015`) · Protocol 30
Contract: `CDWNCMD6NG652YNX5PV2VLAWW4HMJGFICVE55NSDMSPS76H2VSLOEDPI`
WASM hash (from on-chain instance entry): `8ebcebc32894d39cbd50867249952f8fb0d9b04e6ae1251ccf34c26aad013648`

## Included (state-advancing) transactions — 6 total

| Test | Tx hash | Ledger | Attestation seq | Ratio (bps) | Committed status | Event value (ScVal) |
|---|---|---|---|---|---|---|
| T1  | `be1bfa72b9dade9336ec909b81cd70faed15834529c2fd2dbdcebd053deb86cd` | 5847205 | 2 | 10000 | HEALTHY  | `u32(10000)` |
| T4  | `4b2da72657385e20fde709f6f6835e6edc8776054985be2aa5e22eab0d402f56` | 5847300 | 3 | 10000 | HEALTHY  | `u32(10000)` |
| T9  | `a663e33cbdf778e6457189a3179b31465a40b630be1f7776ee61266eb90df0d7` | 5847359 | 4 | 9700  | CRITICAL | `u32(9700)`  |
| T10 | `361501d7d3cb387585749ea66b979c4e28a2ba5b6d1d47921659436fc68c0100` | 5847376 | 5 | 9970  | WARNING  | `u32(9970)`  |
| T11 | `5746c9c134433679a3371e549dcc208ace6d16fbb20900ed3f35c254f9fb6c26` | 5847380 | 6 | 9300  | CRITICAL | `u32(9300)`  |
| T12 | `431ca87ec53d7933434169c6df3fccded0a653663c0affc7fc2a6c760ff45191` | 5847384 | 7 | 10000 | HEALTHY  | `u32(10000)` |

Sequences are **contiguous 2→7** across the six included transactions (sequence 1 was
consumed by the initial deployment-phase attestation; see FP-ENG report §1.1).

## Rejected (pre-flight simulation, zero on-chain effect) — 6 total

| Test | Attack | Rejection (HostError) |
|---|---|---|
| T2 | Sequence replay (seq 2 resubmit) | `Error(Contract, #5)` InvalidSequenceNumber |
| T3 | 2-of-5 quorum (below threshold) | `Error(Contract, #4)` ThresholdNotMet |
| T5 | Forged signature (1-byte corruption) | `Error(Crypto, InvalidInput)` |
| T6 | Foreign (unregistered) signer | `Error(Contract, #2)` UnauthorizedSigner |
| T7 | Descending signer order | `Error(Contract, #3)` SignerOrderInvalid |
| T8 | Expired attestation window | `Error(Contract, #6)` AttestationExpired |

## Final frozen state (audit close, ledger 5847384)

- `LatestRecord(ANT)`: seq 7, epoch 1795260507, valid_until 1795267707 (+7200 s),
  reserves = supply = 10^24 (u128 hi=54210, lo=2003764205206896640), ratio 10000, HEALTHY
- `AssetStatus(ANT)`: HEALTHY
- Entry TTL: lastModified 5847384 → liveUntil 5957979 (110,595 ledgers ≈ 6.4 days —
  deployed WASM predates the 120-day source constants; see FP-ENG §6.5)

## Cryptographic binding (reproducible via `crypto/verify_baseline.py`)

preimage(62B) = `"FURLPAY_POR_V1"` ‖ seq u64-BE ‖ epoch u64-BE ‖ reserves u128-BE ‖ supply u128-BE
SHA-256 → `e825ef9dfd79611ff7458a236534b83ce427d3c73b2c46b0938c1a550da1ea77`
Quorum: 3/5 signatures RFC 8032 VALID, keys ⊆ on-chain Signers registry, ascending order.
