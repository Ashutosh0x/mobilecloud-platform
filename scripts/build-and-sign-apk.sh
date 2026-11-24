#!/usr/bin/env bash
# Console APK: unsigned Gradle build, then align, sign and verify once.
# Requires JDK 17, Android SDK/build-tools 35, NDK 27.1.12297006 and CMake 3.22.1.
# Use an existing release keystore and the independently trusted certificate
# SHA-256 digest (hex, with or without colons). Never generate a new key here.
set +x
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_TOOLS="${ANDROID_HOME:?set ANDROID_HOME}/build-tools/35.0.0"
ZIPALIGN="$BUILD_TOOLS/zipalign"
[[ -x "$ZIPALIGN" ]] || ZIPALIGN="$ZIPALIGN.exe"
APKSIGNER="$BUILD_TOOLS/lib/apksigner.jar"
JAVA="${JAVA_HOME:+$JAVA_HOME/bin/}java"
[[ -x "$ZIPALIGN" && -f "$APKSIGNER" ]] || { printf '%s\n' 'Install Android build-tools 35.0.0.' >&2; exit 1; }

: "${KEYSTORE_PATH:?set KEYSTORE_PATH to an existing release keystore}"
: "${KEYSTORE_PASSWORD:?set KEYSTORE_PASSWORD}"
: "${KEY_ALIAS:?set KEY_ALIAS}"
: "${KEY_PASSWORD:?set KEY_PASSWORD}"
: "${RELEASE_CERT_SHA256:?set RELEASE_CERT_SHA256 to the trusted release certificate digest}"
[[ -f "$KEYSTORE_PATH" && -r "$KEYSTORE_PATH" && -s "$KEYSTORE_PATH" ]] || { printf '%s\n' 'Release keystore missing, empty or unreadable.' >&2; exit 1; }
expected="${RELEASE_CERT_SHA256//:/}"
[[ "$expected" =~ ^[[:xdigit:]]{64}$ ]] || { printf '%s\n' 'Invalid release certificate digest.' >&2; exit 1; }

(
  cd "$ROOT/android-app"
  unset KEYSTORE_PATH KEYSTORE_PASSWORD KEY_ALIAS KEY_PASSWORD RELEASE_CERT_SHA256
  bash ./gradlew --no-daemon :app:assembleRelease
)
UNSIGNED="$ROOT/android-app/app/build/outputs/apk/release/app-release-unsigned.apk"
[[ -s "$UNSIGNED" ]] || { printf '%s\n' 'Expected unsigned release APK not found.' >&2; exit 1; }

OUT_DIR="${OUT_DIR:-$ROOT/dist}"
mkdir -p "$OUT_DIR"
staging="$(mktemp -d "$OUT_DIR/.apk-release.XXXXXXXX")"
trap 'rm -rf -- "$staging"' EXIT
aligned="$staging/aligned.apk"
signed="$staging/mobilecloud-release-signed.apk"

"$ZIPALIGN" -f -P 16 4 "$UNSIGNED" "$aligned"
export KEYSTORE_PASSWORD KEY_PASSWORD
"$JAVA" -jar "$APKSIGNER" sign \
  --ks "$KEYSTORE_PATH" --ks-key-alias "$KEY_ALIAS" \
  --ks-pass env:KEYSTORE_PASSWORD --key-pass env:KEY_PASSWORD \
  --v1-signing-enabled false --v2-signing-enabled true \
  --v3-signing-enabled true --v4-signing-enabled false \
  --out "$signed" "$aligned"
unset KEYSTORE_PASSWORD KEY_PASSWORD

"$ZIPALIGN" -c -P 16 4 "$signed"
certs="$("$JAVA" -jar "$APKSIGNER" verify -Werr --print-certs "$signed")"
digests=()
while IFS= read -r line; do
  line="${line%$'\r'}"
  if [[ "$line" =~ ^Signer\ \#[0-9]+\ certificate\ SHA-256\ digest:\ ([[:xdigit:]]{64})$ ]]; then
    digests+=("${BASH_REMATCH[1],,}")
  fi
done <<< "$certs"
if [[ ${#digests[@]} -ne 1 || "${digests[0]:-}" != "${expected,,}" ]]; then
  printf '%s\n' 'APK signer does not match the trusted release certificate.' >&2
  exit 1
fi

mv -f -- "$signed" "$OUT_DIR/mobilecloud-release-signed.apk"
printf 'Verified release APK: %s\n' "$OUT_DIR/mobilecloud-release-signed.apk"
