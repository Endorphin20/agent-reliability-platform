"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import {
  fetchJson,
  type AgentKind,
  type Fixture,
  type TaskListItem,
} from "../../lib/api";
import { AgentBadge, StatusBadge } from "../../components/status-badge";
import { ErrorCard } from "../../components/error-card";

export default function TasksPage() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const tasks = useQuery({
    queryKey: ["tasks"],
    queryFn: () => fetchJson<TaskListItem[]>("/api/tasks"),
    refetchInterval: 4000,
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold">修复任务</h1>
          <p className="mt-1 text-sm text-zinc-500">
            创建任务后由 Agent 在 Docker 沙箱内诊断修复，经 V1–V6 门禁与 LLM Judge 后进入人工审批
          </p>
        </div>
        <button
          onClick={() => setDialogOpen(true)}
          className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700"
        >
          新建任务
        </button>
      </div>

      {tasks.isLoading && <ListSkeleton />}
      {tasks.isError && (
        <ErrorCard message={String(tasks.error)} onRetry={() => tasks.refetch()} />
      )}
      {tasks.data && tasks.data.length === 0 && (
        <div className="rounded-xl border border-dashed border-zinc-300 bg-white p-12 text-center">
          <p className="text-zinc-500">还没有任务</p>
          <button
            onClick={() => setDialogOpen(true)}
            className="mt-3 text-sm font-medium text-blue-600 hover:underline"
          >
            创建第一个修复任务 →
          </button>
        </div>
      )}
      {tasks.data && tasks.data.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500">
              <tr>
                <th className="px-4 py-3">任务</th>
                <th className="px-4 py-3">状态</th>
                <th className="px-4 py-3">Runs</th>
                <th className="px-4 py-3">审批 / PR</th>
                <th className="px-4 py-3">创建时间</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {tasks.data.map((task) => (
                <tr key={task.id} className="hover:bg-zinc-50">
                  <td className="px-4 py-3">
                    <div className="font-medium">{task.title}</div>
                    <div className="text-xs text-zinc-400">{task.fixtureId}</div>
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={task.status} />
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-col gap-1">
                      {task.runs.map((run) => (
                        <Link
                          key={run.id}
                          href={`/runs/${run.id}`}
                          className="flex items-center gap-2 text-xs hover:underline"
                        >
                          <AgentBadge kind={run.agentKind} />
                          <StatusBadge status={run.status} />
                        </Link>
                      ))}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-xs">
                    {task.approval ? (
                      task.approval.prUrl ? (
                        <a
                          href={task.approval.prUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="text-blue-600 hover:underline"
                        >
                          PR ↗
                        </a>
                      ) : task.approval.status === "PENDING" ? (
                        <Link
                          href={`/runs/${task.runs[0]?.id}/review`}
                          className="font-medium text-violet-600 hover:underline"
                        >
                          待审批 →
                        </Link>
                      ) : (
                        <StatusBadge status={task.approval.status} />
                      )
                    ) : (
                      <span className="text-zinc-400">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs text-zinc-500">
                    {new Date(task.createdAt).toLocaleString("zh-CN")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {dialogOpen && <CreateTaskDialog onClose={() => setDialogOpen(false)} />}
    </div>
  );
}

function CreateTaskDialog({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const [fixtureId, setFixtureId] = useState("");
  const [agentKind, setAgentKind] = useState<AgentKind>("SELF_LANGGRAPH");
  const [dualAgent, setDualAgent] = useState(false);

  const fixtures = useQuery({
    queryKey: ["fixtures"],
    queryFn: () => fetchJson<Fixture[]>("/api/fixtures"),
  });

  const create = useMutation({
    mutationFn: async () => {
      const kinds: AgentKind[] = dualAgent
        ? ["SELF_LANGGRAPH", "MINI_SWE"]
        : [agentKind];
      for (const kind of kinds) {
        await fetchJson("/api/tasks", {
          method: "POST",
          body: JSON.stringify({ fixtureId, agentKind: kind }),
        });
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["tasks"] });
      onClose();
    },
  });

  const selectable = (fixtures.data ?? []).filter((f) => f.id !== "fake");

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
      <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl">
        <h2 className="text-lg font-bold">新建修复任务</h2>
        <div className="mt-4 space-y-4">
          <label className="block text-sm">
            <span className="mb-1 block font-medium">Fixture 任务</span>
            <select
              value={fixtureId}
              onChange={(e) => setFixtureId(e.target.value)}
              className="w-full rounded-lg border border-zinc-300 px-3 py-2"
            >
              <option value="">选择任务…</option>
              {selectable.map((f) => (
                <option key={f.id} value={f.id}>
                  [{f.category}] {f.id} — {f.title}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={dualAgent}
              onChange={(e) => setDualAgent(e.target.checked)}
            />
            双 Agent 对比（同时创建自研 + mini-SWE 两个 Run）
          </label>
          {!dualAgent && (
            <label className="block text-sm">
              <span className="mb-1 block font-medium">Agent</span>
              <select
                value={agentKind}
                onChange={(e) => setAgentKind(e.target.value as AgentKind)}
                className="w-full rounded-lg border border-zinc-300 px-3 py-2"
              >
                <option value="SELF_LANGGRAPH">自研 LangGraph Agent</option>
                <option value="MINI_SWE">mini-SWE-agent（对照）</option>
              </select>
            </label>
          )}
          {create.isError && (
            <p className="text-xs text-red-600">{String(create.error)}</p>
          )}
        </div>
        <div className="mt-6 flex justify-end gap-3">
          <button
            onClick={onClose}
            className="rounded-lg px-4 py-2 text-sm text-zinc-600 hover:bg-zinc-100"
          >
            取消
          </button>
          <button
            disabled={!fixtureId || create.isPending}
            onClick={() => create.mutate()}
            className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-40"
          >
            {create.isPending ? "创建中…" : "创建"}
          </button>
        </div>
      </div>
    </div>
  );
}

function ListSkeleton() {
  return (
    <div className="space-y-2">
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-16 animate-pulse rounded-xl bg-zinc-200/60" />
      ))}
    </div>
  );
}
