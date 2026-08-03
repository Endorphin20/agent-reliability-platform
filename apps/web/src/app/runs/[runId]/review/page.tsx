"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { use } from "react";
import { Diff, Hunk, parseDiff } from "react-diff-view";
import "react-diff-view/style/index.css";
import {
  fetchJson,
  type JudgeReport,
  type RunDetail,
  type TaskListItem,
  type VerificationResult,
} from "../../../../lib/api";
import { AgentBadge, StatusBadge } from "../../../../components/status-badge";
import { ErrorCard } from "../../../../components/error-card";

const STEP_NAMES: Record<string, string> = {
  V1: "补丁形态",
  V2: "改动范围",
  V3: "静态检查",
  V4: "定向测试",
  V5: "回归测试",
  V6: "作弊检测",
};

export default function ReviewPage({
  params,
}: {
  params: Promise<{ runId: string }>;
}) {
  const { runId } = use(params);
  const queryClient = useQueryClient();

  const run = useQuery({
    queryKey: ["run", runId],
    queryFn: () => fetchJson<RunDetail>(`/api/runs/${runId}`),
  });
  const task = useQuery({
    queryKey: ["task", run.data?.taskId],
    queryFn: () => fetchJson<TaskListItem>(`/api/tasks/${run.data!.taskId}`),
    enabled: !!run.data?.taskId,
    refetchInterval: 5000,
  });
  const diff = useQuery({
    queryKey: ["run-diff", runId],
    queryFn: () =>
      fetchJson<{ name: string; content: string }>(`/api/runs/${runId}/diff`),
    retry: false,
  });
  const judge = useQuery({
    queryKey: ["run-judge", runId],
    queryFn: () => fetchJson<JudgeReport>(`/api/runs/${runId}/judge`),
    retry: false,
  });

  const decide = useMutation({
    mutationFn: (decision: "APPROVED" | "REJECTED") =>
      fetchJson(`/api/approvals/${task.data!.approval!.id}/decide`, {
        method: "POST",
        body: JSON.stringify({ decision, reviewer: "reviewer@local" }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["task", run.data?.taskId] });
      void queryClient.invalidateQueries({ queryKey: ["tasks"] });
    },
  });
  const retryPr = useMutation({
    mutationFn: () =>
      fetchJson(`/api/approvals/${task.data!.approval!.id}/retry-pr`, {
        method: "POST",
      }),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: ["task", run.data?.taskId] }),
  });

  if (run.isLoading) {
    return <div className="h-64 animate-pulse rounded-xl bg-zinc-200/60" />;
  }
  if (run.isError) {
    return <ErrorCard message={String(run.error)} onRetry={() => run.refetch()} />;
  }
  const detail = run.data!;
  const approval = task.data?.approval ?? null;
  const files = diff.data ? parseDiff(diff.data.content) : [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-bold">修复审批</h1>
        <AgentBadge kind={detail.agentKind} />
        <StatusBadge status={detail.status} />
        {task.data && <StatusBadge status={task.data.status} />}
        <Link
          href={`/runs/${runId}`}
          className="ml-auto rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-zinc-50"
        >
          ← 时间线
        </Link>
      </div>

      {/* 审批操作区 */}
      {approval && (
        <div className="rounded-xl border border-zinc-200 bg-white p-4">
          {approval.status === "PENDING" && (
            <div className="flex items-center gap-4">
              <p className="flex-1 text-sm text-zinc-600">
                V1–V6 门禁已通过。请核对 diff 与 Judge 评分后决定是否创建修复 PR。
              </p>
              <button
                onClick={() => decide.mutate("REJECTED")}
                disabled={decide.isPending}
                className="rounded-lg border border-red-300 px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-40"
              >
                拒绝
              </button>
              <button
                onClick={() => decide.mutate("APPROVED")}
                disabled={decide.isPending}
                className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-40"
              >
                批准并创建 PR
              </button>
            </div>
          )}
          {approval.status === "APPROVED" && approval.prUrl && (
            <p className="text-sm">
              ✅ 已批准，PR：
              <a
                href={approval.prUrl}
                target="_blank"
                rel="noreferrer"
                className="ml-1 font-medium text-blue-600 hover:underline"
              >
                {approval.prUrl}
              </a>
            </p>
          )}
          {approval.status === "APPROVED" && !approval.prUrl && (
            <div className="flex items-center gap-4">
              <div className="flex-1 text-sm text-zinc-600">
                已批准，PR 创建中或失败{task.data?.status === "PR_FAILED" && "（PR_FAILED）"}
                {approval.prError && (
                  <p className="mt-1 font-mono text-xs text-red-600">{approval.prError}</p>
                )}
              </div>
              {task.data?.status === "PR_FAILED" && (
                <button
                  onClick={() => retryPr.mutate()}
                  disabled={retryPr.isPending}
                  className="rounded-lg border border-zinc-300 px-4 py-2 text-sm font-medium hover:bg-zinc-50"
                >
                  重试创建 PR
                </button>
              )}
            </div>
          )}
          {approval.status === "REJECTED" && (
            <p className="text-sm text-red-600">已拒绝此修复。</p>
          )}
          {decide.isError && (
            <p className="mt-2 text-xs text-red-600">{String(decide.error)}</p>
          )}
        </div>
      )}
      {!approval && detail.status !== "SUCCEEDED" && (
        <div className="rounded-xl border border-dashed border-zinc-300 bg-white p-6 text-sm text-zinc-500">
          此 Run 尚未通过验证门禁（状态 {detail.status}），暂无待审批内容。
        </div>
      )}

      {/* Verifier 六步结果卡（IM-02 可解释性） */}
      <section>
        <h2 className="mb-3 text-sm font-bold text-zinc-700">Verifier 六步门禁</h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
          {(["V1", "V2", "V3", "V4", "V5", "V6"] as const).map((step) => {
            const results = detail.verificationResults.filter((v) => v.step === step);
            const latest = results[results.length - 1];
            return <VerifierCard key={step} step={step} result={latest} />;
          })}
        </div>
      </section>

      {/* Judge 逐条分数 */}
      <section>
        <h2 className="mb-3 text-sm font-bold text-zinc-700">
          LLM Judge 评分
          {judge.data && (
            <span className="ml-2 font-normal text-zinc-400">
              独立模型 {judge.data.model} · 不否决，仅供审批参考
            </span>
          )}
        </h2>
        {judge.isLoading && <div className="h-20 animate-pulse rounded-xl bg-zinc-200/60" />}
        {judge.isError && (
          <p className="rounded-xl border border-dashed border-zinc-300 bg-white p-4 text-sm text-zinc-500">
            暂无 Judge 报告（Run 未成功或 Judge 未配置）
          </p>
        )}
        {judge.data && (
          <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white">
            <ul className="divide-y divide-zinc-100">
              {judge.data.criteria.map((item, index) => (
                <li key={index} className="flex items-start gap-4 px-4 py-3">
                  <ScorePill score={item.score} />
                  <div className="flex-1">
                    <p className="text-sm font-medium">{item.criterion}</p>
                    <p className="mt-0.5 text-xs text-zinc-500">{item.rationale}</p>
                  </div>
                </li>
              ))}
            </ul>
            {judge.data.overallComment && (
              <p className="border-t border-zinc-100 bg-zinc-50 px-4 py-3 text-xs text-zinc-600">
                总评：{judge.data.overallComment}
              </p>
            )}
          </div>
        )}
      </section>

      {/* Diff 视图 */}
      <section>
        <h2 className="mb-3 text-sm font-bold text-zinc-700">
          最终补丁 {diff.data && <span className="font-mono font-normal text-zinc-400">{diff.data.name}</span>}
        </h2>
        {diff.isError && (
          <p className="rounded-xl border border-dashed border-zinc-300 bg-white p-4 text-sm text-zinc-500">
            暂无补丁工件
          </p>
        )}
        {files.map((file) => (
          <div
            key={`${file.oldPath}-${file.newPath}`}
            className="mb-4 overflow-hidden rounded-xl border border-zinc-200 bg-white"
          >
            <div className="border-b border-zinc-100 bg-zinc-50 px-4 py-2 font-mono text-xs">
              {file.type === "delete" ? file.oldPath : file.newPath}
            </div>
            <div className="overflow-x-auto text-xs">
              <Diff viewType="unified" diffType={file.type} hunks={file.hunks}>
                {(hunks) => hunks.map((hunk) => <Hunk key={hunk.content} hunk={hunk} />)}
              </Diff>
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}

function VerifierCard({
  step,
  result,
}: {
  step: string;
  result: VerificationResult | undefined;
}) {
  return (
    <div
      className={`rounded-xl border p-3 ${
        !result
          ? "border-zinc-200 bg-white opacity-60"
          : result.passed
            ? "border-emerald-200 bg-emerald-50/50"
            : "border-red-200 bg-red-50/50"
      }`}
    >
      <div className="flex items-center justify-between">
        <span className="text-sm font-bold">
          {step} {STEP_NAMES[step]}
        </span>
        <span className="text-sm">{!result ? "—" : result.passed ? "✅" : "❌"}</span>
      </div>
      {result && (
        <>
          <p className="mt-1 text-[11px] text-zinc-500">{result.durationMs}ms</p>
          {result.failureCode && (
            <p className="mt-1 font-mono text-[11px] text-red-600">{result.failureCode}</p>
          )}
          {!result.passed && (
            <pre className="mt-2 max-h-28 overflow-auto rounded bg-white/80 p-2 text-[10px] leading-snug text-zinc-600">
              {JSON.stringify(result.detail, null, 1).slice(0, 600)}
            </pre>
          )}
        </>
      )}
    </div>
  );
}

function ScorePill({ score }: { score: number }) {
  const color =
    score >= 4
      ? "bg-emerald-100 text-emerald-800"
      : score >= 3
        ? "bg-amber-100 text-amber-800"
        : "bg-red-100 text-red-800";
  return (
    <span
      className={`mt-0.5 inline-flex h-7 w-10 items-center justify-center rounded-full text-sm font-bold ${color}`}
    >
      {score}
    </span>
  );
}
