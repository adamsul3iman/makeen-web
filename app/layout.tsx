import type { Metadata, Viewport } from "next";
import { Tajawal, Geist_Mono } from "next/font/google";
import { ServiceWorkerRegister } from "@/components/pwa/ServiceWorkerRegister";
import AuthGate from "@/components/AuthGate";
import "./globals.css";

const tajawal = Tajawal({
  variable: "--font-tajawal",
  subsets: ["arabic"],
  weight: ["400", "500", "700", "800", "900"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  applicationName: "MAKEEN POS",
  title: "MAKEEN — نظام نقاط البيع",
  description: "نظام نقاط البيع MAKEEN (مَكِين) — إدارة المبيعات والمخزون والكاشير",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "MAKEEN POS",
    statusBarStyle: "black-translucent",
  },
  formatDetection: {
    telephone: false,
  },
  other: {
    "mobile-web-app-capable": "yes",
  },
  icons: {
    icon: [
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
};

export const viewport: Viewport = {
  themeColor: "#22c55e",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="ar"
      dir="rtl"
      className={`${tajawal.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full">
        <AuthGate>{children}</AuthGate>
        <ServiceWorkerRegister />
      </body>
    </html>
  );
}
