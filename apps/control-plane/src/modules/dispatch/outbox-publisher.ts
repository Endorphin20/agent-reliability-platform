import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { loadEnv } from '../../config/env';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService, RUN_COMMANDS_STREAM } from '../../redis/redis.service';

/**
 * Transactional Outbox 的发布侧：
 * 轮询 PENDING 消息 -> XADD 到 Redis Streams -> 标记 PUBLISHED。
 * XADD 成功但标记失败时消息会重复投递，由消费端 commandId 幂等兜底（§4.5）。
 */
@Injectable()
export class OutboxPublisher implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxPublisher.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  onModuleInit() {
    if (process.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => void this.tick(), loadEnv().OUTBOX_POLL_MS);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<number> {
    if (this.running) return 0; // 防止上一轮未完成时重入
    this.running = true;
    try {
      const pending = await this.prisma.outboxMessage.findMany({
        where: { status: 'PENDING' },
        orderBy: { createdAt: 'asc' },
        take: 20,
      });
      let published = 0;
      for (const message of pending) {
        try {
          await this.redis.client.xadd(
            RUN_COMMANDS_STREAM,
            '*',
            'key',
            message.key,
            'data',
            JSON.stringify(message.payload),
          );
          await this.prisma.outboxMessage.update({
            where: { id: message.id },
            data: { status: 'PUBLISHED', publishedAt: new Date() },
          });
          published += 1;
        } catch (error) {
          this.logger.error(`Outbox 发布失败 ${message.id}: ${String(error)}`);
          await this.prisma.outboxMessage.update({
            where: { id: message.id },
            data: { attempts: { increment: 1 } },
          });
        }
      }
      return published;
    } finally {
      this.running = false;
    }
  }
}
