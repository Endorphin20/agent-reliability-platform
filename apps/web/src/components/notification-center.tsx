'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchJson } from '../lib/api';

export function NotificationCenter() {
  const cache = useQueryClient();
  const notices = useQuery({ queryKey: ['notifications'], queryFn: () => fetchJson<{ id: string; message: string; readAt: string | null }[]>('/api/notifications'), refetchInterval: 5000, retry: false });
  const unread = notices.data?.filter((n) => !n.readAt) ?? [];
  if (!unread.length) return null;
  return <details className="mb-5 rounded-lg border bg-white p-3 text-sm"><summary>站内通知（{unread.length} 条未读）</summary>
    <ul className="mt-3 space-y-3">{unread.map((n) => <li key={n.id} className="flex justify-between gap-3"><span>{n.message}</span>
      <button className="shrink-0 underline" onClick={async () => { await fetchJson(`/api/notifications/${n.id}/read`, { method: 'POST' }); await cache.invalidateQueries({ queryKey: ['notifications'] }); }}>标为已读</button></li>)}</ul>
  </details>;
}
