import { Controller, Get, NotFoundException, Param, Query } from '@nestjs/common';
import { TRACE_EVENT_TYPES } from '@arp/shared';
import { PrismaService } from '../../prisma/prisma.service';

@Controller('api/runs')
export class RunController {
  constructor(private readonly prisma: PrismaService) {}

  @Get(':id')
  async get(@Param('id') id: string) {
    const run = await this.prisma.run.findUnique({
      where: { id },
      include: {
        attempts: { orderBy: { no: 'asc' } },
        policyDecisions: { orderBy: { createdAt: 'asc' } },
        verificationResults: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!run) throw new NotFoundException(`Run ${id} 不存在`);
    return run;
  }

  /** JSON 列表（供 e2e 脚本断言和前端初始加载），SSE 实时流见 /events/stream */
  @Get(':id/events')
  async events(@Param('id') id: string, @Query('type') type?: string) {
    const run = await this.prisma.run.findUnique({ where: { id }, select: { id: true } });
    if (!run) throw new NotFoundException(`Run ${id} 不存在`);
    const events = await this.prisma.traceEvent.findMany({
      where: {
        runId: id,
        ...(type && (TRACE_EVENT_TYPES as readonly string[]).includes(type)
          ? { type: type as (typeof TRACE_EVENT_TYPES)[number] }
          : {}),
      },
      orderBy: { runSequence: 'asc' },
    });
    return events.map((e) => ({
      runSequence: e.runSequence,
      attemptId: e.attemptId,
      attemptSequence: e.attemptSequence,
      type: e.type,
      payload: e.payload,
      occurredAt: e.occurredAt.toISOString(),
    }));
  }

  /** LLM Judge 报告（review 页逐条分数 + 评测 CLI judgeScores 数据源） */
  @Get(':id/judge')
  async judge(@Param('id') id: string) {
    const artifact = await this.prisma.artifact.findFirst({
      where: { runId: id, kind: 'JUDGE_REPORT' },
      orderBy: { createdAt: 'desc' },
    });
    if (!artifact) throw new NotFoundException(`Run ${id} 没有 Judge 报告`);
    return { ...(JSON.parse(artifact.content) as object), createdAt: artifact.createdAt };
  }

  /** 最新补丁全文（review 页 diff 视图数据源） */
  @Get(':id/diff')
  async diff(@Param('id') id: string) {
    const artifact = await this.prisma.artifact.findFirst({
      where: { runId: id, kind: 'PATCH' },
      orderBy: { createdAt: 'desc' },
    });
    if (!artifact) throw new NotFoundException(`Run ${id} 没有补丁 Artifact`);
    return { name: artifact.name, content: artifact.content, createdAt: artifact.createdAt };
  }
}
