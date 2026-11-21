#!/usr/bin/env bash
# MobileCloud production APK pipeline: Rust NDK cross-compile (16 KB aligned)
# → Gradle release → zipalign 16 KB → apksigner v1–v4 (build manual sections
# 2–9). Run from mobilecloud-platform/. Requires JDK 21, SDK 35, NDK 27,
# Rust 1.82+, cargo-ndk.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ANDROID_HOME="${ANDROID_HOME:?set ANDROID_HOME}"
ANDROID_NDK_HOME="${ANDROID_NDK_HOME:?set ANDROID_NDK_HOME}"
BUILD_TOOLS="$ANDROID_HOME/build-tools/35.0.0"
[[ -x "$BUILD_TOOLS/zipalign" ]] || { echo "build-tools 35.0.0 not found at $BUILD_TOOLS" >&2; exit 1; }

KEYSTORE_PATH="${KEYSTORE_PATH:-$ROOT/mobilecloud-release.jks}"
KEYSTORE_PASSWORD="${KEYSTORE_PASSWORD:?set KEYSTORE_PASSWORD}"
KEY_ALIAS="${KEY_ALIAS:-mobilecloud-key}"
KEY_PASSWORD="${KEY_PASSWORD:?set KEY_PASSWORD}"
OUT_DIR="${OUT_DIR:-$ROOT/dist}"
mkdir -p "$OUT_DIR"

echo "==> [1/6] Generating 4096-bit RSA release keystore (if absent)"
if [[ ! -f "$KEYSTORE_PATH" ]]; then
  keytool -genkeypair -v \
    -keystore "$KEYSTORE_PATH" \
    -alias "$KEY_ALIAS" \
    -keyalg RSA -keysize 4096 -sigalg SHA512withRSA -validity 10000 \
    -storepass "$KEYSTORE_PASSWORD" -keypass "$KEY_PASSWORD" \
    -dname "CN=MobileCloud Authority, OU=Edge Infrastructure, O=FurlPay Global Inc, L=San Francisco, ST=California, C=US"
fi

echo "==> [2/6] Cross-compiling libpor_kernel.so (aarch64, 16 KB pages)"
(
  cd "$ROOT/por-kernel"
  export RUSTFLAGS="-C link-arg=-Wl,-z,max-page-size=16384"
  cargo ndk -t arm64-v8a \
    -o "$ROOT/android-app/app/src/main/jniLibs" \
    build --release
)

echo "==> [3/6] Verifying LOAD segment alignment (must be 0x4000)"
READELF="$ANDROID_NDK_HOME/toolchains/llvm/prebuilt/*/bin/llvm-readelf"
SO=$(find "$ROOT/android-app/app/src/main/jniLibs/arm64-v8a" -name '*.so' | head -n1)
"$READELF" -lW "$SO" | grep -q '0x4000' || {
  echo "FATAL: $SO not 16 KB aligned" >&2; exit 1;
}

echo "==> [4/6] Gradle assembleRelease (R8 + NDK packaging)"
(
  cd "$ROOT/android-app"
  KEYSTORE_PATH="$KEYSTORE_PATH" KEYSTORE_PASSWORD="$KEYSTORE_PASSWORD" \
  KEY_ALIAS="$KEY_ALIAS" KEY_PASSWORD="$KEY_PASSWORD" \
  ./gradlew assembleRelease --stacktrace
)
UNSIGNED="android-app/app/build/outputs/apk/release/app-release-unsigned.apk"
[[ -f "$ROOT/$UNSIGNED" ]] || UNSIGNED="android-app/app/build/outputs/apk/release/app-release.apk"

echo "==> [5/6] zipalign 16 KB page alignment"
"$BUILD_TOOLS/zipalign" -f -P 16 -v 4 "$ROOT/$UNSIGNED" "$OUT_DIR/mobilecloud-release-aligned.apk"

echo "==> [6/6] apksigner v1+v2+v3+v4"
"$BUILD_TOOLS/apksigner" sign \
  --ks "$KEYSTORE_PATH" \
  --ks-key-alias "$KEY_ALIAS" \
  --ks-pass "pass:$KEYSTORE_PASSWORD" \
  --key-pass "pass:$KEY_PASSWORD" \
  --v1-signing-enabled true --v2-signing-enabled true \
  --v3-signing-enabled true --v4-signing-enabled true \
  --out "$OUT_DIR/mobilecloud-release-signed.apk" \
  "$OUT_DIR/mobilecloud-release-aligned.apk"

"$BUILD_TOOLS/apksigner" verify --verbose --print-certs \
  "$OUT_DIR/mobilecloud-release-signed.apk"

echo "==> Signed APK: $OUT_DIR/mobilecloud-release-signed.apk"
echo "    Provision: adb install -r -d -g $OUT_DIR/mobilecloud-release-signed.apk"
