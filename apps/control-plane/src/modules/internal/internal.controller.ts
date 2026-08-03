import { BadRequestException, Body, Controller, Get, Param, Post } from '@nestjs/common';
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
  constructor(private readonly lifecycle: RunLifecycleService) {}

  @Post('attempts/claim')
  async claim(@Body() body: unknown) {
    const parsed = ClaimSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    return this.lifecycle.claimAttempt(parsed.data);
  }

  @Post('attempts/:id/heartbeat')
  async heartbeat(@Param('id') id: string) {
    return this.lifecycle.heartbeat(id);
  }

  @Post('attempts/:id/complete')
  async complete(@Param('id') id: string, @Body() body: unknown) {
    const parsed = CompleteSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    return this.lifecycle.completeAttempt(id, parsed.data);
  }

  @Post('runs/:runId/checkpoints')
  async saveCheckpoint(@Param('runId') runId: string, @Body() body: unknown) {
    const parsed = CheckpointSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    return this.lifecycle.saveCheckpoint(runId, parsed.data);
  }

  @Get('checkpoints/:id')
  async getCheckpoint(@Param('id') id: string) {
    return this.lifecycle.getCheckpoint(id);
  }
}
