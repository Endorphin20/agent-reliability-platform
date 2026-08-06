import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  Logger,
  Post,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { loadEnv } from '../../config/env';
import { RunLifecycleService } from '../run/run-lifecycle.service';
import { parseRunCommand, verifyWebhookSignature } from './webhook-utils';

/**
 * GitHub 入站 webhook：issue 评论 `/arp run <fixtureId>` 触发修复任务。
 * CI 场景闭环的入口端：issue -> 任务 -> Agent 修复 -> 审批 -> 出站 PR。
 */
@Controller('api/github')
export class GithubWebhookController {
  private readonly logger = new Logger(GithubWebhookController.name);

  constructor(private readonly lifecycle: RunLifecycleService) {}

  @Post('webhook')
  @HttpCode(202)
  async webhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-hub-signature-256') signature: string | undefined,
    @Headers('x-github-event') event: string | undefined,
  ) {
    const env = loadEnv();
    if (!env.GITHUB_WEBHOOK_SECRET) {
      throw new ServiceUnavailableException('GITHUB_WEBHOOK_SECRET 未配置，webhook 不可用');
    }
    if (!req.rawBody || !verifyWebhookSignature(env.GITHUB_WEBHOOK_SECRET, req.rawBody, signature)) {
      throw new UnauthorizedException('webhook 签名校验失败');
    }

    if (event === 'ping') return { ok: true };
    if (event !== 'issue_comment') return { ok: true, skipped: `事件 ${event} 不处理` };

    const payload = req.body as {
      action?: string;
      comment?: { body?: string };
      issue?: { html_url?: string };
    };
    if (payload.action !== 'created') return { ok: true, skipped: '非新建评论' };

    const command = parseRunCommand(payload.comment?.body ?? '');
    if (!command) return { ok: true, skipped: '无 /arp run 命令' };

    try {
      const task = await this.lifecycle.createTask({
        ...command,
        source: 'GITHUB_ISSUE',
        sourceRef: payload.issue?.html_url,
      });
      this.logger.log(`webhook 触发任务 ${task.taskId}（fixture=${command.fixtureId}）`);
      return { ok: true, taskId: task.taskId, runId: task.runId };
    } catch (error) {
      // fixture 不存在等业务错误：4xx 让 GitHub 侧可见失败原因
      throw new BadRequestException(error instanceof Error ? error.message : String(error));
    }
  }
}
