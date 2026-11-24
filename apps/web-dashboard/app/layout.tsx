import type { Metadata } from "next";
import localFont from "next/font/local";
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
  title: "MobileCloud",
  description: "Sovereign Android edge cloud — dashboard and node console.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={`${sans.variable} ${mono.variable}`}>
        <StoreProvider>{children}</StoreProvider>
      </body>
    </html>
  );
}
