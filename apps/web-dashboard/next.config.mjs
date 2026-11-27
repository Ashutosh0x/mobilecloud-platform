/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  allowedDevOrigins: ["127.0.0.1"],
  async rewrites() {
    // The identity endpoints are implemented by the catch-all API route. These
    // rewrites give them the paths the standards name, so a relying party can
    // be configured with the discovery document alone and never learns that
    // the implementation happens to live under /api.
    return [
      { source: "/.well-known/openid-configuration", destination: "/api/.well-known/openid-configuration" },
      { source: "/.well-known/jwks.json", destination: "/api/.well-known/jwks.json" },
      { source: "/oauth/:path*", destination: "/api/oauth/:path*" },
      { source: "/saml/:path*", destination: "/api/saml/:path*" },
      { source: "/scim/:path*", destination: "/api/scim/:path*" },
    ];
  },
  async headers() {
    return [{
      source: "/:path*",
      headers: [
        { key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'self'; object-src 'none'" },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ...(process.env.NODE_ENV === "production" && process.env.MOBILECLOUD_PUBLIC_ORIGIN?.startsWith("https://")
          ? [{ key: "Strict-Transport-Security", value: "max-age=31536000" }]
          : []),
      ],
    }];
  },
};

export default nextConfig;
