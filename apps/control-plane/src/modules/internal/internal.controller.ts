import { PrismaService } from '../../prisma/prisma.service';
import { createHash } from 'node:crypto';
import { RunControlService } from '../run/run-control.service';
import { BudgetService } from '../run/budget.service';
import { BadRequestException, Body, Controller, Get, Param, Post, Headers } from '@nestjs/common';
import { z } from 'zod';
import { FAILURE_CODES, VERIFIER_STEPS } from '@arp/shared';
import { RunLifecycleService } from '../run/run-lifecycle.service';

const ClaimSchema = z.object({
  runId: z.string().min(1),
  attemptNo: z.number().int().positive(),
  workerId: z.string().min(1),
});

const VerificationResultSchema = z.object({
  step: z.enum(VERIFIER_STEPS),
  passed: z.boolean(),
  failureCode: z.enum(FAILURE_CODES).nullable(),
  detail: z.record(z.string(), z.unknown()),
  durationMs: z.number().int().nonnegative(),
});

const CompleteExtrasSchema = z.object({
  usedTokens: z.number().int().nonnegative().optional(),
  usedSeconds: z.number().int().nonnegative().optional(),
  verification: z.array(VerificationResultSchema).optional(),
  patch: z.string().optional(), // 最终 diff，成功时落 PATCH 工件
  judge: z.record(z.string(), z.unknown()).optional(), // LLM Judge 报告，落 JUDGE_REPORT 工件
});

const CompleteSchema = z.discriminatedUnion('status', [
  CompleteExtrasSchema.extend({ status: z.literal('SUCCEEDED') }),
  CompleteExtrasSchema.extend({
    status: z.literal('FAILED'),
    failureCode: z.enum(FAILURE_CODES),
  }),
]);

const CheckpointSchema = z.object({
  attemptId: z.string().min(1),
  threadId: z.string().min(1),
  baseCommit: z.string().min(1),
  appliedPatchSha: z.string().nullable(),
  appliedPatch: z.string().nullable(),
  completedToolCalls: z.record(z.string(), z.string()),
  usedTokens: z.number().int().nonnegative(),
  usedSeconds: z.number().int().nonnegative(),
});

/** Runtime Worker 专用内部 API：认领 / 续租 / 完结上报 / 检查点存取 */
@Controller('internal')
export class InternalController {
  constructor(private readonly lifecycle: RunLifecycleService, private readonly control: RunControlService, private readonly budgets: BudgetService, private readonly prisma: PrismaService) {}

  @Get('attempts/:id/active')
  async active(@Param('id') id: string) {
    const a = await this.prisma.attempt.findUnique({ where: { id }, include: { run: true } });
    return { active: !!a && a.status === 'RUNNING' && !!a.leaseExpiresAt && a.leaseExpiresAt > new Date() && ['RUNNING', 'VERIFYING'].includes(a.run.status) };
  }
  @Post('attempts/:id/evidence')
  async evidence(@Param('id') id: string, @Body() raw: unknown) {
    const data = z.object({ attemptId: z.literal(id), patch: z.string().max(8000000), report: z.record(z.string(), z.unknown()) }).parse(raw);
    const attempt = await this.prisma.attempt.findUniqueOrThrow({ where: { id } });
    const content = JSON.stringify(data);
    const artifactId = `evidence-${createHash('sha256').update(id + content).digest('hex')}`;
    // Late evidence is retained as a report; it cannot replace the approved PATCH.
    return this.prisma.artifact.upsert({ where: { id: artifactId }, update: {}, create: {
      id: artifactId, runId: attempt.runId, attemptId: id, kind: 'TEST_REPORT', name: 'retained-evidence.json', content, sizeBytes: Buffer.byteLength(content),
    } });
  }
  @Post('attempts/claim')
  async claim(@Body() body: unknown) {
    const parsed = ClaimSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    return this.lifecycle.claimAttempt(parsed.data);
  }

  @Post('attempts/:id/heartbeat')
  async heartbeat(@Param('id') id: string, @Headers('x-arp-lease') token: string) {
    await this.control.lease(id, token);
    return this.lifecycle.heartbeat(id);
  }

  @Post('attempts/:id/complete')
  async complete(@Param('id') id: string, @Body() body: unknown, @Headers('x-arp-lease') token: string) {
    await this.control.lease(id, token);
    const parsed = CompleteSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    return this.lifecycle.completeAttempt(id, parsed.data);
  }

  @Post('runs/:runId/checkpoints')
  async saveCheckpoint(@Param('runId') runId: string, @Body() body: unknown, @Headers('x-arp-lease') token: string) {
    const parsed = CheckpointSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const attempt = await this.control.lease(parsed.data.attemptId, token);
    if (attempt.runId !== runId || attempt.run.baseCommit !== parsed.data.baseCommit) throw new BadRequestException('Checkpoint mismatch');
    return this.lifecycle.saveCheckpoint(runId, parsed.data);
  }

  @Get('checkpoints/:id')
  async getCheckpoint(@Param('id') id: string) {
    return this.lifecycle.getCheckpoint(id);
  }

  @Post('attempts/:id/phase')
  phase(@Param('id') id: string, @Headers('x-arp-lease') token: string, @Body() raw: unknown) {
    const p = z.object({ phase: z.enum(['PREPARING', 'REPRODUCING', 'REPAIRING', 'VERIFYING', 'BASELINE']), detail: z.record(z.string(), z.unknown()).optional() }).parse(raw);
    return this.control.phase(id, token, p.phase, p.detail);
  }
  @Post('attempts/:id/pause')
  pause(@Param('id') id: string, @Headers('x-arp-lease') token: string, @Body() raw: unknown) {
    const p = z.object({ reason: z.string().min(1).max(2000), patch: z.string().max(8000000).optional() }).parse(raw);
    return this.control.pause(id, token, p.reason, p.patch);
  }
  @Post('attempts/:id/environment')
  environment(@Param('id') id: string, @Headers('x-arp-lease') token: string, @Body() raw: unknown) {
    const p = z.object({ fingerprint: z.string().regex(/^[a-f0-9]{64}$/), imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/), log: z.string().max(20000) }).parse(raw);
    return this.control.environment(id, token, p.fingerprint, p.imageId, p.log);
  }
  @Post('runs/:runId/budget/reserve')
  reserve(@Param('runId') runId: string, @Headers('x-arp-lease') token: string, @Body() raw: unknown) {
    const p = z.object({ attemptId: z.string(), id: z.string().uuid(), reserved: z.number().int().positive() }).parse(raw);
    return this.budgets.reserve(runId, p.attemptId, token, p.id, p.reserved);
  }
  @Post('runs/:runId/budget/settle')
  settle(@Param('runId') runId: string, @Body() raw: unknown) {
    const p = z.object({ id: z.string().uuid(), used: z.number().int().nonnegative().nullable() }).parse(raw);
    return this.budgets.settle(runId, p.id, p.used);
  }
}
