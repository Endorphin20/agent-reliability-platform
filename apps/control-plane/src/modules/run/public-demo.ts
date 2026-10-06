import { BadRequestException, ConflictException } from '@nestjs/common';

export function assertDemoInput(input: {
  fixtureId: string; agentKind: string;
  budgetTokens?: number; budgetSeconds?: number; budgetTurns?: number;
}) {
  if (!['py-logic-001', 'ts-logic-001'].includes(input.fixtureId)
    || input.agentKind !== 'SELF_LANGGRAPH'
    || (input.budgetTokens ?? 0) > 10000
    || (input.budgetSeconds ?? 0) > 180
    || (input.budgetTurns ?? 0) > 10) {
    throw new BadRequestException('公开模拟演示仅支持 SELF_LANGGRAPH 的 py-logic-001 / ts-logic-001，预算上限 10000 tokens / 180 秒 / 10 轮');
  }
}

export function assertDemoCapacity(active: number, today: number) {
  if (active > 0) throw new ConflictException('演示任务执行中，请等待完成后再创建');
  if (today >= 100) throw new ConflictException('今日演示任务额度已用完（100 次）');
}
