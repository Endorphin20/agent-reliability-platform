import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { z } from 'zod';
import { AGENT_KINDS } from '@arp/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { RunLifecycleService } from '../run/run-lifecycle.service';

const CreateTaskSchema = z.object({
  fixtureId: z.string().min(1),
  agentKind: z.enum(AGENT_KINDS),
  // 评测实验开关（T11）
  recoveryDisabled: z.boolean().optional(),
  feedbackMode: z.enum(['structured', 'raw']).optional(),
  // 预算覆盖（SWE-bench 等重型任务用，缺省走 Run 表默认值）
  budgetTokens: z.number().int().positive().optional(),
  budgetSeconds: z.number().int().positive().optional(),
  budgetTurns: z.number().int().positive().optional(),
});

const PositiveIntegerQuery = z.string().regex(/^\d+$/).transform(Number)
  .pipe(z.number().int().positive());
const ListTasksSchema = z.object({
  page: PositiveIntegerQuery.prefault('1'),
  pageSize: PositiveIntegerQuery.pipe(z.number().max(100)).prefault('20'),
}).refine(({ page, pageSize }) => Number.isSafeInteger((page - 1) * pageSize), {
  message: '分页偏移量过大',
  path: ['page'],
});

@Controller('api/tasks')
export class TaskController {
  constructor(
    private readonly lifecycle: RunLifecycleService,
    private readonly prisma: PrismaService,
  ) {}

  @Post()
  async create(@Body() body: unknown) {
    const parsed = CreateTaskSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues);
    }
    return this.lifecycle.createTask(parsed.data);
  }

  @Get()
  async list(@Query() query: unknown = {}) {
    const parsed = ListTasksSchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { page, pageSize } = parsed.data;

    return this.prisma.$transaction(async (tx) => {
      const total = await tx.task.count();
      const items = await tx.task.findMany({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          runs: { select: { id: true, agentKind: true, status: true, createdAt: true } },
          approval: { select: { id: true, status: true, prUrl: true } },
        },
      });
      return { items, total, page, pageSize };
    }, { isolationLevel: 'RepeatableRead' });
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    const task = await this.prisma.task.findUnique({
      where: { id },
      include: {
        runs: { select: { id: true, agentKind: true, status: true, createdAt: true } },
        approval: true,
      },
    });
    if (!task) throw new NotFoundException(`Task ${id} 不存在`);
    return task;
  }
}
