import { GitStore } from '../repository/git-store';
import { RunCommandSchema } from '@arp/shared';
import { randomUUID, createHash } from 'node:crypto';
import { TaskSnapshotSchema } from '@arp/shared';
import { commandFromSnapshot } from '../task/task-snapshot.service';
import { assertDemoInput, assertDemoCapacity } from './public-demo';
import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type {
  AgentKind,
  FailureCode,
  RunCommand,
  RunStatus,
  TaskStatus,
  VerifierStep,
} from '@arp/shared';
import { runCommandId } from '@arp/shared';
import { loadEnv } from '../../config/env';
import type { PrismaClient } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { runStateMachine, taskStateMachine } from '../../state-machine/state-machine';
import { RunEventsBus } from '../events/run-events.bus';
import { FixtureRegistry } from '../fixture/fixture-registry';
import { decidePolicy } from '../policy/policy-engine';

type Tx = Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$extends'>;

/**
 * Run 生命周期编排：建任务、认领、心跳、完结、失败恢复决策。
 * 所有状态迁移必须过状态机断言；所有跨表写操作在同一事务内（含 Outbox）。
 */
@Injectable()
export class RunLifecycleService {
  private readonly logger = new Logger(RunLifecycleService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly fixtures: FixtureRegistry,
    private readonly bus: RunEventsBus,
  ) {}

  /** 同事务内分配 runSequence 并落一条平台合成事件（STATE_TRANSITION / RECOVERY_ACTION 等） */
  private async appendSyntheticEvent(
    tx: Tx,
    runId: string,
    type: 'STATE_TRANSITION' | 'RECOVERY_ACTION' | 'APPROVAL_EVENT',
    payload: Record<string, unknown>,
    attemptId: string | null = null,
  ) {
    const run = await tx.run.update({
      where: { id: runId },
      data: { lastSequence: { increment: 1 } },
      select: { lastSequence: true },
    });
    await tx.traceEvent.create({
      data: {
        runId,
        attemptId,
        runSequence: run.lastSequence,
        attemptSequence: 0, // 平台合成事件不占 attempt 序列
        type,
        payload: payload as object,
        idempotencyKey: `cp:${runId}:${run.lastSequence}`,
        occurredAt: new Date(),
      },
    });
    // SSE reads committed events from PostgreSQL; never broadcast an uncommitted transition.
  }

  private async transitionRun(tx: Tx, runId: string, from: RunStatus, to: RunStatus) {
    runStateMachine.assertTransition(from, to);
    const result = await tx.run.updateMany({
      where: { id: runId, status: from },
      data: { status: to },
    });
    if (result.count === 0) {
      throw new ConflictException(`Run ${runId} 状态不是 ${from}，迁移到 ${to} 失败`);
    }
    await this.appendSyntheticEvent(tx, runId, 'STATE_TRANSITION', {
      entity: 'run',
      from,
      to,
    });
  }

  private async transitionTask(tx: Tx, taskId: string, from: TaskStatus, to: TaskStatus) {
    taskStateMachine.assertTransition(from, to);
    const result = await tx.task.updateMany({
      where: { id: taskId, status: from },
      data: { status: to },
    });
    if (result.count === 0) {
      throw new ConflictException(`Task ${taskId} 状态不是 ${from}，迁移到 ${to} 失败`);
    }
  }

  private buildRunCommand(params: {
    type: 'START_RUN' | 'RESUME_RUN';
    runId: string;
    attemptNo: number;
    agentKind: AgentKind;
    fixtureId: string;
    checkpointId?: string;
    remainingTokens: number;
    remainingSeconds: number;
    budgetTokens: number;
    budgetSeconds: number;
    budgetTurns: number;
  }): RunCommand {
    const fixture = this.fixtures.get(params.fixtureId);
    return {
      commandId: runCommandId(params.runId, params.type, params.attemptNo),
      type: params.type,
      runId: params.runId,
      attemptNo: params.attemptNo,
      agentKind: params.agentKind,
      repo: { path: fixture.repoPath, baseCommit: fixture.baseCommit },
      taskSpec: fixture.taskSpec,
      budget: {
        tokens: params.budgetTokens,
        seconds: params.budgetSeconds,
        turns: params.budgetTurns,
        remainingTokens: params.remainingTokens,
        remainingSeconds: params.remainingSeconds,
      },
      ...(params.checkpointId ? { checkpointId: params.checkpointId } : {}),
    };
  }

