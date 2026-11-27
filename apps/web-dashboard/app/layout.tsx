import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { Pwa } from "@/components/Pwa";
import { StoreProvider } from "@/lib/store";
import "./globals.css";

const sans = localFont({
  variable: "--font-sans",
  src: [
    { path: "../../../android-app/app/src/main/res/font/geist_400.ttf", weight: "400" },
    { path: "../../../android-app/app/src/main/res/font/geist_500.ttf", weight: "500" },
    { path: "../../../android-app/app/src/main/res/font/geist_600.ttf", weight: "600" },
    { path: "../../../android-app/app/src/main/res/font/geist_700.ttf", weight: "700" },
  ],
});
const mono = localFont({ variable: "--font-mono", src: "../../../android-app/app/src/main/res/font/geist_mono_400.ttf" });

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
    <html lang="en">
      <body className={`${sans.variable} ${mono.variable}`}>
        <Pwa />
        <StoreProvider>{children}</StoreProvider>
      </body>
    </html>
  );
}
