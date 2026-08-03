import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { RunLifecycleService } from '../run/run-lifecycle.service';

/**
 * 租约监控：扫描 leaseExpiresAt 过期且仍在执行的 Attempt，
 * 判定 WORKER_LOST 并交给 Policy Engine 决策恢复。
 */
@Injectable()
export class LeaseMonitor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LeaseMonitor.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  private static readonly SCAN_INTERVAL_MS = 5000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly lifecycle: RunLifecycleService,
  ) {}

  onModuleInit() {
    if (process.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => void this.tick(), LeaseMonitor.SCAN_INTERVAL_MS);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const expired = await this.prisma.attempt.findMany({
        where: {
          status: { in: ['CLAIMED', 'RUNNING'] },
          leaseExpiresAt: { lt: new Date() },
        },
        take: 20,
      });
      for (const attempt of expired) {
        this.logger.warn(`租约过期: attempt ${attempt.id} (run ${attempt.runId})，判定 WORKER_LOST`);
        await this.lifecycle.handleLeaseExpired(attempt.id);
      }
      return expired.length;
    } finally {
      this.running = false;
    }
  }
}
