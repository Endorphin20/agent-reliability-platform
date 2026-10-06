'use client';
import { useState } from 'react';
import { fetchJson } from '../../lib/api';
import { inputClass } from '../../components/repository-config-form';

export default function Settings() {
  const [token, setToken] = useState('');
  const [message, setMessage] = useState('');
  return <section className="max-w-xl space-y-5"><h1 className="text-xl font-semibold">本机授权</h1>
    <p className="text-sm text-zinc-600">输入启动 ARP 时生成的本地访问密钥，位置为 ARP 数据目录下的 access-token（默认 ~/.arp/access-token）。密钥只用于本机登录。</p>
    <form onSubmit={async (e) => { e.preventDefault(); try { await fetchJson('/api/session', { method: 'POST', headers: { Authorization: `Bearer ${token}` } }); setToken(''); setMessage('已登录，可接入仓库。'); } catch (err) { setMessage(String(err)); } }}>
      <label>本地访问密钥<input required type="password" autoComplete="off" className={inputClass} value={token} onChange={(e) => setToken(e.target.value)} /></label>
      <button className="mt-4 rounded-lg bg-zinc-900 px-4 py-2 text-white">登录本机 ARP</button></form>
    <p role="status">{message}</p>
  </section>;
}
