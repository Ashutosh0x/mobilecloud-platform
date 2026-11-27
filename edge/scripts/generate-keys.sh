#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────
#  MobileCloud — Ed25519 Keypair Generator
# ─────────────────────────────────────────────────────────────────
#  Generates an Ed25519 keypair for tunnel authentication.
#  - The PRIVATE key goes into the client config (signing_key).
#  - The PUBLIC  key goes into the relay config (authorized_keys).
#
#  Requirements: openssl >= 1.1.1 (for Ed25519 support)
#
#  Usage:
#    ./scripts/generate-keys.sh
#    ./scripts/generate-keys.sh --out-dir /etc/mobilecloud/keys
# ─────────────────────────────────────────────────────────────────
set -euo pipefail

OUT_DIR="${1:-./keys}"
mkdir -p "$OUT_DIR"

PRIV_PEM="$OUT_DIR/tunnel-ed25519.pem"
PUB_PEM="$OUT_DIR/tunnel-ed25519-pub.pem"
PRIV_HEX="$OUT_DIR/tunnel-signing-key.hex"
PUB_HEX="$OUT_DIR/tunnel-verifying-key.hex"

echo "╔══════════════════════════════════════════════════╗"
echo "║   MobileCloud — Ed25519 Keypair Generator       ║"
echo "╚══════════════════════════════════════════════════╝"
echo

# Generate the Ed25519 private key
openssl genpkey -algorithm ED25519 -out "$PRIV_PEM" 2>/dev/null
echo "✔ Private key PEM: $PRIV_PEM"

# Extract the public key
openssl pkey -in "$PRIV_PEM" -pubout -out "$PUB_PEM" 2>/dev/null
echo "✔ Public key PEM:  $PUB_PEM"

# Extract raw 32-byte private key (seed) as hex
# Ed25519 PEM contains a 48-byte DER wrapper; the last 32 bytes are the seed.
PRIV_RAW=$(openssl pkey -in "$PRIV_PEM" -outform DER 2>/dev/null | tail -c 32 | xxd -p -c 64)
echo "$PRIV_RAW" > "$PRIV_HEX"
echo "✔ Signing key hex: $PRIV_HEX"

# Extract raw 32-byte public key as hex
PUB_RAW=$(openssl pkey -in "$PRIV_PEM" -pubout -outform DER 2>/dev/null | tail -c 32 | xxd -p -c 64)
echo "$PUB_RAW" > "$PUB_HEX"
echo "✔ Verifying key hex: $PUB_HEX"

echo
echo "────────────────────────────────────────────────────"
echo "SIGNING KEY (client config):   $PRIV_RAW"
echo "VERIFYING KEY (relay config):  $PUB_RAW"
echo "────────────────────────────────────────────────────"
echo
echo "⚠  Keep the signing key secret. Never commit it to git."
echo "   Add this to your .gitignore: keys/"
