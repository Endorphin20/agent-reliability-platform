'use client';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchJson } from '../lib/api';

const phases: Record<string, string> = { APPROVED: '交付中', PR_CREATED: '修复 PR 已创建', PR_FAILED: '交付失败', RESOLVED: '补丁已交付', REJECTED: '修复已拒绝', AWAITING_APPROVAL: '待审批', FAILED: '失败', QUEUED: '排队', PREPARING: '环境准备', REPRODUCING: '失败复现', BASELINE: '基线已记录', REPAIRING: '修复', VERIFYING: '验证', NEEDS_ATTENTION: '需要人工处理', CANCELLED: '已取消' };
export function RunControls({ runId }: { runId: string }) {
  const cache = useQueryClient(); const [error, setError] = useState('');
  const query = useQuery({ queryKey: ['run-control', runId], queryFn: () => fetchJson<{ status: string; phase: string; imageId: string | null; baseCommit: string;
    task: { status: string; attentionReason: string | null; snapshot: unknown }; artifacts: { id: string; name: string; kind: string }[] }>(`/api/runs/${runId}`), refetchInterval: 3000 });
  const run = query.data;
  if (!run?.task.snapshot) return null;
  const phase = ['APPROVED', 'PR_CREATED', 'PR_FAILED', 'RESOLVED', 'REJECTED'].includes(run.task.status) ? run.task.status : run.phase;
  async function act(action: string) { try { setError(''); await fetchJson(`/api/runs/${runId}/${action}`, { method: 'POST' }); await cache.invalidateQueries({ queryKey: ['run-control', runId] }); } catch (err) { setError(String(err)); } }
  return <section className="space-y-3 rounded-lg border bg-white p-4 text-sm"><p className="font-medium">当前阶段：{phases[phase] || phase} · {run.status}</p>
    <p className="break-all font-mono text-xs">代码：{run.baseCommit}<br />环境：{run.imageId || '尚未准备'}</p>
    {run.task.attentionReason && <p role="alert">暂停原因：{run.task.attentionReason}</p>}
    <div className="flex gap-4">{run.status === 'RUNNING' && <button className="underline" onClick={() => void act('pause')}>暂停执行</button>}{run.status === 'INTERRUPTED' && <button className="underline" onClick={() => void act('resume')}>按原契约恢复</button>}
      {!['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(run.status) && <button className="underline" onClick={() => void act('cancel')}>取消执行</button>}
      <a href={`/tasks/new?reviseRun=${runId}`} className="underline">调整验收并创建新任务</a></div>
    {error && <p role="alert" className="text-red-700">{error}</p>}
    <ul className="space-y-2">{run.artifacts.map((a) => <li key={a.id}><button className="underline" onClick={async () => {
      const artifact = await fetchJson<{ content: string }>(`/api/runs/${runId}/artifacts/${a.id}`);
      const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob([artifact.content], { type: 'text/plain' })); link.download = a.name; link.click(); URL.revokeObjectURL(link.href);
    }}>{a.kind} · {a.name}</button></li>)}</ul>
  </section>;
}
