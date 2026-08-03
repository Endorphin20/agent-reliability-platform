import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { TraceEventSchema } from '@arp/shared';
import type Redis from 'ioredis';
import { PrismaService } from '../../prisma/prisma.service';
import {
  RedisService,
  TRACE_EVENTS_GROUP,
  TRACE_EVENTS_STREAM,
} from '../../redis/redis.service';
import { RunEventsBus } from './run-events.bus';

/**
 * TraceEvent 回流消费：XREADGROUP -> zod 校验 -> 事务内分配 runSequence 落库
 * -> 广播给 SSE -> XACK。idempotencyKey 唯一约束保证 Streams 重复投递安全。
 */
@Injectable()
export class TraceEventIngestor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TraceEventIngestor.name);
  private client?: Redis;
  private stopped = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly bus: RunEventsBus,
  ) {}

  async onModuleInit() {
    if (process.env.NODE_ENV === 'test') return;
    this.client = this.redis.createBlockingClient();
    await this.ensureGroup();
    void this.consumeLoop();
  }

  onModuleDestroy() {
    this.stopped = true;
  }

  private async ensureGroup() {
    try {
      await this.redis.client.xgroup(
        'CREATE',
        TRACE_EVENTS_STREAM,
        TRACE_EVENTS_GROUP,
        '0',
        'MKSTREAM',
      );
    } catch (error) {
      if (!String(error).includes('BUSYGROUP')) throw error;
    }
  }

  private async consumeLoop() {
    while (!this.stopped && this.client) {
      try {
        const response = (await this.client.xreadgroup(
          'GROUP',
          TRACE_EVENTS_GROUP,
          'cp-1',
          'COUNT',
          50,
          'BLOCK',
          2000,
          'STREAMS',
          TRACE_EVENTS_STREAM,
          '>',
        )) as [string, [string, string[]][]][] | null;
        if (!response) continue;
        for (const [, entries] of response) {
          for (const [entryId, fields] of entries) {
            await this.handleEntry(entryId, fields);
          }
        }
      } catch (error) {
        if (this.stopped) return;
        this.logger.error(`消费 trace-events 失败: ${String(error)}`);
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }

  async handleEntry(entryId: string, fields: string[]): Promise<void> {
    try {
      const dataIndex = fields.indexOf('data');
      const raw: unknown = JSON.parse(fields[dataIndex + 1]);
      const parsed = TraceEventSchema.safeParse(raw);
      if (!parsed.success) {
        this.logger.error(`非法 TraceEvent，丢弃: ${JSON.stringify(parsed.error.issues)}`);
        await this.ack(entryId);
        return;
      }
      const event = parsed.data;

      const existing = await this.prisma.traceEvent.findUnique({
        where: { idempotencyKey: event.idempotencyKey },
        select: { id: true },
      });
      if (!existing) {
        const stored = await this.prisma.$transaction(async (tx) => {
          const run = await tx.run.update({
            where: { id: event.runId },
            data: { lastSequence: { increment: 1 } },
            select: { lastSequence: true },
          });
          return tx.traceEvent.create({
            data: {
              runId: event.runId,
              attemptId: event.attemptId,
              runSequence: run.lastSequence,
              attemptSequence: event.attemptSequence,
              type: event.type,
              payload: event.payload as object,
              idempotencyKey: event.idempotencyKey,
              occurredAt: new Date(event.occurredAt),
            },
          });
        });
        this.bus.publish({
          runId: stored.runId,
          runSequence: stored.runSequence,
          type: stored.type,
          payload: stored.payload,
          attemptId: stored.attemptId,
          attemptSequence: stored.attemptSequence,
          occurredAt: stored.occurredAt.toISOString(),
        });
      }
      await this.ack(entryId);
    } catch (error) {
      // P2002 = idempotencyKey 撞唯一约束（重复投递），安全 ACK；其他错误留在 pending 重试
      if ((error as { code?: string }).code === 'P2002') {
        await this.ack(entryId);
        return;
      }
      this.logger.error(`处理 trace-event ${entryId} 失败: ${String(error)}`);
    }
  }

  private async ack(entryId: string) {
    await this.redis.client.xack(TRACE_EVENTS_STREAM, TRACE_EVENTS_GROUP, entryId);
  }
}
