import {
  BadRequestException,
  Body,
  Controller,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import { z } from 'zod';
import { ApprovalService } from './approval.service';

const DecideSchema = z.object({
  decision: z.enum(['APPROVED', 'REJECTED']),
  reviewer: z.string().optional(),
});

@Controller('api/approvals')
export class ApprovalController {
  constructor(private readonly approvals: ApprovalService) {}

  @Post(':id/decide')
  async decide(@Param('id') id: string, @Body() body: unknown) {
    const parsed = DecideSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const result = await this.approvals.decide(id, parsed.data.decision, parsed.data.reviewer);
    if (!result) throw new NotFoundException(`Approval ${id} 不存在`);
    return result;
  }

  /** PR 创建失败后的手动重试（Task PR_FAILED -> APPROVED -> 重新建 PR） */
  @Post(':id/retry-pr')
  async retryPr(@Param('id') id: string) {
    const result = await this.approvals.retryPr(id);
    if (!result) throw new NotFoundException(`Approval ${id} 不存在`);
    return result;
  }
}
