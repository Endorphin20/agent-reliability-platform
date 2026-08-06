"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { use, useMemo, useState } from "react";
import {
  fetchJson,
  type RunDetail,
  type TraceEvent,
} from "../../../lib/api";
import { useRunEvents } from "../../../lib/use-run-events";
import { AgentBadge, StatusBadge } from "../../../components/status-badge";
import { ErrorCard } from "../../../components/error-card";

const EVENT_ICONS: Record<string, string> = {
  MODEL_CALL: "🧠",
  TOOL_CALL: "🔧",
  FILE_CHANGE: "📝",
  COMMAND_EXEC: "💻",
  STATE_TRANSITION: "🔀",
  CHECKPOINT_SAVED: "💾",
  FAILURE_DETECTED: "❌",
  RECOVERY_ACTION: "🛟",
  VERIFICATION_RESULT: "🛡️",
  APPROVAL_EVENT: "✅",
  BUDGET_UPDATE: "📊",
};

// Attempt 分段着色（恢复轨迹带）
const ATTEMPT_COLORS = [
  "border-blue-300 bg-blue-50/40",
  "border-orange-300 bg-orange-50/40",
  "border-violet-300 bg-violet-50/40",
  "border-teal-300 bg-teal-50/40",
];

export default function RunTimelinePage({
  params,
}: {
  params: Promise<{ runId: string }>;
}) {
  const { runId } = use(params);
  const [selected, setSelected] = useState<TraceEvent | null>(null);
  const { disconnected, retry } = useRunEvents(runId);

  const run = useQuery({
    queryKey: ["run", runId],
    queryFn: () => fetchJson<RunDetail>(`/api/runs/${runId}`),
    refetchInterval: (query) =>
      ["SUCCEEDED", "FAILED", "CANCELLED"].includes(query.state.data?.status ?? "")
        ? false
        : 5000,
  });

  // 初始加载走 JSON 列表，之后 SSE 增量合并进同一个 query cache
  const events = useQuery({
    queryKey: ["run-events", runId],
    queryFn: () => fetchJson<TraceEvent[]>(`/api/runs/${runId}/events`),
    staleTime: Infinity,
  });

  const budget = useMemo(() => {
    const updates = (events.data ?? []).filter((e) => e.type === "BUDGET_UPDATE");
    const last = updates[updates.length - 1]?.payload as
      | { usedTokens?: number; usedTurns?: number }
      | undefined;
    return last ?? null;
  }, [events.data]);

  // 按 attemptId 分段（恢复轨迹带）：段间边界显示 failureCode + Policy action
  const segments = useMemo(() => {
    const list = events.data ?? [];
    const result: { attemptId: string | null; events: TraceEvent[] }[] = [];
    for (const event of list) {
      const last = result[result.length - 1];
      if (last && last.attemptId === event.attemptId) {
        last.events.push(event);
      } else {
        result.push({ attemptId: event.attemptId, events: [event] });
      }
    }
    return result;
  }, [events.data]);

  const attemptNoById = useMemo(() => {
    const map = new Map<string, number>();
    for (const attempt of run.data?.attempts ?? []) map.set(attempt.id, attempt.no);
    return map;
  }, [run.data]);

  if (run.isLoading) {
    return <div className="h-64 animate-pulse rounded-xl bg-zinc-200/60" />;
  }
  if (run.isError) {
    return <ErrorCard message={String(run.error)} onRetry={() => run.refetch()} />;
  }
  const detail = run.data!;

  return (
    <div className="space-y-5">
      {disconnected && (
        <div className="flex items-center justify-between rounded-lg border border-red-300 bg-red-50 px-4 py-2 text-sm text-red-700">
          实时连接中断，时间线可能滞后
          <button onClick={retry} className="font-medium underline">
            重试连接
          </button>
        </div>
      )}
      {detail.status === "RECOVERING" && (
        <div className="rounded-lg border border-orange-300 bg-orange-50 px-4 py-2 text-sm text-orange-800">
          🛟 平台正在从最近的检查点恢复此 Run…
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-bold">Run 时间线</h1>
        <AgentBadge kind={detail.agentKind} />
        <StatusBadge status={detail.status} />
        <span className="font-mono text-xs text-zinc-400">{runId}</span>
        <div className="ml-auto flex gap-3">
          <Link
            href={`/runs/${runId}/review`}
            className="rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-zinc-50"
          >
            审批 / 结果 →
          </Link>
        </div>
      </div>

      {/* 预算条 */}
      <div className="grid grid-cols-3 gap-4">
        <BudgetBar
          label="Tokens"
          used={budget?.usedTokens ?? detail.usedTokens}
          total={detail.budgetTokens}
        />
        <BudgetBar label="时间 (s)" used={detail.usedSeconds} total={detail.budgetSeconds} />
        <BudgetBar
          label="轮次"
          used={(budget?.usedTurns as number) ?? 0}
          total={detail.budgetTurns}
        />
      </div>

      {/* 恢复轨迹带 + 时间线 */}
      {events.isLoading && <div className="h-40 animate-pulse rounded-xl bg-zinc-200/60" />}
      {events.data && (
        <div className="space-y-4">
          {segments.map((segment, index) => {
            const attemptNo = segment.attemptId
              ? (attemptNoById.get(segment.attemptId) ?? "?")
              : null;
            const color =
              ATTEMPT_COLORS[
                ((typeof attemptNo === "number" ? attemptNo : 1) - 1) %
                  ATTEMPT_COLORS.length
              ];
            const attempt = detail.attempts.find((a) => a.id === segment.attemptId);
            const decision = detail.policyDecisions.find(
              (d) => d.attemptId === segment.attemptId,
            );
            return (
              <div key={index} className={`rounded-xl border-l-4 ${color} p-1`}>
                {attemptNo !== null && (
                  <div className="flex items-center gap-2 px-3 py-1.5 text-xs font-semibold text-zinc-600">
                    Attempt #{attemptNo}
                    {attempt?.failureCode && (
                      <span className="rounded bg-red-100 px-1.5 py-0.5 font-mono text-red-700">
                        {attempt.failureCode}
                      </span>
                    )}
                    {decision && (
                      <span className="rounded bg-orange-100 px-1.5 py-0.5 font-mono text-orange-700">
                        Policy → {decision.action}
                      </span>
                    )}
                  </div>
                )}
                <ul className="divide-y divide-zinc-100 rounded-lg bg-white">
                  {segment.events.map((event) => (
                    <li
                      key={event.runSequence}
                      onClick={() => setSelected(event)}
                      className="flex cursor-pointer items-center gap-3 px-4 py-2 text-sm hover:bg-zinc-50"
                    >
                      <span className="w-6 text-center">
                        {EVENT_ICONS[event.type] ?? "•"}
                      </span>
                      <span className="w-10 font-mono text-xs text-zinc-400">
                        #{event.runSequence}
                      </span>
                      <span className="w-44 font-mono text-xs font-medium text-zinc-700">
                        {event.type}
                      </span>
                      <span className="flex-1 truncate text-xs text-zinc-500">
                        {eventSummary(event)}
                      </span>
                      <span className="text-[11px] text-zinc-400">
                        {new Date(event.occurredAt).toLocaleTimeString("zh-CN")}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      )}

      {/* 事件详情抽屉 */}
      {selected && (
        <div
          className="fixed inset-0 z-50 flex justify-end bg-black/20"
          onClick={() => setSelected(null)}
        >
          <div
            className="h-full w-full max-w-lg overflow-auto bg-white p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h2 className="font-bold">
                {EVENT_ICONS[selected.type]} {selected.type} #{selected.runSequence}
              </h2>
              <button
                onClick={() => setSelected(null)}
                className="text-zinc-400 hover:text-zinc-700"
              >
                ✕
              </button>
            </div>
            <p className="mt-1 text-xs text-zinc-400">
              {new Date(selected.occurredAt).toLocaleString("zh-CN")} · attemptSeq{" "}
              {selected.attemptSequence}
            </p>
            <pre className="mt-4 overflow-auto rounded-lg bg-zinc-900 p-4 text-xs leading-relaxed text-zinc-100">
              {JSON.stringify(selected.payload, null, 2)}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

function eventSummary(event: TraceEvent): string {
  const p = event.payload as Record<string, unknown>;
  switch (event.type) {
    case "MODEL_CALL":
      return `${p.model} · ${p.promptTokens}+${p.completionTokens} tok · ${p.latencyMs}ms · turn ${p.turn}`;
    case "TOOL_CALL": {
      const args = p.args as Record<string, unknown> | undefined;
      const suffix = p.error
        ? ` ⛔ ${String(p.error).slice(0, 80)}`
        : p.cached ? " [cached]" : "";
      return `${p.tool}(${JSON.stringify(args ?? {}).slice(0, 80)})${suffix}`;
    }
    case "COMMAND_EXEC":
      return `${String(p.command).slice(0, 60)} → exit ${p.exitCode}`;
    case "FILE_CHANGE": {
      const stat = p.diffStat as { additions?: number; deletions?: number } | undefined;
      return `${p.changeType} ${p.path} (+${stat?.additions ?? 0}/-${stat?.deletions ?? 0})`;
    }
    case "STATE_TRANSITION":
      return `${p.entity}: ${p.from} → ${p.to}`;
    case "CHECKPOINT_SAVED":
      return `checkpoint ${String(p.checkpointId).slice(-8)} · ${p.usedTokens} tok`;
    case "FAILURE_DETECTED":
      return `${p.failureCode}: ${String(p.message).slice(0, 80)}`;
    case "RECOVERY_ACTION":
      return `${p.action} → attempt #${p.newAttemptNo}`;
    case "VERIFICATION_RESULT":
      return `${p.step} ${p.passed ? "✓ 通过" : `✗ ${p.failureCode ?? "失败"}`}`;
    case "APPROVAL_EVENT":
      return `${p.status}${p.prUrl ? ` · ${p.prUrl}` : ""}`;
    case "BUDGET_UPDATE":
      return `${p.usedTokens} tok · ${p.usedSeconds}s · ${p.usedTurns} turns`;
    default:
      return JSON.stringify(p).slice(0, 80);
  }
}

function BudgetBar({
  label,
  used,
  total,
}: {
  label: string;
  used: number;
  total: number;
}) {
  const ratio = Math.min(1, total > 0 ? used / total : 0);
  const color =
    ratio > 0.9 ? "bg-red-500" : ratio > 0.7 ? "bg-amber-500" : "bg-emerald-500";
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4">
      <div className="flex justify-between text-xs text-zinc-500">
        <span>{label}</span>
        <span>
          {used.toLocaleString()} / {total.toLocaleString()}
        </span>
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-zinc-100">
        <div className={`h-full ${color}`} style={{ width: `${ratio * 100}%` }} />
      </div>
    </div>
  );
}
