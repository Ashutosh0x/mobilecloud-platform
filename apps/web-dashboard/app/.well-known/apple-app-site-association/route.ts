import { NextResponse } from "next/server";

/**
 * Apple associated domains for passkeys and universal links.
 *
 * Requires the Apple Developer Team ID and the app bundle identifier. Return
 * 404 when unconfigured; a malformed association is worse than a missing one
 * because iOS caches it.
 */
export async function GET() {
  const teamId = process.env.APPLE_TEAM_ID?.trim();
  const bundleId = process.env.APPLE_BUNDLE_ID?.trim();
  if (!teamId || !bundleId) {
    return NextResponse.json({ error: "Apple app linking is not configured." }, { status: 404 });
  }
  return NextResponse.json(
    {
      webcredentials: { apps: [`${teamId}.${bundleId}`] },
      applinks: { apps: [], details: [] },
    },
    { headers: { "cache-control": "public, max-age=300", "content-type": "application/json" } },
  );
}
