import { NextResponse } from "next/server";

/**
 * Android app/domain binding for passkeys and app links.
 *
 * Configure the package and signing-certificate SHA-256 values from the Play
 * signing key (or the upload key for local builds). A wrong fingerprint makes
 * Google Password Manager refuse to offer FurlPay passkeys in the app, so this
 * endpoint returns 404 rather than an empty or fabricated statement when the
 * deployment is not configured.
 */
export async function GET() {
  const packageName = process.env.ANDROID_PACKAGE_NAME?.trim();
  const fingerprints = (process.env.ANDROID_CERT_SHA256 ?? "")
    .split(",")
    .map((value) => value.trim().toUpperCase())
    .filter((value) => /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(value));
  if (!packageName || fingerprints.length === 0) {
    return NextResponse.json({ error: "Android app linking is not configured." }, { status: 404 });
  }
  return NextResponse.json(
    [
      {
        relation: ["delegate_permission/common.handle_all_urls", "delegate_permission/common.get_login_creds"],
        target: {
          namespace: "android_app",
          package_name: packageName,
          sha256_cert_fingerprints: fingerprints,
        },
      },
    ],
    { headers: { "cache-control": "public, max-age=300" } },
  );
}
