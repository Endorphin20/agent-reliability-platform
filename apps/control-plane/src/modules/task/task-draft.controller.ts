import { BadRequestException, Body, Controller, Get, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import { TaskDraftService } from './task-draft.service';

@Controller('api/drafts')
export class TaskDraftController {
  constructor(private readonly drafts: TaskDraftService) {}
  @Post() create(@Body() body: unknown) { return this.drafts.create(body); }
  @Get(':id') get(@Param('id') id: string) { return this.drafts.get(id); }
  @Post('import-pr') importPr(@Body() body: unknown) {
    const p = z.object({ repositoryId: z.string(), url: z.string() }).strict().safeParse(body);
    if (!p.success) throw new BadRequestException(p.error.issues);
    return this.drafts.importPr(p.data.repositoryId, p.data.url);
  }
  @Post(':id/confirm') confirm(@Param('id') id: string, @Body() body: unknown) {
    const p = z.object({ revision: z.number().int().positive(), idempotencyKey: z.string().min(1),
      testsConfirmed: z.literal(true), keepPinned: z.boolean().default(false) }).strict().safeParse(body);
    if (!p.success) throw new BadRequestException(p.error.issues);
    return this.drafts.confirm(id, p.data.revision, p.data.idempotencyKey, p.data.testsConfirmed, p.data.keepPinned);
  }
  @Post('workflow-jobs') jobs(@Body() raw: unknown) {
    const p = z.object({ repositoryId: z.string(), runId: z.number().int().positive(), attempt: z.number().int().positive() }).parse(raw);
    return this.drafts.workflowJobs(p.repositoryId, p.runId, p.attempt);
  }
  @Post('job-log') log(@Body() raw: unknown) {
    const p = z.object({ repositoryId: z.string(), jobId: z.number().int().positive() }).parse(raw);
    return this.drafts.jobLog(p.repositoryId, p.jobId);
  }
}
