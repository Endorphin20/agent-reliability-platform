import { Injectable, Logger } from '@nestjs/common';
import { loadEnv } from '../../config/env';

export interface CreatePrInput {
  taskId: string;
  runId: string;
  title: string;
}

/**
 * GitHub 出站集成。dev 环境（GITHUB_ENABLED=false）返回 mock PR URL，
 * 保证 e2e 脚本无外网可跑；demo 环境走真实 Octokit（T13 实现）。
 */
@Injectable()
export class GithubService {
  private readonly logger = new Logger(GithubService.name);

  async createFixPr(input: CreatePrInput): Promise<{ url: string }> {
    const env = loadEnv();
    if (!env.GITHUB_ENABLED) {
      this.logger.log(`GITHUB_ENABLED=false，返回 mock PR（task ${input.taskId}）`);
      return { url: `https://github.example.local/mock/pulls/${input.taskId}` };
    }
    // T13：真实实现（推 agent-fix/<taskId> 分支 + Octokit 建 PR + 失败路径）
    throw new Error('GitHub 真实 PR 创建将在 T13 实现');
  }
}
