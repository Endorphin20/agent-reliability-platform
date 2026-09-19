import { BadRequestException } from '@nestjs/common';
import { TaskController } from './task.controller';
import { PrismaService } from '../../prisma/prisma.service';
import { RunLifecycleService } from '../run/run-lifecycle.service';

jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('../run/run-lifecycle.service', () => ({ RunLifecycleService: class {} }));

describe('TaskController pagination', () => {
  const items = [{ id: 'task-1', runs: [{ id: 'run-1' }], approval: null }];
  const task = { count: jest.fn(), findMany: jest.fn() };
  const transaction = jest.fn();
  const controller = new TaskController(
    {} as RunLifecycleService,
    { task, $transaction: transaction } as unknown as PrismaService,
  );
  // Invoke through the HTTP handler's argument shape, including before pagination exists.
  const list = (query: Record<string, unknown> = {}) =>
    Reflect.apply(controller.list, controller, [query]) as Promise<{
      items: typeof items; total: number; page: number; pageSize: number;
    }>;

  beforeEach(() => {
    jest.clearAllMocks();
    task.count.mockResolvedValue(105);
    task.findMany.mockResolvedValue(items);
    transaction.mockImplementation((fn: (tx: { task: typeof task }) => unknown) => fn({ task }));
  });

  it('returns a default page and total in one repeatable-read transaction', async () => {
    expect(await list()).toEqual({ items, total: 105, page: 1, pageSize: 20 });
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'RepeatableRead',
    });
    expect(task.findMany).toHaveBeenCalledWith(expect.objectContaining({
      skip: 0, take: 20, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    }));
  });

  it('queries historical pages past the previous 100-task cutoff', async () => {
    expect(await list({ page: '6', pageSize: '20' })).toEqual({ items, total: 105, page: 6, pageSize: 20 });
    expect(task.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 100, take: 20 }));
  });

  it('accepts the maximum page size', async () => {
    expect((await list({ pageSize: '100' })).pageSize).toBe(100);
  });

  it.each([
    { page: '0' }, { page: '-1' }, { page: '1.5' }, { page: '' },
    { page: 'abc' }, { page: '1e2' }, { page: ['1', '2'] },
    { pageSize: '0' }, { pageSize: '101' }, { pageSize: '' },
    { pageSize: '2.5' }, { pageSize: ['20', '30'] },
    { page: '9007199254740992' }, { page: '9007199254740991', pageSize: '100' },
  ])('rejects invalid query %j before accessing the database', async (query) => {
    await expect(list(query)).rejects.toBeInstanceOf(BadRequestException);
    expect(transaction).not.toHaveBeenCalled();
    expect(task.findMany).not.toHaveBeenCalled();
  });

  it.each([{ total: 0, page: '1' }, { total: 105, page: '99' }])(
    'returns empty items with the actual total for %j', async ({ total, page }) => {
      task.count.mockResolvedValue(total);
      task.findMany.mockResolvedValue([]);
      expect(await list({ page })).toEqual({ items: [], total, page: Number(page), pageSize: 20 });
    },
  );

  it('returns a partially filled final page without dropping related fields', async () => {
    task.count.mockResolvedValue(101);
    expect(await list({ page: '6' })).toEqual({ items, total: 101, page: 6, pageSize: 20 });
  });
});
