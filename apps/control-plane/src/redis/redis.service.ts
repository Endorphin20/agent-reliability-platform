import { Injectable, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { loadEnv } from '../config/env';

export const RUN_COMMANDS_STREAM = 'run-commands';
export const TRACE_EVENTS_STREAM = 'trace-events';
export const TRACE_EVENTS_GROUP = 'control-plane';

@Injectable()
export class RedisService implements OnModuleDestroy {
  /** 普通命令连接（XADD 等） */
  readonly client: Redis;
  private readonly blockingClients: Redis[] = [];

  constructor() {
    this.client = new Redis(loadEnv().REDIS_URL, { maxRetriesPerRequest: 3 });
  }

  /** XREADGROUP 阻塞消费要用独立连接，避免阻塞其他命令 */
  createBlockingClient(): Redis {
    const client = new Redis(loadEnv().REDIS_URL, { maxRetriesPerRequest: null });
    this.blockingClients.push(client);
    return client;
  }

  async onModuleDestroy() {
    await this.client.quit().catch(() => undefined);
    await Promise.all(this.blockingClients.map((c) => c.quit().catch(() => undefined)));
  }
}