  /** POST /api/tasks：Task + Run + OutboxMessage 同事务写入（Transactional Outbox） */
  async createTask(input: {
    fixtureId: string;
    agentKind: AgentKind;
    recoveryDisabled?: boolean;
    feedbackMode?: 'structured' | 'raw';
    budgetTokens?: number;
    budgetSeconds?: number;
    budgetTurns?: number;
    // GitHub webhook 触发时为 GITHUB_ISSUE + issue URL
    source?: 'MANUAL' | 'GITHUB_ISSUE';
    sourceRef?: string;
  }) {
    const demo = process.env.ARP_PUBLIC_DEMO === 'true';
    if (demo) {
      assertDemoInput(input);
      input = { ...input, budgetTokens: 10000, budgetSeconds: 180, budgetTurns: 10 };
    }
    const fixture = this.fixtures.get(input.fixtureId);
    const baseCommit = fixture.id === 'fake' ? fixture.baseCommit : await new GitStore().resolve(fixture.repoPath, fixture.baseCommit);
    return this.prisma.$transaction(async (tx) => {
      if (demo) {
        // Serialize admission across API processes, not just within this instance.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(72819001)`;
        const active = await tx.run.count({ where: { status: { in: ['PENDING', 'DISPATCHED', 'RUNNING', 'VERIFYING', 'RECOVERING'] } } });
        const midnight = new Date(); midnight.setUTCHours(0, 0, 0, 0);
        const today = await tx.task.count({ where: { createdAt: { gte: midnight } } });
        assertDemoCapacity(active, today);
      }
      const project = await this.ensureDefaultProject(tx);
      const task = await tx.task.create({
        data: {
          projectId: project.id,
          title: fixture.title,
          description: fixture.taskSpec.description,
          source: input.source ?? 'MANUAL',
          sourceRef: input.sourceRef,
          fixtureId: fixture.id,
          status: 'CREATED',
          allowedPaths: fixture.taskSpec.allowedPaths,
        },
      });
      const run = await tx.run.create({
        data: {
          taskId: task.id,
          agentKind: input.agentKind,
          baseCommit,
          recoveryDisabled: input.recoveryDisabled ?? false,
          feedbackMode: input.feedbackMode ?? 'structured',
          ...(input.budgetTokens ? { budgetTokens: input.budgetTokens } : {}),
          ...(input.budgetSeconds ? { budgetSeconds: input.budgetSeconds } : {}),
          ...(input.budgetTurns ? { budgetTurns: input.budgetTurns } : {}),
        },
      });
      await this.transitionTask(tx, task.id, 'CREATED', 'QUEUED');
      const command = this.buildRunCommand({
        type: 'START_RUN',
        runId: run.id,
        attemptNo: 1,
        agentKind: input.agentKind,
        fixtureId: fixture.id,
        remainingTokens: run.budgetTokens,
        remainingSeconds: run.budgetSeconds,
        budgetTokens: run.budgetTokens,
        budgetSeconds: run.budgetSeconds,
        budgetTurns: run.budgetTurns,
      });
      command.repo.baseCommit = baseCommit;
      await tx.outboxMessage.create({
        data: { topic: 'run-commands', key: run.id, payload: command as object },
      });
      await this.transitionRun(tx, run.id, 'PENDING', 'DISPATCHED');
      return { taskId: task.id, runId: run.id };
    });
  }

