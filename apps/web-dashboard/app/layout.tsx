import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { Pwa } from "@/components/Pwa";
import { StoreProvider } from "@/lib/store";
import "./globals.css";

// The fonts live inside this package so the console builds from its own
// directory alone: the Docker image, CI and a checkout all resolve them the
// same way, with no dependency on the Android tree.
const sans = localFont({
  variable: "--font-sans",
  src: [
    { path: "../fonts/geist_400.ttf", weight: "400" },
    { path: "../fonts/geist_500.ttf", weight: "500" },
    { path: "../fonts/geist_600.ttf", weight: "600" },
    { path: "../fonts/geist_700.ttf", weight: "700" },
  ],
});
const mono = localFont({ variable: "--font-mono", src: "../fonts/geist_mono_400.ttf" });

export const metadata: Metadata = {
  title: { default: "FurlPay · MobileCloud", template: "%s · FurlPay" },
  description: "FurlPay identity, passkeys, sessions and edge control plane.",
  applicationName: "FurlPay Identity",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [{ url: "/favicon.png", sizes: "64x64", type: "image/png" }],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  appleWebApp: { capable: true, title: "FurlPay", statusBarStyle: "black-translucent" },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#0d1117" },
    { media: "(prefers-color-scheme: light)", color: "#6c5ce7" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // `suppressHydrationWarning` on the root elements: browser extensions that
    // inject attributes into <html> or <body> before React hydrates would
    // otherwise trip a hydration mismatch on every page.
    <html lang="en" suppressHydrationWarning>
      <body className={`${sans.variable} ${mono.variable}`} suppressHydrationWarning>
        <ThemeScript />
        <Pwa />
        <StoreProvider>{children}</StoreProvider>
      </body>
    </html>
  );
}

/**
 * Applies the stored theme before the first paint.
 *
 * Without this the page would render in the default palette and then switch,
 * which is a flash on every load. The script is deliberately tiny and
 * inline: it has to run before the stylesheet paints.
 */
function ThemeScript() {
  const script = `try{var s=localStorage.getItem("mc-theme");var t=s==="light"||s==="dark"?s:(matchMedia("(prefers-color-scheme: light)").matches?"light":"dark");document.documentElement.dataset.theme=t;}catch(e){}`;
  return <script dangerouslySetInnerHTML={{ __html: script }} />;
}
