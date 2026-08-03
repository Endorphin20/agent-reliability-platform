import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import { z } from 'zod';
import { AGENT_KINDS } from '@arp/shared';
import { PrismaService } from '../../prisma/prisma.service';

const CreateEvaluationSchema = z.object({
  suite: z.string().min(1),
  agentKind: z.enum(AGENT_KINDS),
  faultInjection: z.string().nullable().optional(),
});

const CreateResultSchema = z.object({
  fixtureId: z.string().min(1),
  runId: z.string().min(1),
  resolved: z.boolean(),
  firstTrySuccess: z.boolean(),
  recovered: z.boolean().nullable(),
  recoveryMode: z.enum(['checkpoint', 'attempt-restart']).nullable(),
  scopeViolations: z.number().int().nonnegative(),
  tokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
  wallSeconds: z.number().int().nonnegative(),
  judgeScores: z.record(z.string(), z.unknown()),
});

/** 评测批次 API（T11）：arp-eval CLI 写入，评测页读取 */
@Controller('api/evaluations')
export class EvaluationController {
  constructor(private readonly prisma: PrismaService) {}

  @Post()
  async create(@Body() body: unknown) {
    const parsed = CreateEvaluationSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    return this.prisma.evaluationRun.create({
      data: {
        suite: parsed.data.suite,
        agentKind: parsed.data.agentKind,
        faultInjection: parsed.data.faultInjection ?? null,
      },
    });
  }

  @Post(':id/results')
  async addResult(@Param('id') id: string, @Body() body: unknown) {
    const parsed = CreateResultSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const evaluation = await this.prisma.evaluationRun.findUnique({ where: { id } });
    if (!evaluation) throw new NotFoundException(`EvaluationRun ${id} 不存在`);
    return this.prisma.evaluationResult.create({
      data: {
        evaluationRunId: id,
        ...parsed.data,
        judgeScores: parsed.data.judgeScores as object,
      },
    });
  }

  @Post(':id/finish')
  async finish(@Param('id') id: string) {
    return this.prisma.evaluationRun.update({
      where: { id },
      data: { finishedAt: new Date() },
    });
  }

  /** 列表 + 每个批次的汇总指标（评测页首屏） */
  @Get()
  async list() {
    const evaluations = await this.prisma.evaluationRun.findMany({
      orderBy: { startedAt: 'desc' },
      take: 50,
      include: { results: true },
    });
    return evaluations.map((evaluation) => ({
      id: evaluation.id,
      suite: evaluation.suite,
      agentKind: evaluation.agentKind,
      faultInjection: evaluation.faultInjection,
      startedAt: evaluation.startedAt,
      finishedAt: evaluation.finishedAt,
      summary: summarize(evaluation.results),
    }));
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    const evaluation = await this.prisma.evaluationRun.findUnique({
      where: { id },
      include: { results: { orderBy: { fixtureId: 'asc' } } },
    });
    if (!evaluation) throw new NotFoundException(`EvaluationRun ${id} 不存在`);
    return { ...evaluation, summary: summarize(evaluation.results) };
  }
}

interface ResultRow {
  resolved: boolean;
  firstTrySuccess: boolean;
  recovered: boolean | null;
  scopeViolations: number;
  tokens: number;
  costUsd: unknown;
  wallSeconds: number;
  judgeScores: unknown;
}

function summarize(results: ResultRow[]) {
  const total = results.length;
  if (total === 0) return null;
  const resolved = results.filter((r) => r.resolved).length;
  const withFault = results.filter((r) => r.recovered !== null);
  const judgeAvg = average(
    results.flatMap((r) => {
      const criteria = (r.judgeScores as { criteria?: Array<{ score?: number }> })?.criteria;
      return criteria?.map((c) => c.score ?? 0) ?? [];
    }),
  );
  return {
    total,
    resolved,
    resolveRate: resolved / total,
    firstTrySuccessRate: results.filter((r) => r.firstTrySuccess).length / total,
    recoveredRate: withFault.length
      ? withFault.filter((r) => r.recovered).length / withFault.length
      : null,
    scopeViolations: results.reduce((sum, r) => sum + r.scopeViolations, 0),
    avgTokens: Math.round(average(results.map((r) => r.tokens)) ?? 0),
    totalCostUsd: results.reduce((sum, r) => sum + Number(r.costUsd), 0),
    avgWallSeconds: Math.round(average(results.map((r) => r.wallSeconds)) ?? 0),
    avgJudgeScore: judgeAvg,
  };
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}
