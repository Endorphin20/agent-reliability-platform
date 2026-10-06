import { ConflictException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

export function availableBudget(limit: number, calls: Array<{ reserved: number; used: number | null }>) {
  return Math.max(0, limit - calls.reduce((total, call) => total + (call.used ?? call.reserved), 0));
}
@Injectable()
export class BudgetService {
  constructor(private readonly prisma: PrismaService) {}
  async reserve(runId: string, attemptId: string, leaseToken: string, id: string, reserved: number) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT id FROM "Run" WHERE id = ${runId} FOR UPDATE`;
      const run = await tx.run.findUniqueOrThrow({ where: { id: runId }, include: { budgetCalls: true } });
      const attempt = await tx.attempt.findFirst({ where: { id: attemptId, runId, leaseToken,
        status: 'RUNNING', leaseExpiresAt: { gt: new Date() } } });
      if (!attempt || !['RUNNING', 'VERIFYING'].includes(run.status)) throw new ConflictException('Execution lease is no longer valid');
      if (run.deadlineAt && run.deadlineAt <= new Date()) throw new ConflictException('Task expired');
      const elapsed = run.usedSeconds + (run.activeStartedAt ? (Date.now() - run.activeStartedAt.getTime()) / 1000 : 0);
      if (elapsed >= run.budgetSeconds) throw new ConflictException('Task time budget exhausted');
      const prior = await tx.budgetCall.findUnique({ where: { id } });
      if (prior) throw new ConflictException('Model request already reserved; reconcile instead of repeating it');
      if (availableBudget(run.budgetTokens, run.budgetCalls) < reserved) throw new ConflictException('Task token budget exhausted');
      const call = await tx.budgetCall.create({ data: { id, runId, reserved } });
      return { ...call, remainingSeconds: Math.max(0, run.budgetSeconds - elapsed) };
    });
  }
  async settle(runId: string, id: string, used: number | null) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT id FROM "Run" WHERE id = ${runId} FOR UPDATE`;
      const call = await tx.budgetCall.findUniqueOrThrow({ where: { id } });
      if (call.runId !== runId) throw new ConflictException('Call belongs to another task');
      if (call.status === 'SETTLED') {
        if (call.used !== used) throw new ConflictException('Conflicting model usage');
        return call;
      }
      const result = await tx.budgetCall.update({ where: { id }, data: { used, status: used === null ? 'UNKNOWN' : 'SETTLED' } });
      const calls = await tx.budgetCall.findMany({ where: { runId } });
      await tx.run.update({ where: { id: runId }, data: { usedTokens: calls.reduce((n, c) => n + (c.used ?? c.reserved), 0) } });
      return result;
    });
  }
}
