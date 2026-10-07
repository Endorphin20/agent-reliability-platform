import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { GitStore } from '../repository/git-store';
import { RepositoryService } from '../repository/repository.service';
import { TaskDraftService } from './task-draft.service';
import { PrImportService } from '../github/pr-import.service';
import { CredentialStore } from '../credentials/credential-store';
import { RunLifecycleService } from '../run/run-lifecycle.service';
import { RunEventsBus } from '../events/run-events.bus';
import { FixtureRegistry } from '../fixture/fixture-registry';
import { RunControlService } from '../run/run-control.service';
import { DeliveryService } from '../github/delivery.service';
import { BudgetService } from '../run/budget.service';

const integration = process.env.ARP_INTEGRATION_TESTS === 'true' ? describe : describe.skip;
integration('local PR task lifecycle with PostgreSQL and Git', () => {
  let prisma: PrismaService;
  let root: string;
  let repositories: RepositoryService;
  let drafts: TaskDraftService;
  let lifecycle: RunLifecycleService;
  let controls: RunControlService;
  let budgets: BudgetService;
  const git = new GitStore();
  const config = { runtime: 'python-pytest', preparation: 'image', image: 'arp-sandbox:latest', dependencyFiles: [],
    workdir: '.', allowedPaths: ['src/**'], protectedPaths: ['tests/**'], staticCheck: [], failToPass: ['pytest'], passToPass: [], acceptanceCriteria: ['fixed'] };
  beforeAll(async () => {
    if (!process.env.DATABASE_URL?.includes('arp_local_pr_test')) throw new Error('Use the isolated arp_local_pr_test database');
    prisma = new PrismaService(); await prisma.$connect();
    root = mkdtempSync(join(tmpdir(), 'arp-task-integration-'));
    execFileSync('git', ['init', '-b', 'main', root]);
    writeFileSync(join(root, 'file.txt'), 'first');
    execFileSync('git', ['-C', root, 'add', '.']);
    execFileSync('git', ['-C', root, '-c', 'user.name=ARP', '-c', 'user.email=arp@test', 'commit', '-m', 'first']);
    repositories = new RepositoryService(prisma, git);
    drafts = new TaskDraftService(prisma, repositories, git, new PrImportService(new CredentialStore()));
    lifecycle = new RunLifecycleService(prisma, new FixtureRegistry(), new RunEventsBus());
    controls = new RunControlService(prisma); budgets = new BudgetService(prisma);
  });
  afterAll(async () => { await prisma?.$disconnect(); if (root) rmSync(root, { recursive: true, force: true }); });
  async function create() {
    const repo = await repositories.create({ name: 'test', repoPath: root, repoUrl: 'https://github.com/example/repo', defaultBranch: 'main', config });
    const sha = await git.resolve(root, 'HEAD');
    const draft = await drafts.create({ schemaVersion: 2, mode: 'REAL', repositoryId: repo.id, configVersion: 1,
      executionSha: sha, agentKind: 'SELF_LANGGRAPH', title: 'bug', description: 'fix', config,
      baseline: { command: 'pytest', expected: ['test_bug'] }, budget: { tokens: 1000, seconds: 900, turns: 20, maxAttempts: 3 },
      delivery: { kind: 'patch', targetBranch: 'main', expectedTargetSha: sha } });
    const key = randomUUID();
    const created = await drafts.confirm(draft.id, 1, key, true, false);
    return { ...created, repo, draft, sha, key };
  }
  it('confirmation is idempotent and freezes inputs across source/config changes', async () => {
    const first = await create();
    const results = await Promise.all([drafts.confirm(first.draft.id, 1, first.key, true, false), drafts.confirm(first.draft.id, 1, first.key, true, false)]);
    expect(results).toEqual([{ taskId: first.taskId, runId: first.runId }, { taskId: first.taskId, runId: first.runId }]);
    await repositories.configure(first.repo.id, { ...config, image: 'changed' });
    writeFileSync(join(root, 'file.txt'), randomUUID());
    execFileSync('git', ['-C', root, '-c', 'user.name=ARP', '-c', 'user.email=arp@test', 'commit', '-am', 'next']);
    const run = await prisma.run.findUniqueOrThrow({ where: { id: first.runId }, include: { task: true } });
    expect(run.baseCommit).toBe(first.sha);
    expect((run.task.snapshot as any).config.image).toBe('arp-sandbox:latest');
    const outbox = await prisma.outboxMessage.findMany({ where: { key: run.id } });
    expect(outbox).toHaveLength(1);
    expect((outbox[0].payload as any).repo.baseCommit).toBe(first.sha);
  });
  it('reserves usage across attempts and fences stopped executors', async () => {
    const { runId } = await create();
    const claim = await lifecycle.claimAttempt({ runId, attemptNo: 1, workerId: 'test-worker' });
    const id = randomUUID();
    await budgets.reserve(runId, claim.attemptId, claim.leaseToken!, id, 800);
    await expect(budgets.reserve(runId, claim.attemptId, claim.leaseToken!, randomUUID(), 300)).rejects.toThrow();
    await budgets.settle(runId, id, 700); await budgets.settle(runId, id, 700);
    expect((await prisma.run.findUniqueOrThrow({ where: { id: runId } })).usedTokens).toBe(700);
    await controls.pause(claim.attemptId, claim.leaseToken!, 'TEMPORARY_ERROR');
    await controls.resume(runId);
    const message = await prisma.outboxMessage.findFirstOrThrow({ where: { key: runId }, orderBy: { createdAt: 'desc' } });
    expect((message.payload as any).budget.remainingTokens).toBe(300);
    await expect(controls.lease(claim.attemptId, claim.leaseToken!)).rejects.toThrow();
    await controls.cancel(runId);
    await expect(lifecycle.claimAttempt({ runId, attemptNo: 2, workerId: 'stale' })).rejects.toThrow();
  });
  it('does not let checkpoint accounting override the authoritative model ledger', async () => {
    const { runId, sha } = await create();
    const claim = await lifecycle.claimAttempt({ runId, attemptNo: 1, workerId: 'test-worker' });
    const id = randomUUID();
    await budgets.reserve(runId, claim.attemptId, claim.leaseToken!, id, 800);
    await budgets.settle(runId, id, 500);
    await lifecycle.saveCheckpoint(runId, { attemptId: claim.attemptId, threadId: runId,
      baseCommit: sha, appliedPatchSha: null, appliedPatch: null, completedToolCalls: {}, usedTokens: 900, usedSeconds: 1 });
    expect((await prisma.run.findUniqueOrThrow({ where: { id: runId } })).usedTokens).toBe(500);
  });
  it('rejects checkpoint writes from an expired attempt even through the lifecycle service', async () => {
    const { runId, sha } = await create();
    const claim = await lifecycle.claimAttempt({ runId, attemptNo: 1, workerId: 'test-worker' });
    await controls.cancel(runId);
    await expect(lifecycle.saveCheckpoint(runId, { attemptId: claim.attemptId, threadId: runId,
      baseCommit: sha, appliedPatchSha: null, appliedPatch: null, completedToolCalls: {}, usedTokens: 0, usedSeconds: 0 })).rejects.toThrow();
  });
  it('persists notifications without a browser and accounts for total active time', async () => {
    const { runId, taskId } = await create();
    const claim = await lifecycle.claimAttempt({ runId, attemptNo: 1, workerId: 'test-worker' });
    await prisma.run.update({ where: { id: runId }, data: { activeStartedAt: new Date(Date.now() - 10000) } });
    await lifecycle.completeAttempt(claim.attemptId, { status: 'SUCCEEDED', patch: 'test-patch', usedSeconds: 1 });
    const run = await prisma.run.findUniqueOrThrow({ where: { id: runId } });
    expect(run.usedSeconds).toBeGreaterThanOrEqual(10);
    expect(run.activeStartedAt).toBeNull();
    expect(run.phase).toBe('AWAITING_APPROVAL');
    const notifications = await prisma.notification.findMany({ where: { taskId } });
    expect(notifications).toHaveLength(1);
    expect(notifications[0].kind).toBe('ACTION_REQUIRED');
  });
  it('does not restart a lost worker with unresolved model usage', async () => {
    const { runId, taskId } = await create();
    const claim = await lifecycle.claimAttempt({ runId, attemptNo: 1, workerId: 'test-worker' });
    await budgets.reserve(runId, claim.attemptId, claim.leaseToken!, randomUUID(), 800);
    await prisma.attempt.update({ where: { id: claim.attemptId }, data: { leaseExpiresAt: new Date(0) } });
    await lifecycle.handleLeaseExpired(claim.attemptId);
    const task = await prisma.task.findUniqueOrThrow({ where: { id: taskId } });
    expect(task.attentionReason).toBe('MODEL_USAGE_UNKNOWN');
    expect(await prisma.outboxMessage.count({ where: { key: runId } })).toBe(1);
    await expect(controls.resume(runId)).rejects.toThrow();
  });

  it('serializes conflicting approval decisions for the same verified patch', async () => {
    const { runId, taskId } = await create();
    const claim = await lifecycle.claimAttempt({ runId, attemptNo: 1, workerId: 'test-worker' });
    await lifecycle.completeAttempt(claim.attemptId, { status: 'SUCCEEDED', patch: 'verified patch' });
    const approval = await prisma.approval.findUniqueOrThrow({ where: { taskId } });
    const deliveries = new DeliveryService(prisma, new CredentialStore(), new PrImportService(new CredentialStore()));
    const results = await Promise.allSettled([deliveries.approve(approval.id), deliveries.reject(approval.id)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const stored = await prisma.approval.findUniqueOrThrow({ where: { id: approval.id } });
    const task = await prisma.task.findUniqueOrThrow({ where: { id: taskId } });
    expect(task.status).toBe(stored.status === 'APPROVED' ? 'RESOLVED' : 'REJECTED');
  });
  it('returns the original confirmed task even after the draft expires', async () => {
    const first = await create();
    await prisma.taskDraft.update({ where: { id: first.draft.id }, data: { expiresAt: new Date(0) } });
    expect(await drafts.confirm(first.draft.id, 1, first.key, true, false)).toEqual({ taskId: first.taskId, runId: first.runId });
  });

});
