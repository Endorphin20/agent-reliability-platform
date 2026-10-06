import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { TaskSnapshotSchema } from '@arp/shared';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { RepositoryService } from '../repository/repository.service';
import { GitStore } from '../repository/git-store';
import { PrImportService } from '../github/pr-import.service';
import { commandFromSnapshot, digestSnapshot } from './task-snapshot.service';

@Injectable()
export class TaskDraftService {
  constructor(private readonly prisma: PrismaService, private readonly repositories: RepositoryService,
    private readonly git: GitStore, private readonly github: PrImportService) {}

  async create(raw: unknown) {
    const parsed = TaskSnapshotSchema.safeParse(raw);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const snapshot = parsed.data;
    if (snapshot.parentTaskId) {
      const parent = await this.prisma.task.findUniqueOrThrow({ where: { id: snapshot.parentTaskId } });
      if (parent.projectId !== snapshot.repositoryId) throw new BadRequestException('Successor must use the same repository');
    }
    if (snapshot.source && snapshot.source.headSha !== snapshot.executionSha) throw new BadRequestException('PR tasks must execute the imported head SHA');
    const repo = await this.repositories.get(snapshot.repositoryId);
    const version = repo.configs.find((c) => c.version === snapshot.configVersion);
    if (!version) throw new BadRequestException('Configuration version not found');
    // Commands and scope may be changed explicitly on a draft, but environment inputs must match its version.
    const saved = version.config as Record<string, unknown>;
    for (const key of ['runtime', 'preparation', 'image', 'dependencyFiles']) {
      if (digestSnapshot(saved[key]) !== digestSnapshot(snapshot.config[key])) throw new ConflictException(`Environment ${key} differs from saved configuration`);
    }
    await this.git.ensureCommit(repo.repoPath, repo.githubRepo!, snapshot.executionSha, repo.readCredential);
    const id = randomUUID();
    await this.git.pin(repo.repoPath, snapshot.executionSha, id);
    return this.prisma.taskDraft.create({ data: { id, projectId: repo.id, snapshot,
      expiresAt: new Date(Date.now() + 86400000) } });
  }
  async get(id: string) {
    const draft = await this.prisma.taskDraft.findUnique({ where: { id } });
    if (!draft) throw new NotFoundException('Draft not found');
    return draft;
  }
  async importPr(repositoryId: string, url: string) {
    const repo = await this.repositories.get(repositoryId);
    return this.github.inspect(url, repo.githubRepo!, repo.readCredential);
  }
  async workflowJobs(repositoryId: string, runId: number, attempt: number) {
    const repo = await this.repositories.get(repositoryId);
    const jobs: unknown[] = [];
    for (let page = 1; page <= 10; page++) {
      const result = await this.github.request(`/repos/${repo.githubRepo}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100&page=${page}`, repo.readCredential);
      jobs.push(...result.jobs.map((j: any) => ({ id: j.id, name: j.name, conclusion: j.conclusion, url: j.html_url, steps: j.steps })));
      if (result.jobs.length < 100) break;
    }
    return { jobs };
  }
  async jobLog(repositoryId: string, jobId: number) {
    const repo = await this.repositories.get(repositoryId);
    return { log: await this.github.jobLog(repo.githubRepo!, jobId, repo.readCredential) };
  }
  async confirm(id: string, revision: number, key: string, testsConfirmed: boolean, keepPinned: boolean) {
    if (!testsConfirmed || !key || key.length > 200) throw new BadRequestException('Confirm tests and supply an idempotency key');
    const draft = await this.get(id);

    const snapshot = TaskSnapshotSchema.parse(draft.snapshot);
    const digest = digestSnapshot(snapshot);
    const existing = await this.prisma.task.findUnique({ where: { confirmationKey: key }, include: { runs: true } });
    if (existing) {
      if (existing.snapshotDigest !== digest) throw new ConflictException('Idempotency key reused with different input');
      return { taskId: existing.id, runId: existing.runs[0].id };
    }
    if (draft.revision !== revision || draft.expiresAt < new Date()) throw new ConflictException('Draft expired or changed');
    const repo = await this.repositories.get(draft.projectId);
    if (snapshot.source) {
      const current = await this.github.inspect(snapshot.source.prUrl, repo.githubRepo!, repo.readCredential);
      if (current.headSha !== snapshot.executionSha && !keepPinned) throw new ConflictException('PR changed; refresh draft or explicitly keep the pinned SHA');
    }
    await this.git.ensureCommit(repo.repoPath, repo.githubRepo!, snapshot.executionSha, repo.readCredential);
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
      const prior = await tx.task.findUnique({ where: { confirmationKey: key }, include: { runs: true } });
      if (prior) {
        if (prior.snapshotDigest !== digest) throw new ConflictException('Idempotency conflict');
        return { taskId: prior.id, runId: prior.runs[0].id };
      }
      const task = await tx.task.create({ data: { projectId: repo.id, title: snapshot.title,
        description: snapshot.description, parentTaskId: snapshot.parentTaskId, source: 'MANUAL', sourceRef: snapshot.source?.prUrl,
        status: 'QUEUED', allowedPaths: snapshot.config.allowedPaths, snapshot, snapshotDigest: digest, confirmationKey: key } });
      const run = await tx.run.create({ data: { taskId: task.id, agentKind: snapshot.agentKind,
        status: 'DISPATCHED', baseCommit: snapshot.executionSha, maxAttempts: snapshot.budget.maxAttempts,
        budgetTokens: snapshot.budget.tokens, budgetSeconds: snapshot.budget.seconds, budgetTurns: snapshot.budget.turns,
        deadlineAt: new Date(Date.now() + 7 * 86400000) } });
      await tx.outboxMessage.create({ data: { topic: 'run-commands', key: run.id,
        payload: commandFromSnapshot(snapshot, repo.repoPath, run.id, 1) } });
      return { taskId: task.id, runId: run.id };
    });
  }
}
