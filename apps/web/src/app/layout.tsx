import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";
import { Providers } from "../components/providers";

export const metadata: Metadata = { title: "Agent Reliability Platform", description: "可观测、可评测、可恢复的代码修复 Agent 平台" };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN" className="h-full antialiased"><body className="min-h-full"><Providers><div className="min-h-screen md:flex"><aside className="hidden w- sixty shrink-0 border-r border-[#e9e5de] bg-white md:flex md:w-64 md:flex-col"><div className="px-6 py-7"><div className="text-[11px] font-semibold uppercase tracking-[.18em] text-[#c4673a]">ARP / WORKSPACE</div><div className="mt-2 text-lg font-semibold tracking-tight">Agent Reliability</div><div className="text-xs text-[#78736b]">代码修复可靠性平台</div></div><nav className="space-y-1 px-3 text-sm"><Link href="/tasks" className="block rounded-lg px-3 py-2.5 font-medium hover:bg-[#f3f1ed]">任务工作台</Link><Link href="/evaluations" className="block rounded-lg px-3 py-2.5 font-medium hover:bg-[#f3f1ed]">评测对比</Link></nav><div className="mt-auto border-t border-[#e9e5de] px-6 py-5 text-xs text-[#78736b]">系统运行中<br/><span className="text-[#788c5d]">● API connected</span></div></aside><div className="min-w-0 flex-1"><header className="flex h-16 items-center border-b border-[#e9e5de] bg-white/80 px-5 backdrop-blur md:hidden"><Link href="/tasks" className="font-semibold tracking-tight">Agent Reliability</Link></header><main className="mx-auto w-full max-w-7xl flex-1 px-5 py-8 md:px-10 md:py-10">{children}</main></div></div></Providers></body></html>;
}
