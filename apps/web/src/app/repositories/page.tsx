'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchJson } from '../../lib/api';
import { defaultConfig, type Repository } from '../../lib/repository';
import { ConfigForm, inputClass } from '../../components/repository-config-form';

export default function Repositories() {
  const cache = useQueryClient();
  const repos = useQuery({ queryKey: ['repositories'], queryFn: () => fetchJson<Repository[]>('/api/repositories') });
  const [config, setConfig] = useState(defaultConfig);
  const [name, setName] = useState(''); const [path, setPath] = useState('');
  const [url, setUrl] = useState(''); const [branch, setBranch] = useState('main');
  const [readToken, setReadToken] = useState(''); const [writeToken, setWriteToken] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  return <section className="space-y-6"><h1 className="text-xl font-semibold">接入仓库</h1>
    <p className="text-sm text-zinc-600">首版支持 Python / pytest。准备好本地 Git 副本和 Docker 镜像；保存一次后，新任务复用环境与测试默认值。</p>
    {repos.error && <p role="alert">{String(repos.error)} <Link className="underline" href="/settings">本机登录</Link></p>}
    <ul className="space-y-2">{repos.data?.map((repo) => <li key={repo.id} className="flex items-center justify-between rounded-lg border bg-white p-4">
      <div><strong>{repo.name}</strong><p className="text-sm text-zinc-500">{repo.repoUrl} · 配置 v{repo.configs[0]?.version}</p></div>
      <div className="flex gap-4"><Link className="underline" href={`/tasks/new?repositoryId=${repo.id}`}>创建任务</Link><button onClick={async () => { try { const result = await fetchJson<{ readable: boolean; repositoryPushPermission: boolean; note: string }>(`/api/repositories/${repo.id}/check`, { method: 'POST' }); setError(`读取：${result.readable ? '可用' : '不可用'}；仓库写入权限：${result.repositoryPushPermission ? '可用（交付时复核 Token 范围）' : '未确认'}`); } catch (err) { setError(String(err)); } }}>检查连接</button><button onClick={() => { setEditing(repo.id); setConfig(repo.configs[0].config); }}>更新配置</button></div>
    </li>)}</ul>
    <form className="space-y-5 rounded-xl border bg-white p-6" onSubmit={async (e) => {
      e.preventDefault(); setBusy(true); setError('');
      try {
        if (editing) await fetchJson(`/api/repositories/${editing}/configs`, { method: 'POST', body: JSON.stringify(config) });
        else {
          const saveToken = async (value: string) => value ? (await fetchJson<{ reference: string }>('/api/credentials', { method: 'POST', body: JSON.stringify({ kind: 'github', value }) })).reference : undefined;
          const readCredential = await saveToken(readToken); const writeCredential = await saveToken(writeToken);
          await fetchJson('/api/repositories', { method: 'POST', body: JSON.stringify({ name, repoPath: path, repoUrl: url, defaultBranch: branch, readCredential, writeCredential, config }) });
          setReadToken(''); setWriteToken('');
        }
        setEditing(null); await cache.invalidateQueries({ queryKey: ['repositories'] });
      } catch (err) { setError(String(err)); } finally { setBusy(false); }
    }}>
      <h2 className="font-semibold">{editing ? '保存新的配置版本（已有任务不变）' : '新增仓库'}</h2>
      {!editing && <div className="grid gap-4 md:grid-cols-2">
        <label>名称<input required className={inputClass} value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label>GitHub 仓库 URL<input required type="url" className={inputClass} value={url} onChange={(e) => setUrl(e.target.value)} /></label>
        <label>本地副本绝对路径<input required className={inputClass} value={path} onChange={(e) => setPath(e.target.value)} /></label>
        <label>默认分支<input required className={inputClass} value={branch} onChange={(e) => setBranch(e.target.value)} /></label>
        <label>读取 Token（公开仓库可留空）<input type="password" autoComplete="off" className={inputClass} value={readToken} onChange={(e) => setReadToken(e.target.value)} /></label>
        <label>写入 Token（可先只交付补丁）<input type="password" autoComplete="off" className={inputClass} value={writeToken} onChange={(e) => setWriteToken(e.target.value)} /></label>
      </div>}
      <ConfigForm config={config} onChange={setConfig} />
      <p className="text-xs text-zinc-500">配置的命令将在本机隔离容器内执行。Token 仅保存在平台侧，不传入任务。</p>
      {error && <p role="alert" className="text-red-700">{error}</p>}
      <button disabled={busy} className="rounded-lg bg-zinc-900 px-4 py-2 text-white disabled:opacity-40">{busy ? '保存中…' : '保存配置'}</button>
      {editing && <button type="button" className="ml-4" onClick={() => setEditing(null)}>取消</button>}
    </form>
  </section>;
}
