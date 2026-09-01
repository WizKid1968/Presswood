import type { Metadata } from "next";
import { Fraunces, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const fraunces = Fraunces({ subsets: ["latin"], variable: "--font-fraunces" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono" });

export const metadata: Metadata = {
  title: "Presswood — turn any API into a CLI + MCP server",
  description:
    "Drop a HAR, paste a URL, or upload a spec. Get back a built, verified CLI binary, MCP server, and agent skill. Free while in alpha.",
  icons: { icon: "/favicon.svg" },
  openGraph: {
    title: "Presswood",
    description: "Turn any API into a CLI + MCP server your agent can drive.",
    images: ["/og.png"],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${fraunces.variable} ${mono.variable}`}>
      <body className="bg-[#0B1512] text-[#E9F1EB] antialiased">{children}</body>
    </html>
  );
}
