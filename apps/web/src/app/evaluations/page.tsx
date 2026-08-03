"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import {
  fetchJson,
  type EvaluationDetail,
  type EvaluationRun,
} from "../../lib/api";
import { AgentBadge } from "../../components/status-badge";
import { ErrorCard } from "../../components/error-card";

export default function EvaluationsPage() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const evaluations = useQuery({
    queryKey: ["evaluations"],
    queryFn: () => fetchJson<EvaluationRun[]>("/api/evaluations"),
    refetchInterval: 10000,
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold">评测对比</h1>
        <p className="mt-1 text-sm text-zinc-500">
          arp-eval 批次结果：自研 LangGraph Agent vs mini-SWE-agent（12 个 fixture 任务）；
          恢复成功率按恢复粒度分组 —— checkpoint 恢复（自研）与 attempt 级重启（mini-SWE）不直接横比
        </p>
      </div>

      {evaluations.isLoading && (
        <div className="h-40 animate-pulse rounded-xl bg-zinc-200/60" />
      )}
      {evaluations.isError && (
        <ErrorCard
          message={String(evaluations.error)}
          onRetry={() => evaluations.refetch()}
        />
      )}
      {evaluations.data && evaluations.data.length === 0 && (
        <div className="rounded-xl border border-dashed border-zinc-300 bg-white p-12 text-center text-sm text-zinc-500">
          还没有评测批次。运行
          <code className="mx-1 rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-xs">
            arp-eval run --suite fixture-12 --agent self
          </code>
          生成第一批数据。
        </div>
      )}

      {evaluations.data && evaluations.data.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500">
              <tr>
                <th className="px-4 py-3">批次</th>
                <th className="px-4 py-3">Agent</th>
                <th className="px-4 py-3">故障注入</th>
                <th className="px-4 py-3 text-right">解决率</th>
                <th className="px-4 py-3 text-right">首试成功</th>
                <th className="px-4 py-3 text-right">恢复成功</th>
                <th className="px-4 py-3 text-right">均值 tokens</th>
                <th className="px-4 py-3 text-right">成本</th>
                <th className="px-4 py-3 text-right">Judge</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {evaluations.data.map((evaluation) => (
                <tr
                  key={evaluation.id}
                  onClick={() =>
                    setSelectedId(selectedId === evaluation.id ? null : evaluation.id)
                  }
                  className={`cursor-pointer hover:bg-zinc-50 ${
                    selectedId === evaluation.id ? "bg-blue-50/50" : ""
                  }`}
                >
                  <td className="px-4 py-3">
                    <div className="font-medium">{evaluation.suite}</div>
                    <div className="text-xs text-zinc-400">
                      {new Date(evaluation.startedAt).toLocaleString("zh-CN")}
                      {!evaluation.finishedAt && " · 进行中…"}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <AgentBadge kind={evaluation.agentKind} />
                  </td>
                  <td className="px-4 py-3">
                    {evaluation.faultInjection ? (
                      <span className="rounded bg-orange-100 px-1.5 py-0.5 font-mono text-[11px] text-orange-700">
                        {evaluation.faultInjection}
                      </span>
                    ) : (
                      <span className="text-xs text-zinc-400">无</span>
                    )}
                  </td>
                  <Metric value={evaluation.summary?.resolveRate} format="percent" bold />
                  <Metric value={evaluation.summary?.firstTrySuccessRate} format="percent" />
                  <Metric value={evaluation.summary?.recoveredRate} format="percent" />
                  <Metric value={evaluation.summary?.avgTokens} format="int" />
                  <Metric value={evaluation.summary?.totalCostUsd} format="usd" />
                  <Metric value={evaluation.summary?.avgJudgeScore} format="score" />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selectedId && <EvaluationDetailPanel id={selectedId} />}
    </div>
  );
}

function Metric({
  value,
  format,
  bold,
}: {
  value: number | null | undefined;
  format: "percent" | "int" | "usd" | "score";
  bold?: boolean;
}) {
  let text = "—";
  if (value !== null && value !== undefined) {
    if (format === "percent") text = `${(value * 100).toFixed(0)}%`;
    if (format === "int") text = value.toLocaleString();
    if (format === "usd") text = `$${value.toFixed(2)}`;
    if (format === "score") text = value.toFixed(2);
  }
  return (
    <td className={`px-4 py-3 text-right tabular-nums ${bold ? "font-bold" : ""}`}>
      {text}
    </td>
  );
}

function EvaluationDetailPanel({ id }: { id: string }) {
  const detail = useQuery({
    queryKey: ["evaluation", id],
    queryFn: () => fetchJson<EvaluationDetail>(`/api/evaluations/${id}`),
  });

  if (detail.isLoading) {
    return <div className="h-40 animate-pulse rounded-xl bg-zinc-200/60" />;
  }
  if (detail.isError || !detail.data) return null;
  const rows = detail.data.results;

  return (
    <div className="overflow-hidden rounded-xl border border-blue-200 bg-white">
      <div className="border-b border-zinc-100 bg-blue-50/50 px-4 py-2 text-sm font-medium">
        批次明细 · {detail.data.suite} · <AgentBadge kind={detail.data.agentKind} />
      </div>
      <table className="w-full text-sm">
        <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500">
          <tr>
            <th className="px-4 py-2">fixture</th>
            <th className="px-4 py-2">解决</th>
            <th className="px-4 py-2">首试</th>
            <th className="px-4 py-2">恢复</th>
            <th className="px-4 py-2">恢复粒度</th>
            <th className="px-4 py-2 text-right">越界</th>
            <th className="px-4 py-2 text-right">tokens</th>
            <th className="px-4 py-2 text-right">成本</th>
            <th className="px-4 py-2 text-right">耗时</th>
            <th className="px-4 py-2 text-right">Judge</th>
            <th className="px-4 py-2" />
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-100">
          {rows.map((row) => {
            const scores = row.judgeScores?.criteria?.map((c) => c.score) ?? [];
            const judgeAvg = scores.length
              ? (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1)
              : "—";
            return (
              <tr key={row.id} className="hover:bg-zinc-50">
                <td className="px-4 py-2 font-mono text-xs">{row.fixtureId}</td>
                <td className="px-4 py-2">{row.resolved ? "✅" : "❌"}</td>
                <td className="px-4 py-2">{row.firstTrySuccess ? "✅" : "—"}</td>
                <td className="px-4 py-2">
                  {row.recovered === null ? "—" : row.recovered ? "✅" : "❌"}
                </td>
                <td className="px-4 py-2">
                  {row.recoveryMode ? (
                    <span
                      className={`rounded px-1.5 py-0.5 font-mono text-[11px] ${
                        row.recoveryMode === "checkpoint"
                          ? "bg-blue-50 text-blue-700"
                          : "bg-fuchsia-50 text-fuchsia-700"
                      }`}
                    >
                      {row.recoveryMode}
                    </span>
                  ) : (
                    <span className="text-xs text-zinc-400">—</span>
                  )}
                </td>
                <td className="px-4 py-2 text-right tabular-nums">{row.scopeViolations}</td>
                <td className="px-4 py-2 text-right tabular-nums">
                  {row.tokens.toLocaleString()}
                </td>
                <td className="px-4 py-2 text-right tabular-nums">
                  ${Number(row.costUsd).toFixed(3)}
                </td>
                <td className="px-4 py-2 text-right tabular-nums">{row.wallSeconds}s</td>
                <td className="px-4 py-2 text-right tabular-nums">{judgeAvg}</td>
                <td className="px-4 py-2 text-right">
                  <Link
                    href={`/runs/${row.runId}`}
                    className="text-xs text-blue-600 hover:underline"
                  >
                    时间线 →
                  </Link>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
