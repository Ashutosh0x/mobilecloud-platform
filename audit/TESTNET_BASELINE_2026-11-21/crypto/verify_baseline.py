#!/usr/bin/env python3
"""Self-contained frozen-baseline verifier for the FurlPay ANT PoR testnet audit.

Verifies, using ONLY artifacts inside this bundle (no network, no Rust code):
  1. SHA-256 domain-separated digest recomputed from the frozen on-chain record.
  2. All 3-of-5 Ed25519 quorum signatures via a from-scratch RFC 8032 implementation.
  3. Quorum keys are a subset of the on-chain signer registry, ascending, count >= threshold.

Run:  python -I verify_baseline.py   (from this crypto/ directory)
"""
import base64
import hashlib
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))

# ---- frozen on-chain record (decoded from state/entry0.bin, ledger 5847384) ----
RECORD = {
    "asset_symbol": "ANT",
    "sequence_number": 7,
    "epoch_timestamp": 1795260507,
    "valid_until": 1795267707,
    "verified_reserves": 10**24,   # u128 hi=54210 lo=2003764205206896640
    "onchain_supply": 10**24,      # u128 hi=54210 lo=2003764205206896640
    "calculated_ratio_bps": 10000,
    "status": "HEALTHY",
}
# ---- on-chain signer registry (decoded from state/instance_entry.bin) ----
SIGNER_REGISTRY = [
    "06da5f1bd68470c2ce00b2f6015db12d91ef3c416a2cdfa36b1f8659640e7365",
    "35917340e8affe67aa36a6e8877e5abf07dc181bea8fb27fcf2aa2777cafd9dd",
    "92da3bcb4cff435df27d147932bd1750cdd5a8e860ce7ed52b1885a374d2a5ea",
    "a2ffcd076976bea744ba5e588bbb4bcfa83f53dec5f05534bf20bf670d7f135e",
    "f5aabb24e5365df0267e67e64174ce7d1c0846824144e4fd5dfb447b9c972c1a",
]
THRESHOLD = 3

# ---- RFC 8032 Ed25519 (from scratch) ----
P = 2**255 - 19


def _inv(x):
    return pow(x, P - 2, P)


D = -121665 * _inv(121666) % P
_I = pow(2, (P - 1) // 4, P)


def _xrecover(y):
    xx = (y * y - 1) * _inv(D * y * y + 1)
    x = pow(xx, (P + 3) // 8, P)
    if (x * x - xx) % P != 0:
        x = x * _I % P
    if x % 2 != 0:
        x = P - x
    return x


_BY = 4 * _inv(5) % P
_B = [_xrecover(_BY), _BY]


def _add(p, q):
    x1, y1 = p
    x2, y2 = q
    return [(x1 * y2 + x2 * y1) * _inv(1 + D * x1 * x2 * y1 * y2) % P,
            (y1 * y2 + x1 * x2) * _inv(1 - D * x1 * x2 * y1 * y2) % P]


def _mul(point, scalar):
    q = [0, 1]
    for bit in bin(scalar)[2:]:
        q = _add(q, q)
        if bit == "1":
            q = _add(q, point)
    return q


def _decodepoint(s):
    y = int.from_bytes(s, "little") & ((1 << 255) - 1)
    x = _xrecover(y)
    if x & 1 != (s[31] >> 7) & 1:
        x = P - x
    point = [x, y]
    assert (-x * x + y * y - 1 - D * x * x * y * y) % P == 0
    return point


def ed25519_verify(sig, msg, pk):
    r_point = _decodepoint(sig[:32])
    a_point = _decodepoint(pk)
    s = int.from_bytes(sig[32:], "little")
    h = int.from_bytes(hashlib.sha512(sig[:32] + pk + msg).digest(), "little")
    return _mul(_B, s) == _add(r_point, _mul(a_point, h))


def main():
    rec = RECORD
    # 1. canonical preimage: "FURLPAY_POR_V1" || seq(u64 BE) || epoch(u64 BE)
    #    || reserves(u128 BE, 16B) || supply(u128 BE, 16B)  -> 62 bytes
    preimage = (b"FURLPAY_POR_V1"
                + rec["sequence_number"].to_bytes(8, "big")
                + rec["epoch_timestamp"].to_bytes(8, "big")
                + rec["verified_reserves"].to_bytes(16, "big")
                + rec["onchain_supply"].to_bytes(16, "big"))
    assert len(preimage) == 62
    digest = hashlib.sha256(preimage).digest()
    print(f"preimage ({len(preimage)}B): {preimage.hex()}")
    print(f"digest           : {digest.hex()}")
    with open(os.path.join(HERE, "digest_preimage.txt"), "w") as f:
        f.write(f"layout: 'FURLPAY_POR_V1'(14B) || seq u64-BE(8B) || epoch u64-BE(8B) "
                f"|| reserves u128-BE(16B) || supply u128-BE(16B) = 62 bytes\n")
        f.write(f"preimage_hex: {preimage.hex()}\n")
        f.write(f"sha256_digest: {digest.hex()}\n")

    # 2. quorum verification against the frozen quorum file
    quorum = json.load(open(os.path.join(HERE, "quorum_seq7.json")))
    signers = quorum["signers"]
    pks = [s["public_key"] for s in signers]
    print(f"\nquorum: {len(signers)} signers | ascending: {pks == sorted(pks)}")
    all_ok = True
    for s in signers:
        ok = ed25519_verify(bytes.fromhex(s["signature"]), digest, bytes.fromhex(s["public_key"]))
        all_ok &= ok
        print(f"  pk {s['public_key']}  RFC8032: {'VALID' if ok else 'INVALID'}")

    # 3. registry membership + threshold
    subset = set(pks) <= set(SIGNER_REGISTRY)
    print(f"\nquorum keys subset of on-chain Signers registry: {subset}")
    print(f"registry size: {len(SIGNER_REGISTRY)} | on-chain threshold: {THRESHOLD} "
          f"| valid sigs: {len(signers)} >= threshold: {len(signers) >= THRESHOLD}")

    verdict = all_ok and subset and len(signers) >= THRESHOLD and pks == sorted(pks)
    print(f"\nFROZEN BASELINE VERIFICATION: {'ALL CHECKS PASS' if verdict else 'FAIL'}")
    return 0 if verdict else 1


if __name__ == "__main__":
    raise SystemExit(main())
