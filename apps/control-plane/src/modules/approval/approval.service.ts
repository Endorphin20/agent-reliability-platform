import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { taskStateMachine } from '../../state-machine/state-machine';
import { GithubService } from '../github/github.service';

/**
 * 审批流。注意（§4.4/IM-01）：审批拒绝只作用于 Task/Approval 层，
 * Run 保持 SUCCEEDED 终态不回退——补丁验证通过是事实，拒绝是治理决策。
 */
@Injectable()
export class ApprovalService {
  private readonly logger = new Logger(ApprovalService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly github: GithubService,
  ) {}

  async decide(approvalId: string, decision: 'APPROVED' | 'REJECTED', reviewer?: string) {
    const approval = await this.prisma.approval.findUnique({
      where: { id: approvalId },
      include: { task: true },
    });
    if (!approval) return null;
    if (approval.status !== 'PENDING') {
      throw new ConflictException(`Approval ${approvalId} 已是 ${approval.status}，不可重复裁决`);
    }

    if (decision === 'REJECTED') {
      taskStateMachine.assertTransition(approval.task.status as never, 'REJECTED' as never);
      await this.prisma.$transaction([
        this.prisma.approval.update({
          where: { id: approvalId },
          data: { status: 'REJECTED', reviewer: reviewer ?? 'anonymous', decidedAt: new Date() },
        }),
        this.prisma.task.update({ where: { id: approval.taskId }, data: { status: 'REJECTED' } }),
      ]);
      return { approvalId, status: 'REJECTED' as const };
    }

    taskStateMachine.assertTransition(approval.task.status as never, 'APPROVED' as never);
    await this.prisma.$transaction([
      this.prisma.approval.update({
        where: { id: approvalId },
        data: { status: 'APPROVED', reviewer: reviewer ?? 'anonymous', decidedAt: new Date() },
      }),
      this.prisma.task.update({ where: { id: approval.taskId }, data: { status: 'APPROVED' } }),
    ]);
    return this.createPr(approvalId);
  }

  async retryPr(approvalId: string) {
    const approval = await this.prisma.approval.findUnique({
      where: { id: approvalId },
      include: { task: true },
    });
    if (!approval) return null;
    if (approval.task.status !== 'PR_FAILED') {
      throw new ConflictException(`Task 状态是 ${approval.task.status}，只有 PR_FAILED 可重试`);
    }
    await this.prisma.task.update({ where: { id: approval.taskId }, data: { status: 'APPROVED' } });
    return this.createPr(approvalId);
  }

  private async createPr(approvalId: string) {
    const approval = await this.prisma.approval.findUniqueOrThrow({
      where: { id: approvalId },
      include: { task: true },
    });
    try {
      const pr = await this.github.createFixPr({
        taskId: approval.taskId,
        runId: approval.runId,
        title: approval.task.title,
      });
      await this.prisma.$transaction([
        this.prisma.approval.update({
          where: { id: approvalId },
          data: { prUrl: pr.url, prError: null },
        }),
        this.prisma.task.update({
          where: { id: approval.taskId },
          data: { status: 'PR_CREATED' },
        }),
      ]);
      return { approvalId, status: 'APPROVED' as const, prUrl: pr.url };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`PR 创建失败: ${message}`);
      await this.prisma.$transaction([
        this.prisma.approval.update({ where: { id: approvalId }, data: { prError: message } }),
        this.prisma.task.update({
          where: { id: approval.taskId },
          data: { status: 'PR_FAILED' },
        }),
      ]);
      return { approvalId, status: 'APPROVED' as const, prUrl: null, prError: message };
    }
  }
}
