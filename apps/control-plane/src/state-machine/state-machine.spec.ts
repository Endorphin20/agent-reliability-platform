import {
  ATTEMPT_STATUSES,
  RUN_STATUSES,
  TASK_STATUSES,
  type AttemptStatus,
  type RunStatus,
  type TaskStatus,
} from '@arp/shared';
import {
  attemptStateMachine,
  InvalidTransitionError,
  runStateMachine,
  taskStateMachine,
} from './state-machine';

describe('三层状态机（枚举全覆盖）', () => {
  describe('Run 状态机', () => {
    const legal: Array<[RunStatus, RunStatus]> = [
      ['PENDING', 'DISPATCHED'],
      ['DISPATCHED', 'RUNNING'],
      ['RUNNING', 'VERIFYING'],
      ['VERIFYING', 'SUCCEEDED'],
      ['VERIFYING', 'RUNNING'], // V3/V4 失败带反馈继续修
      ['RUNNING', 'INTERRUPTED'],
      ['VERIFYING', 'INTERRUPTED'],
      ['DISPATCHED', 'INTERRUPTED'],
      ['INTERRUPTED', 'RECOVERING'],
      ['RECOVERING', 'DISPATCHED'],
      ['INTERRUPTED', 'FAILED'],
      ['RECOVERING', 'FAILED'],
      ['PENDING', 'CANCELLED'],
      ['RUNNING', 'CANCELLED'],
    ];

    it.each(legal)('允许 %s -> %s', (from, to) => {
      expect(runStateMachine.assertTransition(from, to)).toBe(to);
    });

    it('穷举校验：迁移表之外的组合全部抛错', () => {
      for (const from of RUN_STATUSES) {
        for (const to of RUN_STATUSES) {
          const allowed = runStateMachine.transitions[from].includes(to);
          if (allowed) {
            expect(runStateMachine.assertTransition(from, to)).toBe(to);
          } else {
            expect(() => runStateMachine.assertTransition(from, to)).toThrow(
              InvalidTransitionError,
            );
          }
        }
      }
    });

    it('SUCCEEDED 是终态（审批拒绝不回退 Run）', () => {
      expect(runStateMachine.isTerminal('SUCCEEDED')).toBe(true);
      expect(() => runStateMachine.assertTransition('SUCCEEDED', 'FAILED')).toThrow(
        InvalidTransitionError,
      );
    });

    it('终态集合 = SUCCEEDED/FAILED/CANCELLED', () => {
      const terminals = RUN_STATUSES.filter((s) => runStateMachine.isTerminal(s));
      expect(terminals.sort()).toEqual(['CANCELLED', 'FAILED', 'SUCCEEDED']);
    });
  });

  describe('Task 状态机', () => {
    const legal: Array<[TaskStatus, TaskStatus]> = [
      ['CREATED', 'QUEUED'],
      ['QUEUED', 'RUNNING'],
      ['RUNNING', 'AWAITING_APPROVAL'],
      ['AWAITING_APPROVAL', 'APPROVED'],
      ['AWAITING_APPROVAL', 'REJECTED'],
      ['APPROVED', 'PR_CREATED'],
      ['APPROVED', 'PR_FAILED'],
      ['PR_FAILED', 'APPROVED'], // 手动重试
      ['PR_CREATED', 'RESOLVED'],
      ['RUNNING', 'FAILED'],
      ['CREATED', 'CANCELLED'],
    ];

    it.each(legal)('允许 %s -> %s', (from, to) => {
      expect(taskStateMachine.assertTransition(from, to)).toBe(to);
    });

    it('穷举校验：迁移表之外的组合全部抛错', () => {
      for (const from of TASK_STATUSES) {
        for (const to of TASK_STATUSES) {
          const allowed = taskStateMachine.transitions[from].includes(to);
          if (allowed) {
            expect(taskStateMachine.assertTransition(from, to)).toBe(to);
          } else {
            expect(() => taskStateMachine.assertTransition(from, to)).toThrow(
              InvalidTransitionError,
            );
          }
        }
      }
    });

    it('终态集合 = RESOLVED/REJECTED/FAILED/CANCELLED', () => {
      const terminals = TASK_STATUSES.filter((s) => taskStateMachine.isTerminal(s));
      expect(terminals.sort()).toEqual(['CANCELLED', 'FAILED', 'REJECTED', 'RESOLVED']);
    });
  });

  describe('Attempt 状态机', () => {
    const legal: Array<[AttemptStatus, AttemptStatus]> = [
      ['CLAIMED', 'RUNNING'],
      ['CLAIMED', 'LEASE_EXPIRED'],
      ['RUNNING', 'SUCCEEDED'],
      ['RUNNING', 'FAILED'],
      ['RUNNING', 'CRASHED'],
      ['RUNNING', 'TIMED_OUT'],
      ['RUNNING', 'LEASE_EXPIRED'],
    ];

    it.each(legal)('允许 %s -> %s', (from, to) => {
      expect(attemptStateMachine.assertTransition(from, to)).toBe(to);
    });

    it('穷举校验：迁移表之外的组合全部抛错', () => {
      for (const from of ATTEMPT_STATUSES) {
        for (const to of ATTEMPT_STATUSES) {
          const allowed = attemptStateMachine.transitions[from].includes(to);
          if (allowed) {
            expect(attemptStateMachine.assertTransition(from, to)).toBe(to);
          } else {
            expect(() => attemptStateMachine.assertTransition(from, to)).toThrow(
              InvalidTransitionError,
            );
          }
        }
      }
    });
  });
});
