'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { fetchJson } from '../../../lib/api';
import { defaultConfig, lines, type Repository } from '../../../lib/repository';
import { ConfigForm, inputClass } from '../../../components/repository-config-form';

interface PrInfo {
  title: string; description: string; headSha: string; baseSha: string; headBranch: string;
  checks: { id: number; name: string; sha: string; summary: string; text: string; url: string }[];
  files: { filename: string; status: string; patch?: string }[]; warning: string;
  runs?: { id: number; name: string; attempt: number; conclusion: string; createdAt: string }[];
}
export default function NewTask() {
  const router = useRouter();
  const repos = useQuery({ queryKey: ['repositories'], queryFn: () => fetchJson<Repository[]>('/api/repositories') });
  const [parentTaskId, setParentTaskId] = useState<string | undefined>();
  const [repositoryId, setRepository] = useState('');
  const [config, setConfig] = useState(defaultConfig);
  const [url, setUrl] = useState(''); const [pr, setPr] = useState<PrInfo | null>(null);
  const [jobs, setJobs] = useState<{ id: number; name: string; conclusion: string }[]>([]);
  const [log, setLog] = useState('');
  const [title, setTitle] = useState(''); const [description, setDescription] = useState('');
  const [sha, setSha] = useState(''); const [targetBranch, setTargetBranch] = useState('');
  const [command, setCommand] = useState('python -m pytest -q'); const [expected, setExpected] = useState('');
  const [agent, setAgent] = useState('SELF_LANGGRAPH'); const [tokens, setTokens] = useState(200000);
  const [seconds, setSeconds] = useState(900); const [attempts, setAttempts] = useState(3);
  const [delivery, setDelivery] = useState('patch'); const [confirmed, setConfirmed] = useState(false);
  const [keepPinned, setKeepPinned] = useState(false);
  const [draft, setDraft] = useState<{ id: string; revision: number; key: string } | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const revise = params.get('reviseRun');
    if (revise) {
      void fetchJson<{ task: { id: string; snapshot: { repositoryId: string; config: typeof config; title: string; description: string; executionSha: string; baseline: { command: string; expected: string[] }; delivery: { targetBranch: string } } } }>(`/api/runs/${encodeURIComponent(revise)}`).then(({ task }) => {
        const s = task.snapshot; setParentTaskId(task.id); setRepository(s.repositoryId); setConfig(s.config);
        setTitle(s.title); setDescription(s.description); setSha(s.executionSha); setCommand(s.baseline.command);
        setExpected(s.baseline.expected.join('\n')); setTargetBranch(s.delivery.targetBranch);
      }).catch((err) => setError(String(err)));
    } else {
      const id = params.get('repositoryId');
      if (id) void fetchJson<Repository>(`/api/repositories/${encodeURIComponent(id)}`).then((selected) => {
        setRepository(selected.id); setConfig(selected.configs[0].config); setDelivery(selected.configs[0].config.defaultDelivery || 'patch'); setCommand(selected.configs[0].config.failToPass[0] || ''); setTargetBranch(selected.defaultBranch); setDelivery(selected.configs[0].config.defaultDelivery || 'patch');
      }).catch((err) => setError(String(err)));
    }
  }, []);
  const repo = repos.data?.find((r) => r.id === repositoryId);
  async function perform(action: () => Promise<void>) {
    setBusy(true); setError(''); try { await action(); } catch (err) { setError(String(err)); } finally { setBusy(false); }
  }
  return <section className="space-y-6"><h1 className="text-xl font-semibold">从失败检查创建修复任务</h1>
    <p className="text-sm text-zinc-600">导入 PR 或手工填写失败证据。确认后固定代码版本，后台先复现，再修复。</p>
    {repos.error && <p role="alert">{String(repos.error)} <Link href="/settings" className="underline">本机登录</Link></p>}
    {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-red-700">{error}</p>}
    {!draft ? <form className="space-y-5 rounded-xl border bg-white p-6" onSubmit={(e) => { e.preventDefault(); void perform(async () => {
      const result = await fetchJson<{ id: string; revision: number }>('/api/drafts', { method: 'POST', body: JSON.stringify({
        schemaVersion: 2, mode: 'REAL', repositoryId, ...(parentTaskId ? { parentTaskId } : {}), configVersion: repo?.configs[0].version,
        executionSha: sha, agentKind: agent, title, description, config,
        baseline: { command, expected: lines(expected) }, budget: { tokens, seconds, turns: 30, maxAttempts: attempts },
        delivery: { kind: delivery, targetBranch, expectedTargetSha: sha },
        ...(pr ? { source: { prUrl: url, headSha: pr.headSha, baseSha: pr.baseSha, ciSha: null, evidence: JSON.stringify({ expected, log: log.slice(-60000), checks: pr.checks.map(({ id, name, sha, url }) => ({ id, name, sha, url })), files: pr.files.map(({ filename, status }) => ({ filename, status })) }).slice(0, 100000) } } : {}),
      }) }); setDraft({ ...result, key: crypto.randomUUID() });
    }); }}>
      <label className="block">仓库<select required className={inputClass} value={repositoryId} onChange={(e) => {
        setRepository(e.target.value); setPr(null);
        const selected = repos.data?.find((r) => r.id === e.target.value);
        if (selected) { setConfig(selected.configs[0].config); setDelivery(selected.configs[0].config.defaultDelivery || 'patch'); setCommand(selected.configs[0].config.failToPass[0] || selected.configs[0].config.staticCheck[0] || ''); setTargetBranch(selected.defaultBranch); }
      }}><option value="">请选择已接入的仓库</option>{repos.data?.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>
      <Link href="/repositories" className="text-sm underline">接入新的仓库</Link>
      <label className="block">PR URL（可选）<input type="url" className={inputClass} value={url} onChange={(e) => { setUrl(e.target.value); setPr(null); }} /></label>
      <button type="button" disabled={!repositoryId || !url || busy} className="rounded-lg border px-4 py-2 disabled:opacity-40" onClick={() => void perform(async () => {
        const result = await fetchJson<PrInfo>('/api/drafts/import-pr', { method: 'POST', body: JSON.stringify({ repositoryId, url }) });
        setPr(result); setTitle(result.title); setDescription(result.description); setSha(result.headSha); setTargetBranch(result.headBranch);
      })}>读取 PR 与失败检查</button>
      {pr && <div className="space-y-3 rounded-lg bg-zinc-50 p-4"><p>已导入 {pr.files.length} 个变更文件、{pr.checks.length} 个失败检查。请核对检查命令和失败标识；CI 合并提交与源提交可能不同。</p>
        <label className="block">选择 CI 运行版本<select className={inputClass} defaultValue="" onChange={(e) => void perform(async () => {
          const run = pr.runs?.find((r) => String(r.id) === e.target.value); if (!run) return;
          const result = await fetchJson<{ jobs: typeof jobs }>('/api/drafts/workflow-jobs', { method: 'POST', body: JSON.stringify({ repositoryId, runId: run.id, attempt: run.attempt }) }); setJobs(result.jobs); setLog('');
        })}><option value="">选择工作流运行</option>{pr.runs?.map((r) => <option key={r.id} value={r.id}>{r.name} · 第 {r.attempt} 次 · {r.conclusion} · {r.createdAt}</option>)}</select></label>
        {jobs.map((j) => <button key={j.id} type="button" className="mr-3 underline" onClick={() => void perform(async () => {
          const result = await fetchJson<{ log: string }>('/api/drafts/job-log', { method: 'POST', body: JSON.stringify({ repositoryId, jobId: j.id }) }); setLog(result.log);
          const tests = [...result.log.matchAll(/FAILED\s+(\S+::\S+)/g)].map((match) => match[1]);
          if (tests.length) setExpected([...new Set(tests)].join('\n'));
        })}>{j.name}（{j.conclusion}）读取日志</button>)}
        {log && <details open><summary>失败日志（请核对自动提取的测试标识）</summary><pre className="max-h-72 overflow-auto whitespace-pre-wrap text-xs">{log}</pre></details>}
        {pr.checks.map((c) => <details key={c.id}><summary>{c.name}</summary><a href={c.url} target="_blank" rel="noreferrer" className="underline">GitHub 检查详情</a><pre className="max-h-48 overflow-auto whitespace-pre-wrap text-xs">{c.summary}{'\n'}{c.text}</pre></details>)}
        <details><summary>PR 变更内容</summary>{pr.files.map((f) => <div key={f.filename}><strong>{f.filename}</strong><pre className="max-h-40 overflow-auto text-xs">{f.patch || '无文本 diff'}</pre></div>)}</details>
      </div>}
      <div className="grid gap-4 md:grid-cols-2">
        <label>任务名称<input required className={inputClass} value={title} onChange={(e) => setTitle(e.target.value)} /></label>
        <label>准确提交 SHA<input required pattern="[0-9a-f]{40}" className={inputClass} value={sha} onChange={(e) => setSha(e.target.value)} /></label>
        <label>修复 PR 的目标分支<input required className={inputClass} value={targetBranch} onChange={(e) => setTargetBranch(e.target.value)} /></label>
        <label>Agent<select className={inputClass} value={agent} onChange={(e) => setAgent(e.target.value)}><option>SELF_LANGGRAPH</option><option>MINI_SWE</option></select></label>
        <label>Token 总预算<input type="number" min={1} required className={inputClass} value={tokens} onChange={(e) => setTokens(Number(e.target.value))} /></label>
        <label>执行时间预算（秒）<input type="number" min={1} required className={inputClass} value={seconds} onChange={(e) => setSeconds(Number(e.target.value))} /></label>
        <label>最大尝试次数<input type="number" min={1} max={20} required className={inputClass} value={attempts} onChange={(e) => setAttempts(Number(e.target.value))} /></label>
        <label>交付方式<select className={inputClass} value={delivery} onChange={(e) => setDelivery(e.target.value)}><option value="patch">审查并下载补丁</option><option value="pull-request">审批后创建修复 PR</option></select></label>
      </div>
      <label className="block">问题描述<textarea required className={inputClass} value={description} onChange={(e) => setDescription(e.target.value)} /></label>
      <label className="block">原失败检查命令<input required className={inputClass} value={command} onChange={(e) => setCommand(e.target.value)} /></label>
      <label className="block">预期失败标识（测试名称或稳定错误片段，每行一项）<textarea required className={inputClass} value={expected} onChange={(e) => setExpected(e.target.value)} /></label>
      <ConfigForm config={config} onChange={setConfig} />
      <button disabled={!repositoryId || busy} className="rounded-lg bg-zinc-900 px-4 py-2 text-white disabled:opacity-40">{busy ? '准备摘要…' : '生成确认摘要'}</button>
    </form> : <div className="space-y-4 rounded-xl border bg-white p-6">
      <h2 className="text-lg font-semibold">确认任务：{title}</h2>
      <dl className="space-y-2 text-sm"><dt>仓库 / 配置</dt><dd>{repo?.name} / v{repo?.configs[0].version}</dd><dt>固定提交</dt><dd className="break-all font-mono">{sha}</dd><dt>环境</dt><dd>{config.image}</dd><dt>Agent / 预算</dt><dd>{agent} · {tokens} Tokens · {seconds} 秒 · 最多 {attempts} 次</dd><dt>修改范围</dt><dd>{config.allowedPaths.join(', ')}</dd><dt>复现检查</dt><dd>{command}</dd><dt>验收标准</dt><dd>{config.acceptanceCriteria.join('；')}</dd><dt>回归测试</dt><dd>{config.passToPass.join('；') || '未配置：本次不能承诺回归测试已通过'}</dd><dt>交付</dt><dd>{delivery === 'patch' ? '人工审查并下载补丁' : `审批后创建指向 ${targetBranch} 的修复 PR`}</dd></dl>
      <label className="flex gap-2"><input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />我确认指定检查、验收标准和修改范围符合需求，并接受所示预算及回归覆盖。</label>
      <label className="flex gap-2 text-sm"><input type="checkbox" checked={keepPinned} onChange={(e) => setKeepPinned(e.target.checked)} />若原分支已变化，仍执行上述固定 SHA（交付前会再次检查）</label>
      <div className="flex gap-4"><button disabled={!confirmed || busy} className="rounded-lg bg-zinc-900 px-4 py-2 text-white disabled:opacity-40" onClick={() => void perform(async () => {
        const result = await fetchJson<{ runId: string }>(`/api/drafts/${draft.id}/confirm`, { method: 'POST', body: JSON.stringify({ revision: draft.revision, idempotencyKey: draft.key, testsConfirmed: true, keepPinned }) });
        router.push(`/runs/${result.runId}`);
      })}>{busy ? '提交中…' : '确认并排队'}</button><button disabled={busy} onClick={() => { setDraft(null); setConfirmed(false); }}>返回修改</button></div>
    </div>}
  </section>;
}
