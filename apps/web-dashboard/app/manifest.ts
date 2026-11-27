import type { MetadataRoute } from "next";

/**
 * PWA manifest. The console is installable so the identity and operational
 * surfaces can be opened from a home screen without a store listing.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "FurlPay Identity",
    short_name: "FurlPay",
    description: "FurlPay identity, sessions and edge control plane.",
    id: "/",
    start_url: "/",
    scope: "/",
    display: "standalone",
    display_override: ["window-controls-overlay", "standalone"],
    orientation: "portrait-primary",
    background_color: "#0d1117",
    theme_color: "#6c5ce7",
    categories: ["business", "productivity", "security"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      { name: "Sign in", url: "/login", description: "Sign in to FurlPay identity" },
      { name: "Security", url: "/settings", description: "Passkeys, sessions and SSO clients" },
      { name: "Device approval", url: "/activate", description: "Approve a CLI or web sign-in" },
    ],
  };
}
