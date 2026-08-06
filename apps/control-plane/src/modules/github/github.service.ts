import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Injectable, Logger } from '@nestjs/common';
import { loadEnv } from '../../config/env';
import { PrismaService } from '../../prisma/prisma.service';

const execFileAsync = promisify(execFile);

export interface CreatePrInput {
  taskId: string;
  runId: string;
  title: string;
}

/**
 * GitHub 出站集成。dev 环境（GITHUB_ENABLED=false）返回 mock PR URL，
 * 保证 e2e 脚本无外网可跑；开启后走真实流程：
 *   本地检出 fixture 仓库 -> agent-fix/<taskId> 分支应用补丁 -> push -> REST 建 PR。
 * 幂等：分支 force push，PR 已存在时（422）返回既有 PR。
 */
@Injectable()
export class GithubService {
  private readonly logger = new Logger(GithubService.name);

  constructor(private readonly prisma: PrismaService) {}

  async createFixPr(input: CreatePrInput): Promise<{ url: string }> {
    const env = loadEnv();
    if (!env.GITHUB_ENABLED) {
      this.logger.log(`GITHUB_ENABLED=false，返回 mock PR（task ${input.taskId}）`);
      return { url: `https://github.example.local/mock/pulls/${input.taskId}` };
    }

    const [run, artifact, task] = await Promise.all([
      this.prisma.run.findUniqueOrThrow({ where: { id: input.runId } }),
      this.prisma.artifact.findFirst({
        where: { runId: input.runId, kind: 'PATCH' },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.task.findUniqueOrThrow({ where: { id: input.taskId } }),
    ]);
    if (!artifact?.content.trim()) {
      throw new Error(`run ${input.runId} 没有 PATCH 工件，无法建 PR`);
    }

    const branch = `agent-fix/${input.taskId}`;
    await this.pushFixBranch(branch, run.baseCommit, artifact.content, input);
    return this.openPr(branch, input, task.description);
  }

  /** 从 fixture 仓库本地副本检出 baseCommit、应用补丁、推送分支。 */
  private async pushFixBranch(
    branch: string,
    baseCommit: string,
    patch: string,
    input: CreatePrInput,
  ): Promise<void> {
    const env = loadEnv();
    const source = env.FIXTURE_REPO_PATH.replace(/^~/, homedir());
    const workdir = await mkdtemp(join(tmpdir(), 'arp-pr-'));
    // token 放进远端 URL 而非磁盘配置；错误信息统一脱敏（见 sanitize）
    const remote = `https://x-access-token:${env.GITHUB_TOKEN}@github.com/${env.GITHUB_REPO}.git`;
    try {
      const git = async (...args: string[]) => {
        try {
          await execFileAsync('git', ['-C', join(workdir, 'repo'), ...args], {
            timeout: 120_000,
          });
        } catch (error) {
          throw new Error(this.sanitize(error));
        }
      };
      await execFileAsync('git', ['clone', '--local', source, join(workdir, 'repo')], {
        timeout: 120_000,
      });
      await git('checkout', '-B', branch, baseCommit);
      const patchFile = join(workdir, 'fix.patch');
      await writeFile(patchFile, patch);
      await git('apply', patchFile);
      await git(
        '-c', 'user.name=arp-bot',
        '-c', 'user.email=arp-bot@users.noreply.github.com',
        'commit', '-am', `fix: ${input.title}\n\nrun: ${input.runId}`,
      );
      // 重试/重复审批场景：分支内容以最新补丁为准
      await git('push', '--force', remote, `HEAD:refs/heads/${branch}`);
      this.logger.log(`已推送 ${branch} -> ${env.GITHUB_REPO}`);
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  }

  private async openPr(
    branch: string,
    input: CreatePrInput,
    description: string,
  ): Promise<{ url: string }> {
    const env = loadEnv();
    const body = [
      `自动修复补丁（Agent Reliability Platform）`,
      '',
      `- task: \`${input.taskId}\``,
      `- run: \`${input.runId}\`（V1–V6 Verifier 全绿 + 人工审批通过）`,
      '',
      '## 任务描述',
      description,
    ].join('\n');

    const created = await this.rest('POST', `/repos/${env.GITHUB_REPO}/pulls`, {
      title: `fix: ${input.title}`,
      head: branch,
      base: env.GITHUB_BASE_BRANCH,
      body,
    });
    if (created.status === 201) {
      return { url: (created.data as { html_url: string }).html_url };
    }
    // 422 = PR 已存在（重试路径），查回既有 PR 保持幂等
    if (created.status === 422) {
      const owner = env.GITHUB_REPO.split('/')[0];
      const existing = await this.rest(
        'GET',
        `/repos/${env.GITHUB_REPO}/pulls?head=${owner}:${branch}&state=open`,
      );
      const list = existing.data as Array<{ html_url: string }>;
      if (existing.status === 200 && list.length > 0) {
        this.logger.log(`PR 已存在，复用 ${list[0].html_url}`);
        return { url: list[0].html_url };
      }
    }
    throw new Error(`GitHub PR 创建失败 (HTTP ${created.status}): ${JSON.stringify(created.data).slice(0, 500)}`);
  }

  private async rest(
    method: string,
    path: string,
    payload?: unknown,
  ): Promise<{ status: number; data: unknown }> {
    const env = loadEnv();
    const response = await fetch(`https://api.github.com${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(payload ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
    });
    return { status: response.status, data: await response.json().catch(() => null) };
  }

  /** git 报错可能带上含 token 的远端 URL，统一脱敏后再冒泡。 */
  private sanitize(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return message.replace(/x-access-token:[^@]+@/g, 'x-access-token:***@');
  }
}
