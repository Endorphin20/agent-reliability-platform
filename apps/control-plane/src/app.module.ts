import { Module } from '@nestjs/common';
import { PrismaService } from './prisma/prisma.service';
import { RedisService } from './redis/redis.service';
import { ApprovalController } from './modules/approval/approval.controller';
import { ApprovalService } from './modules/approval/approval.service';
import { LeaseMonitor } from './modules/dispatch/lease-monitor';
import { OutboxPublisher } from './modules/dispatch/outbox-publisher';
import { EvaluationController } from './modules/evaluation/evaluation.controller';
import { RunEventsBus } from './modules/events/run-events.bus';
import { SseController } from './modules/events/sse.controller';
import { TraceEventIngestor } from './modules/events/trace-event-ingestor';
import { FixtureController } from './modules/fixture/fixture.controller';
import { FixtureRegistry } from './modules/fixture/fixture-registry';
import { GithubWebhookController } from './modules/github/github.controller';
import { GithubService } from './modules/github/github.service';
import { HealthController } from './modules/health/health.controller';
import { InternalController } from './modules/internal/internal.controller';
import { RunController } from './modules/run/run.controller';
import { RunLifecycleService } from './modules/run/run-lifecycle.service';
import { TaskController } from './modules/task/task.controller';

@Module({
  controllers: [
    HealthController,
    TaskController,
    RunController,
    SseController,
    ApprovalController,
    InternalController,
    FixtureController,
    EvaluationController,
    GithubWebhookController,
  ],
  providers: [
    PrismaService,
    RedisService,
    RunEventsBus,
    FixtureRegistry,
    RunLifecycleService,
    OutboxPublisher,
    LeaseMonitor,
    TraceEventIngestor,
    ApprovalService,
    GithubService,
  ],
})
export class AppModule {}
