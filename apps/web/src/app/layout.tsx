import type { Metadata } from "next";
import Link from "next/link";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Providers } from "../components/providers";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Agent Reliability Platform",
  description: "可观测、可评测、可恢复的代码修复 Agent 平台",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="zh-CN"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-zinc-50 text-zinc-900">
        <Providers>
          <header className="border-b border-zinc-200 bg-white">
            <div className="mx-auto flex h-14 max-w-6xl items-center gap-8 px-6">
              <Link href="/tasks" className="text-sm font-bold tracking-tight">
                Agent Reliability Platform
              </Link>
              <nav className="flex gap-5 text-sm text-zinc-600">
                <Link href="/tasks" className="hover:text-zinc-900">
                  任务
                </Link>
                <Link href="/evaluations" className="hover:text-zinc-900">
                  评测对比
                </Link>
              </nav>
            </div>
          </header>
          <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-8">{children}</main>
        </Providers>
      </body>
    </html>
  );
}
