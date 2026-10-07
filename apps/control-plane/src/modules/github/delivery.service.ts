import { ConflictException, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { TaskSnapshotSchema } from '@arp/shared';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { PrismaService } from '../../prisma/prisma.service';
import { CredentialStore } from '../credentials/credential-store';
import { PrImportService } from './pr-import.service';

const exec = promisify(execFile);
export function assertDeliveryTarget(expected: string, current: string) {
  if (expected !== current) throw new ConflictException('Target branch changed; create and verify a new task');
}
export function deliveryBranch(taskId: string, digest: string) { return `arp-fix/${taskId}-${digest.slice(0, 12)}`; }

@Injectable()
export class DeliveryService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private running = false;
  constructor(private readonly prisma: PrismaService, private readonly credentials: CredentialStore,
    private readonly github: PrImportService) {}
  onModuleInit() {
    if (process.env.NODE_ENV !== 'test') this.timer = setInterval(() => void this.tick().catch(() => undefined), 2000);
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }
  async reject(approvalId: string, reviewer?: string) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT id FROM "Approval" WHERE id = ${approvalId} FOR UPDATE`;
      const approval = await tx.approval.findUniqueOrThrow({ where: { id: approvalId } });
      if (approval.status === 'REJECTED') return { approvalId, status: 'REJECTED' };
      if (approval.status !== 'PENDING') throw new ConflictException('Approval is no longer pending');
      await tx.approval.update({ where: { id: approvalId }, data: { status: 'REJECTED', reviewer: reviewer || 'local-user', decidedAt: new Date() } });
      await tx.task.update({ where: { id: approval.taskId }, data: { status: 'REJECTED' } });
      return { approvalId, status: 'REJECTED' };
    });
  }
  async approve(approvalId: string, reviewer?: string) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT id FROM "Approval" WHERE id = ${approvalId} FOR UPDATE`;
      const a = await tx.approval.findUniqueOrThrow({ where: { id: approvalId }, include: { task: true, delivery: true } });
      if (a.status === 'APPROVED') return { approvalId, status: a.status, delivery: a.delivery };
      if (a.status !== 'PENDING') throw new ConflictException('Approval is no longer pending');
      const snapshot = TaskSnapshotSchema.parse(a.task.snapshot);
      const patch = await tx.artifact.findFirst({ where: { runId: a.runId, kind: 'PATCH' }, orderBy: { createdAt: 'desc' } });
      if (!patch || createHash('sha256').update(patch.content).digest('hex') !== a.patchDigest) throw new ConflictException('Approved patch identity changed');
      await tx.approval.update({ where: { id: approvalId }, data: { status: 'APPROVED', reviewer: reviewer || 'local-user', decidedAt: new Date() } });
      await tx.task.update({ where: { id: a.taskId }, data: { status: snapshot.delivery.kind === 'patch' ? 'RESOLVED' : 'APPROVED' } });
      if (snapshot.delivery.kind === 'patch') return { approvalId, status: 'APPROVED', delivery: 'PATCH_READY' };
      const job = await tx.deliveryJob.create({ data: { approvalId, patchDigest: a.patchDigest!, branch: deliveryBranch(a.taskId, a.patchDigest!) } });
      // The durable DB job is the delivery queue; polling claims it transactionally.
      return { approvalId, status: 'APPROVED', delivery: job };
    });
  }
  async retry(approvalId: string) {
    const job = await this.prisma.deliveryJob.findUniqueOrThrow({ where: { approvalId } });
    if (job.status !== 'FAILED' || job.attempts >= 5) throw new ConflictException('Delivery is not retryable or retry limit reached');
    await this.prisma.$transaction(async (tx) => {
      const changed = await tx.deliveryJob.updateMany({ where: { id: job.id, status: 'FAILED', attempts: { lt: 5 } }, data: { status: 'QUEUED', error: null } });
      if (!changed.count) throw new ConflictException('Delivery is already queued');
      const approval = await tx.approval.update({ where: { id: approvalId }, data: { prError: null } });
      await tx.task.update({ where: { id: approval.taskId }, data: { status: 'APPROVED', attentionReason: null } });
    });
    return { approvalId, status: 'APPROVED', delivery: 'QUEUED' };
  }
  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const exhausted = await this.prisma.deliveryJob.findMany({ where: { status: 'RUNNING', attempts: { gte: 5 }, leaseExpiresAt: { lt: new Date() } } });
      for (const job of exhausted) await this.prisma.$transaction(async (tx) => {
        const changed = await tx.deliveryJob.updateMany({ where: { id: job.id, status: 'RUNNING', leaseExpiresAt: { lt: new Date() } }, data: { status: 'FAILED', error: 'Delivery retry budget exhausted; patch retained' } });
        if (!changed.count) return;
        const approval = await tx.approval.update({ where: { id: job.approvalId }, data: { prError: 'Delivery retry budget exhausted; patch retained' } });
        await tx.task.update({ where: { id: approval.taskId }, data: { status: 'PR_FAILED' } });
      });
      const candidate = await this.prisma.deliveryJob.findFirst({ where: { attempts: { lt: 5 }, OR: [
        { status: 'QUEUED' }, { status: 'RUNNING', leaseExpiresAt: { lt: new Date() } },
      ] }, orderBy: { createdAt: 'asc' } });
      if (!candidate) return;
      const token = randomUUID();
      const claimed = await this.prisma.deliveryJob.updateMany({ where: { id: candidate.id, status: candidate.status,
        ...(candidate.status === 'RUNNING' ? { leaseExpiresAt: { lt: new Date() } } : {}) },
        data: { status: 'RUNNING', leaseToken: token, leaseExpiresAt: new Date(Date.now() + 600000), attempts: { increment: 1 } } });
      if (!claimed.count) return;
      try {
        const renewal = setInterval(() => void this.prisma.deliveryJob.updateMany({
          where: { id: candidate.id, leaseToken: token, status: 'RUNNING' },
          data: { leaseExpiresAt: new Date(Date.now() + 600000) },
        }).catch(() => undefined), 30000);
        let url: string;
        try { url = await this.deliver(candidate.id, token); } finally { clearInterval(renewal); }
        await this.prisma.$transaction(async (tx) => {
          const changed = await tx.deliveryJob.updateMany({ where: { id: candidate.id, leaseToken: token, status: 'RUNNING' }, data: { status: 'SUCCEEDED', prUrl: url, error: null } });
          if (!changed.count) return;
          const a = await tx.approval.update({ where: { id: candidate.approvalId }, data: { prUrl: url, prError: null } });
          await tx.task.update({ where: { id: a.taskId }, data: { status: 'PR_CREATED' } });
        });
      } catch (error) {
        const message = error instanceof ConflictException ? error.message : 'Delivery failed; check GitHub permissions, branch state and connectivity. Patch retained.';
        await this.prisma.$transaction(async (tx) => {
          const changed = await tx.deliveryJob.updateMany({ where: { id: candidate.id, leaseToken: token, status: 'RUNNING' }, data: { status: error instanceof ConflictException ? 'NEEDS_ATTENTION' : 'FAILED', error: message } });
          if (!changed.count) return;
          const a = await tx.approval.update({ where: { id: candidate.approvalId }, data: { prError: message } });
          await tx.task.update({ where: { id: a.taskId }, data: { status: 'PR_FAILED', attentionReason: message } });
        });
      }
    } finally { this.running = false; }
  }
  private async deliver(id: string, leaseToken: string) {
    const job = await this.prisma.deliveryJob.findUniqueOrThrow({ where: { id }, include: { approval: { include: { task: { include: { project: true } }, run: true } } } });
    const assertLease = async () => {
      const current = await this.prisma.deliveryJob.findUniqueOrThrow({ where: { id } });
      if (current.leaseToken !== leaseToken || current.status !== 'RUNNING' || !current.leaseExpiresAt || current.leaseExpiresAt <= new Date()) throw new ConflictException('Delivery lease expired');
    };
    const { task, run } = job.approval; const repo = task.project;
    const snapshot = TaskSnapshotSchema.parse(task.snapshot);
    if (!repo.writeCredential || !repo.githubRepo) throw new Error('Write credentials required');
    const api = (path: string, method = 'GET', body?: unknown) => this.github.request(`/repos/${repo.githubRepo}${path}`, repo.writeCredential, method, body);
    const expected = snapshot.delivery.expectedTargetSha;
    const target = async () => (await api(`/git/ref/heads/${encodeURIComponent(snapshot.delivery.targetBranch)}`)).object.sha as string;
    const marker = `arp-delivery:${job.id}:${job.patchDigest}`;
    const owner = repo.githubRepo.split('/')[0];
    const existing = await api(`/pulls?head=${encodeURIComponent(`${owner}:${job.branch}`)}&state=all&per_page=100`);
    const found = existing.find((pr: any) => pr.body?.includes(marker));
    if (found) return found.html_url as string;
    if (existing.length) throw new ConflictException('Delivery branch already belongs to another PR');
    assertDeliveryTarget(expected, await target());
    if (snapshot.source) await this.github.inspect(snapshot.source.prUrl, repo.githubRepo!, repo.readCredential);
    const artifact = await this.prisma.artifact.findFirst({ where: { runId: run.id, kind: 'PATCH' }, orderBy: { createdAt: 'desc' } });
    if (!artifact || createHash('sha256').update(artifact.content).digest('hex') !== job.patchDigest) throw new ConflictException('Patch changed after approval');
    const temporary = await mkdtemp(join(tmpdir(), 'arp-delivery-'));
    try {
      const work = join(temporary, 'repo');
      const secret = this.credentials.read(repo.writeCredential);
      const askpass = join(temporary, 'askpass.sh');
      await writeFile(askpass, '#!/bin/sh\ncase "$1" in *Username*) printf "%s" "x-access-token" ;; *) printf "%s" "$ARP_GIT_TOKEN" ;; esac\n', { mode: 0o700 });
      const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: askpass, ARP_GIT_TOKEN: secret,
        GIT_AUTHOR_NAME: 'arp-bot', GIT_AUTHOR_EMAIL: 'arp@localhost', GIT_COMMITTER_NAME: 'arp-bot', GIT_COMMITTER_EMAIL: 'arp@localhost',
        GIT_AUTHOR_DATE: run.createdAt.toISOString(), GIT_COMMITTER_DATE: run.createdAt.toISOString() };
      const git = async (...args: string[]) => (await exec('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'credential.helper=', '-C', work, ...args], { env, timeout: 120000, maxBuffer: 8000000 })).stdout.trim();
      await exec('git', ['clone', '--no-hardlinks', '--local', repo.repoPath, work], { timeout: 120000 });
      await git('checkout', '--detach', snapshot.executionSha);
      const patchPath = join(temporary, 'approved.patch'); await writeFile(patchPath, artifact.content);
      await git('apply', '--index', patchPath);
      await git('-c', 'commit.gpgsign=false', 'commit', '-m', `fix: ${snapshot.title}\n\n${marker}`);
      const commit = await git('rev-parse', 'HEAD');
      if (job.commitSha && job.commitSha !== commit) throw new ConflictException('Delivery commit changed');
      await this.prisma.deliveryJob.update({ where: { id }, data: { commitSha: commit } });
      const remote = `https://github.com/${repo.githubRepo}.git`;
      const existingRef = await git('ls-remote', remote, `refs/heads/${job.branch}`);
      if (existingRef && existingRef.split(/\s/)[0] !== commit) throw new ConflictException('Repair branch changed externally');
      assertDeliveryTarget(expected, await target());
      await assertLease();
      if (!existingRef) await git('push', `--force-with-lease=refs/heads/${job.branch}:`, remote, `${commit}:refs/heads/${job.branch}`);
      assertDeliveryTarget(expected, await target());
      await assertLease();
      const pr = await api('/pulls', 'POST', { title: `fix: ${snapshot.title}`, head: job.branch,
        base: snapshot.delivery.targetBranch, body: `Verified and approved local repair.\n\n${marker}\n\nSource commit: ${snapshot.executionSha}` });
      return pr.html_url as string;
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }
}
