import { Injectable, Logger } from '@nestjs/common';
import { loadEnv } from '../../config/env';
import { PrismaService } from '../../prisma/prisma.service';
import { parseIssueRef } from './webhook-utils';

export interface CreatePrInput {
  taskId: string;
  runId: string;
  title: string;
}

/**
 * GitHub 出站集成。dev 环境（GITHUB_ENABLED=false）返回 mock PR URL，
 * 保留评测 mock 兼容。真实写入统一由 DeliveryService 执行。
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

    throw new Error('Legacy fixture delivery is disabled. Create a repository snapshot task for verified, approved GitHub delivery.');
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

  /**
   * 状态回写：往来源 issue 评论修复结果。尽力而为——回写失败只记日志，
   * 绝不影响主流程（PR 已建成是事实，通知失败不应把任务打回）。
   */
  async commentOnIssue(sourceRef: string | null | undefined, body: string): Promise<void> {
    const env = loadEnv();
    if (!env.GITHUB_ENABLED) return;
    const ref = parseIssueRef(sourceRef);
    if (!ref) return;
    try {
      const result = await this.rest(
        'POST',
        `/repos/${ref.repo}/issues/${ref.number}/comments`,
        { body },
      );
      if (result.status === 201) {
        this.logger.log(`已回写 ${ref.repo}#${ref.number}`);
      } else {
        this.logger.warn(`issue 回写失败 (HTTP ${result.status})`);
      }
    } catch (error) {
      this.logger.warn(`issue 回写失败: ${this.sanitize(error)}`);
    }
  }

  /** git 报错可能带上含 token 的远端 URL，统一脱敏后再冒泡。 */
  private sanitize(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return message.replace(/x-access-token:[^@]+@/g, 'x-access-token:***@');
  }
}
