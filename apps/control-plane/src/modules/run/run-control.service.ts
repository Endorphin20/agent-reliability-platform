import { ConflictException, Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { TaskSnapshotSchema } from '@arp/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { commandFromSnapshot } from '../task/task-snapshot.service';

@Injectable()
export class RunControlService {
  constructor(private readonly prisma: PrismaService) {}
  private async event(tx: Prisma.TransactionClient, runId: string, from: string, to: string) {
    const run = await tx.run.update({ where: { id: runId }, data: { lastSequence: { increment: 1 } } });
    await tx.traceEvent.create({ data: { runId, runSequence: run.lastSequence, attemptSequence: 0,
      type: 'STATE_TRANSITION', payload: { entity: 'run', from, to }, idempotencyKey: `cp:${runId}:${run.lastSequence}`, occurredAt: new Date() } });
  }
  async lease(attemptId: string, token?: string, tx: Prisma.TransactionClient = this.prisma, checkTime = true) {
    const attempt = await tx.attempt.findUniqueOrThrow({ where: { id: attemptId }, include: { run: true } });
    if (!token || token !== attempt.leaseToken || attempt.status !== 'RUNNING' ||
      !attempt.leaseExpiresAt || attempt.leaseExpiresAt <= new Date() ||
      !['RUNNING', 'VERIFYING'].includes(attempt.run.status)) throw new ConflictException('Lease expired or task stopped');
    const run = attempt.run;
    if (checkTime && ((run.deadlineAt && run.deadlineAt <= new Date()) || (run.activeStartedAt &&
      run.usedSeconds + (Date.now() - run.activeStartedAt.getTime()) / 1000 >= run.budgetSeconds))) {
      throw new ConflictException('Task execution time exhausted');
    }
    return attempt;
  }
  private async withLease<T>(attemptId: string, token: string, operation: (tx: Prisma.TransactionClient, a: Awaited<ReturnType<RunControlService['lease']>>) => Promise<T>, checkTime = true) {
    return this.prisma.$transaction(async (tx) => {
      const owner = await tx.attempt.findUniqueOrThrow({ where: { id: attemptId } });
      await tx.$executeRaw`SELECT id FROM "Run" WHERE id = ${owner.runId} FOR UPDATE`;
      const a = await this.lease(attemptId, token, tx, checkTime);
      return operation(tx, a);
    });
  }
  async phase(attemptId: string, token: string, phase: string, detail?: object) {
    return this.withLease(attemptId, token, async (tx, a) => {
      await tx.run.update({ where: { id: a.runId }, data: { phase } });
      if (detail) {
        const content = JSON.stringify(detail);
        await tx.artifact.create({ data: { runId: a.runId, attemptId, kind: 'TEST_REPORT',
          name: `${phase.toLowerCase()}.json`, content, sizeBytes: Buffer.byteLength(content) } });
      }
      await this.event(tx, a.runId, a.run.phase, phase);
      const environment = a.run.environmentId ? await tx.environmentVersion.findUnique({ where: { id: a.run.environmentId } }) : null;
      return { phase, imageId: a.run.imageId, fingerprint: environment?.fingerprint };
    });
  }
  async environment(attemptId: string, token: string, fingerprint: string, imageId: string, log: string) {
    return this.withLease(attemptId, token, async (tx, a) => {
      if (a.run.imageId && a.run.imageId !== imageId) throw new ConflictException('Pinned environment image changed');
      const environment = await tx.environmentVersion.upsert({ where: { fingerprint },
        create: { fingerprint, status: 'READY', imageId, log }, update: {} });
      if (environment.imageId !== imageId) throw new ConflictException('Environment fingerprint resolved to a different image');
      await tx.run.update({ where: { id: a.runId }, data: { environmentId: environment.id, imageId } });
      return environment;
    });
  }
  async pause(attemptId: string, token: string, reason: string, patch?: string) {
    return this.withLease(attemptId, token, async (tx, a) => {
      await tx.run.update({ where: { id: a.runId }, data: { status: 'INTERRUPTED', phase: 'NEEDS_ATTENTION',
        usedSeconds: { increment: Math.ceil((Date.now() - (a.run.activeStartedAt?.getTime() ?? Date.now())) / 1000) }, activeStartedAt: null } });
      await tx.attempt.update({ where: { id: attemptId }, data: { status: 'FAILED', endedAt: new Date() } });
      await tx.task.update({ where: { id: a.run.taskId }, data: { status: 'NEEDS_ATTENTION', attentionReason: reason } });
      if (patch) await tx.artifact.create({ data: { runId: a.runId, attemptId, kind: 'PATCH', name: 'candidate.patch', content: patch, sizeBytes: Buffer.byteLength(patch) } });
      await this.event(tx, a.runId, a.run.status, 'INTERRUPTED');
      return { status: 'NEEDS_ATTENTION' };
    }, false);
  }
  async pauseRun(runId: string) {
    const attempt = await this.prisma.attempt.findFirst({ where: { runId, status: 'RUNNING' }, orderBy: { no: 'desc' } });
    if (!attempt?.leaseToken) throw new ConflictException('No active attempt to pause');
    return this.pause(attempt.id, attempt.leaseToken, 'PAUSED_BY_USER');
  }
  async cancel(runId: string) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT id FROM "Run" WHERE id = ${runId} FOR UPDATE`;
      const run = await tx.run.findUniqueOrThrow({ where: { id: runId } });
      if (run.status === 'CANCELLED') return { status: 'CANCELLED' };
      if (['SUCCEEDED', 'FAILED'].includes(run.status)) throw new ConflictException('Run is terminal');
      await tx.run.update({ where: { id: runId }, data: { status: 'CANCELLED', phase: 'CANCELLED', usedSeconds: { increment: run.activeStartedAt ? Math.ceil((Date.now() - run.activeStartedAt.getTime()) / 1000) : 0 }, activeStartedAt: null } });
      await tx.task.update({ where: { id: run.taskId }, data: { status: 'CANCELLED' } });
      await tx.attempt.updateMany({ where: { runId, status: { in: ['RUNNING', 'CLAIMED'] } }, data: { status: 'FAILED', failureCode: 'CANCELLED_BY_USER', endedAt: new Date() } });
      await this.event(tx, runId, run.status, 'CANCELLED');
      return { status: 'CANCELLED' };
    });
  }
  async resume(runId: string) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT id FROM "Run" WHERE id = ${runId} FOR UPDATE`;
      const run = await tx.run.findUniqueOrThrow({ where: { id: runId }, include: { task: { include: { project: true } }, attempts: true, budgetCalls: true } });
      if (run.status !== 'INTERRUPTED' || !run.task.snapshot) throw new ConflictException('Only paused snapshot tasks can resume');
      if (run.usedTokens >= run.budgetTokens || run.usedSeconds >= run.budgetSeconds || run.attempts.length >= run.maxAttempts ||
        run.budgetCalls.some((c) => c.status !== 'SETTLED') || (run.deadlineAt && run.deadlineAt <= new Date())) throw new ConflictException('Budget, attempts or unresolved usage prevents resume');
      if (['NOT_REPRODUCED', 'EVIDENCE_MISMATCH', 'CONTRACT_CHANGED'].includes(run.task.attentionReason ?? '')) throw new ConflictException('Revise the acceptance contract in a new task');
      const checkpoint = await tx.checkpoint.findFirst({ where: { runId }, orderBy: { createdAt: 'desc' } });
      const command = commandFromSnapshot(TaskSnapshotSchema.parse(run.task.snapshot), run.task.project.repoPath,
        runId, Math.max(0, ...run.attempts.map((a) => a.no)) + 1, run.usedTokens, run.usedSeconds, checkpoint?.id);
      await tx.run.update({ where: { id: runId }, data: { status: 'DISPATCHED', phase: 'QUEUED' } });
      await tx.task.update({ where: { id: run.taskId }, data: { status: 'QUEUED', attentionReason: null } });
      await tx.outboxMessage.create({ data: { topic: 'run-commands', key: runId, payload: command } });
      await this.event(tx, runId, run.status, 'DISPATCHED');
      return { status: 'QUEUED' };
    });
  }
}
