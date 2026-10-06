import { Controller, Get, Headers, Param, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { PrismaService } from '../../prisma/prisma.service';

/** PostgreSQL is the replay authority. Polling also heals lost Redis broadcasts. */
@Controller('api/runs')
export class SseController {
  constructor(private readonly prisma: PrismaService) {}
  @Get(':id/events/stream')
  async stream(@Param('id') runId: string, @Res() res: Response,
    @Headers('last-event-id') header?: string, @Query('lastEventId') query?: string) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    const requested = Number(header ?? query ?? 0);
    let sequence = Number.isSafeInteger(requested) && requested >= 0 ? requested : 0;
    let closed = false;
    let active = false;
    const drain = async () => {
      if (closed || active) return;
      active = true;
      try {
        const events = await this.prisma.traceEvent.findMany({
          where: { runId, runSequence: { gt: sequence } }, orderBy: { runSequence: 'asc' }, take: 500,
        });
        for (const e of events) {
          if (closed) break;
          res.write(`id: ${e.runSequence}\nevent: trace\ndata: ${JSON.stringify({ runId,
            runSequence: e.runSequence, type: e.type, payload: e.payload, attemptId: e.attemptId,
            attemptSequence: e.attemptSequence, occurredAt: e.occurredAt.toISOString() })}\n\n`);
          sequence = e.runSequence;
        }
        if (!closed) res.write(': heartbeat\n\n');
      } catch { /* Retry from same sequence on the next interval. */ }
      finally { active = false; }
    };
    const timer = setInterval(() => void drain(), 1000);
    res.on('close', () => { closed = true; clearInterval(timer); });
    await drain();
  }
}
