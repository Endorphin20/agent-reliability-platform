import { Controller, Get, Headers, Param, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { loadEnv } from '../../config/env';
import { PrismaService } from '../../prisma/prisma.service';
import { RunEventsBus, type StoredTraceEvent } from './run-events.bus';

/**
 * SSE 实时事件流。协议要点（IM-02）：
 * 每条消息必须输出 `id: <runSequence>` 行，浏览器 EventSource 自动重连时
 * 才会带 Last-Event-ID 头；服务端先补发 DB 中 runSequence > Last-Event-ID
 * 的事件，再接实时流。
 */
@Controller('api/runs')
export class SseController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: RunEventsBus,
  ) {}

  @Get(':id/events/stream')
  async stream(
    @Param('id') runId: string,
    @Res() res: Response,
    @Headers('last-event-id') lastEventIdHeader?: string,
    @Query('lastEventId') lastEventIdQuery?: string,
  ) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const lastEventId = Number(lastEventIdHeader ?? lastEventIdQuery ?? 0) || 0;
    let maxSent = lastEventId;

    const send = (event: StoredTraceEvent) => {
      if (event.runSequence <= maxSent) return; // 去重（补发与实时流交界处）
      maxSent = event.runSequence;
      res.write(`id: ${event.runSequence}\nevent: trace\ndata: ${JSON.stringify(event)}\n\n`);
    };

    // 先订阅再补发，避免间隙丢事件（send 内按 runSequence 去重）
    const buffered: StoredTraceEvent[] = [];
    let backfilling = true;
    const unsubscribe = this.bus.subscribe(runId, (event) => {
      if (backfilling) buffered.push(event);
      else send(event);
    });

    const backlog = await this.prisma.traceEvent.findMany({
      where: { runId, runSequence: { gt: lastEventId } },
      orderBy: { runSequence: 'asc' },
    });
    for (const e of backlog) {
      send({
        runId: e.runId,
        runSequence: e.runSequence,
        type: e.type,
        payload: e.payload,
        attemptId: e.attemptId,
        attemptSequence: e.attemptSequence,
        occurredAt: e.occurredAt.toISOString(),
      });
    }
    backfilling = false;
    for (const event of buffered.sort((a, b) => a.runSequence - b.runSequence)) {
      send(event);
    }

    const heartbeat = setInterval(() => {
      res.write(`: heartbeat ${Date.now()}\n\n`);
    }, loadEnv().SSE_HEARTBEAT_MS);

    res.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
      res.end();
    });
  }
}