  private async ensureDefaultProject(tx: Tx) {
    const existing = await tx.project.findFirst({ where: { name: 'default' } });
    if (existing) return existing;
    const workspace = await tx.workspace.create({ data: { name: 'default' } });
    return tx.project.create({
      data: { workspaceId: workspace.id, name: 'default', repoPath: '' },
    });
  }

  /** Worker 认领（幂等：重复投递返回已存在的 Attempt） */
  async claimAttempt(input: { runId: string; attemptNo: number; workerId: string }) {
    const env = loadEnv();
    const run = await this.prisma.run.findUnique({ where: { id: input.runId } });
    if (!run) throw new NotFoundException(`Run ${input.runId} 不存在`);

    const existing = await this.prisma.attempt.findUnique({
      where: { runId_no: { runId: input.runId, no: input.attemptNo } },
    });
    if (existing) {
      return { attemptId: existing.id, leaseTtlMs: env.LEASE_TTL_MS, duplicate: true };
    }

    if (run.status !== 'DISPATCHED') throw new ConflictException('Run is not dispatchable');
    const attempt = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT id FROM "Run" WHERE id = ${input.runId} FOR UPDATE`;
      const current = await tx.run.findUniqueOrThrow({ where: { id: input.runId } });
      const latest = await tx.attempt.findFirst({ where: { runId: input.runId }, orderBy: { no: 'desc' } });
      if (current.status !== 'DISPATCHED' || input.attemptNo !== (latest?.no ?? 0) + 1 || input.attemptNo > current.maxAttempts) throw new ConflictException('Attempt is not dispatchable');
      const created = await tx.attempt.create({
        data: {
          runId: input.runId,
          no: input.attemptNo,
          workerId: input.workerId,
          leaseToken: randomUUID(),
          status: 'RUNNING',
          leaseExpiresAt: new Date(Date.now() + env.LEASE_TTL_MS),
        },
      });
      await this.transitionRun(tx, input.runId, 'DISPATCHED', 'RUNNING');
      await tx.run.update({ where: { id: input.runId }, data: { activeStartedAt: run.activeStartedAt ?? new Date() } });
      const task = await tx.task.findUniqueOrThrow({ where: { id: run.taskId } });
      if (task.status === 'QUEUED') {
        await this.transitionTask(tx, task.id, 'QUEUED', 'RUNNING');
      }
      return created;
    });
    return { attemptId: attempt.id, leaseToken: attempt.leaseToken, leaseTtlMs: env.LEASE_TTL_MS, duplicate: false };
  }

  async heartbeat(attemptId: string) {
    const env = loadEnv();
    const result = await this.prisma.attempt.updateMany({
      where: { id: attemptId, status: { in: ['CLAIMED', 'RUNNING'] } },
      data: { leaseExpiresAt: new Date(Date.now() + env.LEASE_TTL_MS) },
    });
    if (result.count === 0) {
      throw new ConflictException(`Attempt ${attemptId} 不在可续租状态（可能已被判定 LEASE_EXPIRED）`);
    }
    return { leaseTtlMs: env.LEASE_TTL_MS };
  }

  /** Worker 上报 attempt 完结（成功 / 失败），可携带 Verifier 结果、最终补丁与预算用量 */
  async completeAttempt(
    attemptId: string,
    outcome: (
      | { status: 'SUCCEEDED' }
      | { status: 'FAILED'; failureCode: FailureCode }
    ) & {
      usedTokens?: number;
      usedSeconds?: number;
      verification?: Array<{
        step: VerifierStep;
        passed: boolean;
        failureCode: FailureCode | null;
        detail: Record<string, unknown>;
        durationMs: number;
      }>;
      patch?: string;
      judge?: Record<string, unknown>;
    },
  ) {
    const attempt = await this.prisma.attempt.findUnique({
      where: { id: attemptId },
      include: { run: { include: { task: true } } },
    });
    if (!attempt) throw new NotFoundException(`Attempt ${attemptId} 不存在`);
    if (attempt.status !== 'RUNNING') {
      // 幂等：重复上报直接返回当前状态
      return { attemptStatus: attempt.status, runStatus: attempt.run.status };
    }

    const persistExtras = async (tx: Tx) => {
      if (attempt.run.task.snapshot) {
        const current = await tx.run.findUniqueOrThrow({ where: { id: attempt.runId } });
        await tx.run.update({ where: { id: current.id }, data: {
          usedSeconds: { increment: current.activeStartedAt ? Math.ceil((Date.now() - current.activeStartedAt.getTime()) / 1000) : 0 },
          activeStartedAt: null,
        } });
      }
      if (outcome.usedTokens !== undefined || outcome.usedSeconds !== undefined) {
        await tx.run.update({
          where: { id: attempt.runId },
          data: {
            ...(!attempt.run.task.snapshot && outcome.usedTokens !== undefined ? { usedTokens: Math.max(attempt.run.usedTokens, outcome.usedTokens) } : {}),
            ...(!attempt.run.task.snapshot && outcome.usedSeconds !== undefined
              ? { usedSeconds: { increment: outcome.usedSeconds } }
              : {}),
          },
        });
      }
      for (const result of outcome.verification ?? []) {
        await tx.verificationResult.create({
          data: {
            runId: attempt.runId,
            attemptId,
            step: result.step,
            passed: result.passed,
            failureCode: result.failureCode,
            detail: result.detail as object,
            durationMs: result.durationMs,
          },
        });
      }
      if (outcome.patch) {
        await tx.artifact.create({
          data: {
            runId: attempt.runId,
            attemptId,
            kind: 'PATCH',
            name: 'fix.patch',
            content: outcome.patch,
            sizeBytes: Buffer.byteLength(outcome.patch),
          },
        });
      }
      if (outcome.judge) {
        const content = JSON.stringify(outcome.judge);
        await tx.artifact.create({
          data: {
            runId: attempt.runId,
            attemptId,
            kind: 'JUDGE_REPORT',
            name: 'judge-report.json',
            content,
            sizeBytes: Buffer.byteLength(content),
          },
        });
      }
    };

    if (outcome.status === 'SUCCEEDED') {
      await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT id FROM "Run" WHERE id = ${attempt.runId} FOR UPDATE`;
        const owner = await tx.attempt.findUniqueOrThrow({ where: { id: attemptId } });
        if (owner.status !== 'RUNNING' || !owner.leaseExpiresAt || owner.leaseExpiresAt <= new Date()) throw new ConflictException('Attempt lease expired');
        if (attempt.run.task.snapshot && await tx.budgetCall.count({ where: { runId: attempt.runId, status: { not: 'SETTLED' } } })) throw new ConflictException('Unsettled model usage prevents approval');
        await tx.attempt.update({
          where: { id: attemptId },
          data: { status: 'SUCCEEDED', endedAt: new Date() },
        });
        await persistExtras(tx);
        // Verifier 在 Runtime 内执行，上报 SUCCEEDED 即六步全过；
        // 平台侧补 VERIFYING -> SUCCEEDED 两次迁移让 timeline 完整。
        await this.transitionRun(tx, attempt.runId, 'RUNNING', 'VERIFYING');
        await this.transitionRun(tx, attempt.runId, 'VERIFYING', 'SUCCEEDED');
        await this.transitionTask(tx, attempt.run.taskId, 'RUNNING', 'AWAITING_APPROVAL');
        await tx.run.update({ where: { id: attempt.runId }, data: { phase: 'AWAITING_APPROVAL' } });
        await tx.approval.create({
          data: { taskId: attempt.run.taskId, runId: attempt.runId,
            patchDigest: outcome.patch ? createHash('sha256').update(outcome.patch).digest('hex') : null },
        });
        await this.appendSyntheticEvent(tx, attempt.runId, 'APPROVAL_EVENT', {
          status: 'PENDING',
          reviewer: null,
          prUrl: null,
        });
      });
      return { attemptStatus: 'SUCCEEDED', runStatus: 'SUCCEEDED' };
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT id FROM "Run" WHERE id = ${attempt.runId} FOR UPDATE`;
      const owner = await tx.attempt.findUniqueOrThrow({ where: { id: attemptId } });
      if (owner.status !== 'RUNNING') throw new ConflictException('Attempt no longer running');
      await tx.attempt.update({
        where: { id: attemptId },
        data: { status: 'FAILED', failureCode: outcome.failureCode, endedAt: new Date() },
      });
      await persistExtras(tx);
      const run = attempt.run;
      if (run.status === 'RUNNING' || run.status === 'VERIFYING' || run.status === 'DISPATCHED') {
        await this.transitionRun(tx, run.id, run.status, 'INTERRUPTED');
      }
      await this.applyPolicy(tx, run.id, attemptId, attempt.no, outcome.failureCode);
    });
    const run = await this.prisma.run.findUniqueOrThrow({ where: { id: attempt.runId } });
    return { attemptStatus: 'FAILED', runStatus: run.status };
  }

  /** Runtime 每轮工具执行后落平台层 Checkpoint（双层检查点之一） */
  async saveCheckpoint(
    runId: string,
    input: {
      attemptId: string;
      threadId: string;
      baseCommit: string;
      appliedPatchSha: string | null;
      appliedPatch: string | null;
      completedToolCalls: Record<string, string>;
      usedTokens: number;
      usedSeconds: number;
    },
  ) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT id FROM "Run" WHERE id = ${runId} FOR UPDATE`;
      const run = await tx.run.findUniqueOrThrow({ where: { id: runId }, include: { task: true } });
      const attempt = await tx.attempt.findUniqueOrThrow({ where: { id: input.attemptId } });
      if (attempt.runId !== runId || attempt.status !== 'RUNNING' ||
        !attempt.leaseExpiresAt || attempt.leaseExpiresAt <= new Date() ||
        !['RUNNING', 'VERIFYING'].includes(run.status) || input.baseCommit !== run.baseCommit) {
        throw new ConflictException('Checkpoint writer no longer owns a running attempt');
      }
      const checkpoint = await tx.checkpoint.create({ data: { runId, ...input } });
      if (!run.task.snapshot) await tx.run.updateMany({
        where: { id: runId, usedTokens: { lt: input.usedTokens } }, data: { usedTokens: input.usedTokens },
      });
      return { checkpointId: checkpoint.id };
    });
  }

  /** RESUME 时 Runtime 拉取 checkpoint + 上一次失败上下文（用于反馈注入） */
  async getCheckpoint(checkpointId: string) {
    const checkpoint = await this.prisma.checkpoint.findUnique({ where: { id: checkpointId } });
    if (!checkpoint) throw new NotFoundException(`Checkpoint ${checkpointId} 不存在`);
    const run = await this.prisma.run.findUniqueOrThrow({ where: { id: checkpoint.runId } });
    const lastFailedAttempt = await this.prisma.attempt.findFirst({
      where: { runId: checkpoint.runId, status: { in: ['FAILED', 'LEASE_EXPIRED'] } },
      orderBy: { no: 'desc' },
    });
    const lastFailedVerification = lastFailedAttempt
      ? await this.prisma.verificationResult.findFirst({
          where: { attemptId: lastFailedAttempt.id, passed: false },
          orderBy: { createdAt: 'desc' },
        })
      : null;
    return {
      id: checkpoint.id,
      runId: checkpoint.runId,
      feedbackMode: run.feedbackMode, // structured | raw（T11 实验三）
      threadId: checkpoint.threadId,
      baseCommit: checkpoint.baseCommit,
      appliedPatchSha: checkpoint.appliedPatchSha,
      appliedPatch: checkpoint.appliedPatch,
      completedToolCalls: checkpoint.completedToolCalls,
      usedTokens: checkpoint.usedTokens,
      usedSeconds: checkpoint.usedSeconds,
      lastFailure: lastFailedAttempt
        ? {
            failureCode: lastFailedAttempt.failureCode,
            verification: lastFailedVerification
              ? {
                  step: lastFailedVerification.step,
                  detail: lastFailedVerification.detail,
                }
              : null,
          }
        : null,
    };
  }

  /** LeaseMonitor 判定 Worker 失联 */
  async handleLeaseExpired(attemptId: string) {
    const attempt = await this.prisma.attempt.findUnique({
      where: { id: attemptId },
      include: { run: true },
    });
    if (!attempt || (attempt.status !== 'RUNNING' && attempt.status !== 'CLAIMED')) return;

    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT id FROM "Run" WHERE id = ${attempt.runId} FOR UPDATE`;
      const marked = await tx.attempt.updateMany({
        where: { id: attemptId, status: { in: ['CLAIMED', 'RUNNING'] }, leaseExpiresAt: { lte: new Date() } },
        data: { status: 'LEASE_EXPIRED', failureCode: 'WORKER_LOST', endedAt: new Date() },
      });
      if (marked.count === 0) return; // 已被并发处理
      const run = attempt.run;
      if (run.status === 'RUNNING' || run.status === 'VERIFYING' || run.status === 'DISPATCHED') {
        await this.transitionRun(tx, run.id, run.status, 'INTERRUPTED');
      }
      await this.applyPolicy(tx, run.id, attemptId, attempt.no, 'WORKER_LOST');
    });
  }

  /**
   * 按 §4.7 决策表处理失败：写 PolicyDecision + RECOVERY_ACTION 事件，
   * RESUME / RESTART_ATTEMPT 经 Outbox 重新投递。
   */
  private async applyPolicy(
    tx: Tx,
    runId: string,
    attemptId: string,
    attemptNo: number,
    failureCode: FailureCode,
  ) {
    const run = await tx.run.findUniqueOrThrow({ where: { id: runId }, include: { task: { include: { project: true } } } });
    if (run.task.snapshot && run.activeStartedAt) {
      const elapsed = Math.ceil((Date.now() - run.activeStartedAt.getTime()) / 1000);
      run.usedSeconds += elapsed;
      run.activeStartedAt = null;
      await tx.run.update({ where: { id: runId }, data: { usedSeconds: run.usedSeconds, activeStartedAt: null } });
    }
    if (run.task.snapshot) {
      const unresolved = await tx.budgetCall.count({ where: { runId, status: { not: 'SETTLED' } } });
      const elapsed = run.usedSeconds + (run.activeStartedAt ? Math.ceil((Date.now() - run.activeStartedAt.getTime()) / 1000) : 0);
      if (unresolved || run.usedTokens >= run.budgetTokens || elapsed >= run.budgetSeconds || (run.deadlineAt && run.deadlineAt <= new Date())) {
        await tx.run.update({ where: { id: runId }, data: { phase: 'NEEDS_ATTENTION', usedSeconds: elapsed, activeStartedAt: null } });
        await tx.task.update({ where: { id: run.taskId }, data: { status: 'NEEDS_ATTENTION', attentionReason: unresolved ? 'MODEL_USAGE_UNKNOWN' : 'BUDGET_EXHAUSTED' } });
        return;
      }
    }
    const decision = run.recoveryDisabled
      ? {
          action: 'ABORT' as const,
          backoffMs: 0,
          reason: `${failureCode} @ attempt ${attemptNo} -> ABORT（--no-recovery 实验：恢复已禁用）`,
        }
      : decidePolicy({ failureCode, attemptNo, maxAttempts: run.maxAttempts });
    await tx.policyDecision.create({
      data: { runId, attemptId, failureCode, action: decision.action, reason: decision.reason },
    });
    this.logger.log(`Policy: ${decision.reason}`);

    if (decision.action === 'RESUME' || decision.action === 'RESTART_ATTEMPT') {
      if (run.task.snapshot) {
        run.usedSeconds += Math.ceil(decision.backoffMs / 1000);
        await tx.run.update({ where: { id: runId }, data: { usedSeconds: run.usedSeconds, phase: 'QUEUED' } });
        if (run.usedSeconds >= run.budgetSeconds) {
          await tx.run.update({ where: { id: runId }, data: { phase: 'NEEDS_ATTENTION' } });
          await tx.task.update({ where: { id: run.taskId }, data: { status: 'NEEDS_ATTENTION', attentionReason: 'BUDGET_EXHAUSTED' } });
          return;
        }
      }
      const checkpoint =
        decision.action === 'RESUME'
          ? await tx.checkpoint.findFirst({ where: { runId }, orderBy: { createdAt: 'desc' } })
          : null;
      const nextAttemptNo = attemptNo + 1;
      await this.transitionRun(tx, runId, 'INTERRUPTED', 'RECOVERING');
      const command = run.task.snapshot ? commandFromSnapshot(TaskSnapshotSchema.parse(run.task.snapshot),
        run.task.project.repoPath, runId, nextAttemptNo, run.usedTokens, run.usedSeconds, checkpoint?.id) : this.buildRunCommand({
        type: decision.action === 'RESUME' && checkpoint ? 'RESUME_RUN' : 'START_RUN',
        runId,
        attemptNo: nextAttemptNo,
        agentKind: run.agentKind,
        fixtureId: run.task.fixtureId ?? 'fake',
        checkpointId: checkpoint?.id,
        remainingTokens: Math.max(0, run.budgetTokens - run.usedTokens),
        remainingSeconds: Math.max(0, run.budgetSeconds - run.usedSeconds),
        budgetTokens: run.budgetTokens,
        budgetSeconds: run.budgetSeconds,
        budgetTurns: run.budgetTurns,
      });
      if (!run.task.snapshot) {
        const original = await tx.outboxMessage.findFirst({ where: { key: runId, topic: 'run-commands' }, orderBy: { createdAt: 'asc' } });
        if (original) {
          const frozen = RunCommandSchema.parse(original.payload);
          command.repo = frozen.repo;
          command.taskSpec = frozen.taskSpec;
        }
      }
      await tx.outboxMessage.create({
        data: { topic: 'run-commands', key: runId, payload: command as object, notBefore: new Date(Date.now() + decision.backoffMs) },
      });
      await this.appendSyntheticEvent(
        tx,
        runId,
        'RECOVERY_ACTION',
        {
          action: decision.action,
          fromCheckpointId: checkpoint?.id ?? null,
          newAttemptNo: nextAttemptNo,
        },
        attemptId,
      );
      await this.transitionRun(tx, runId, 'RECOVERING', 'DISPATCHED');
      return;
    }

    if (decision.action === 'ABORT') {
      await tx.run.update({ where: { id: runId }, data: { phase: 'FAILED', activeStartedAt: null } });
      await this.transitionRun(tx, runId, 'INTERRUPTED', 'FAILED');
      if (run.task.status === 'RUNNING') {
        await this.transitionTask(tx, run.task.id, 'RUNNING', 'FAILED');
      }
      return;
    }

    await tx.run.update({ where: { id: runId }, data: { phase: 'NEEDS_ATTENTION', activeStartedAt: null } });
    await tx.task.update({ where: { id: run.taskId }, data: { status: 'NEEDS_ATTENTION', attentionReason: failureCode } });
    // ESCALATE_HUMAN：Run 停在 INTERRUPTED，等待人工介入（取消或手动重试）
  }
}
