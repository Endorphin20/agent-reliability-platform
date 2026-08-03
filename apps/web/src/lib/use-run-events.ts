"use client";

/**
 * useRunEvents（计划 §6 IM-03）：
 * - EventSource 持有 SSE 连接（/api/runs/:id/events/stream）；
 * - 事件按 runSequence 去重合并进 TanStack Query cache（不放组件 state）；
 * - 断线重连由 EventSource 原生完成，服务端按 Last-Event-ID 补发；
 *   兜底：手动重建连接时带 ?lastEventId= 查询参数；
 * - 收到 STATE_TRANSITION 时 invalidate ['run', runId] 让状态徽标以 API 为准；
 * - 连续失败 5 次置 disconnected，由页面显示"连接中断"横幅。
 */

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { API_BASE, type TraceEvent } from "./api";

export function mergeEvents(existing: TraceEvent[] | undefined, incoming: TraceEvent): TraceEvent[] {
  const events = existing ?? [];
  if (events.some((e) => e.runSequence === incoming.runSequence)) return events;
  return [...events, incoming].sort((a, b) => a.runSequence - b.runSequence);
}

export function useRunEvents(runId: string) {
  const queryClient = useQueryClient();
  const [disconnected, setDisconnected] = useState(false);
  const [reconnectNonce, setReconnectNonce] = useState(0);
  const failures = useRef(0);
  const lastSequence = useRef(0);

  useEffect(() => {
    const url = new URL(`${API_BASE}/api/runs/${runId}/events/stream`);
    if (lastSequence.current > 0) {
      url.searchParams.set("lastEventId", String(lastSequence.current));
    }
    const source = new EventSource(url);

    source.addEventListener("trace", (message: MessageEvent<string>) => {
      failures.current = 0;
      setDisconnected(false);
      const event = JSON.parse(message.data) as TraceEvent;
      lastSequence.current = Math.max(lastSequence.current, event.runSequence);
      queryClient.setQueryData<TraceEvent[]>(["run-events", runId], (old) =>
        mergeEvents(old, event),
      );
      if (event.type === "STATE_TRANSITION" || event.type === "APPROVAL_EVENT") {
        void queryClient.invalidateQueries({ queryKey: ["run", runId] });
      }
    });

    source.onerror = () => {
      failures.current += 1;
      if (failures.current >= 5) setDisconnected(true);
    };

    return () => source.close();
  }, [runId, queryClient, reconnectNonce]);

  return {
    disconnected,
    retry: () => {
      failures.current = 0;
      setDisconnected(false);
      setReconnectNonce((n) => n + 1);
    },
  };
}
