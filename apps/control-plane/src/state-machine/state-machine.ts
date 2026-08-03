import type { AttemptStatus, RunStatus, TaskStatus } from '@arp/shared';

/**
 * 三层状态机迁移表（计划 §4.4）的静态映射实现。
 * 非法迁移一律抛 InvalidTransitionError，全部合法/非法组合由单测枚举覆盖。
 *
 * 注意：Run 的 SUCCEEDED 是终态。审批拒绝只作用于 Task/Approval 层，
 * Run 不会从 SUCCEEDED 回退（补丁验证通过是事实，拒绝是治理决策）。
 */

export class InvalidTransitionError extends Error {
  constructor(entity: string, from: string, to: string) {
    super(`非法状态迁移 ${entity}: ${from} -> ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

const TASK_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  CREATED: ['QUEUED', 'CANCELLED'],
  QUEUED: ['RUNNING', 'CANCELLED'],
  RUNNING: ['AWAITING_APPROVAL', 'FAILED', 'CANCELLED'],
  AWAITING_APPROVAL: ['APPROVED', 'REJECTED', 'CANCELLED'],
  APPROVED: ['PR_CREATED', 'PR_FAILED', 'CANCELLED'],
  PR_FAILED: ['APPROVED', 'CANCELLED'], // 前端手动重试回 APPROVED
  PR_CREATED: ['RESOLVED'],
  RESOLVED: [],
  REJECTED: [],
  FAILED: [],
  CANCELLED: [],
};

const RUN_TRANSITIONS: Record<RunStatus, readonly RunStatus[]> = {
  PENDING: ['DISPATCHED', 'CANCELLED'],
  DISPATCHED: ['RUNNING', 'INTERRUPTED', 'CANCELLED'],
  RUNNING: ['VERIFYING', 'INTERRUPTED', 'CANCELLED'],
  VERIFYING: ['SUCCEEDED', 'RUNNING', 'INTERRUPTED', 'CANCELLED'],
  INTERRUPTED: ['RECOVERING', 'FAILED', 'CANCELLED'],
  RECOVERING: ['DISPATCHED', 'FAILED', 'CANCELLED'],
  SUCCEEDED: [],
  FAILED: [],
  CANCELLED: [],
};

const ATTEMPT_TRANSITIONS: Record<AttemptStatus, readonly AttemptStatus[]> = {
  CLAIMED: ['RUNNING', 'FAILED', 'LEASE_EXPIRED'],
  RUNNING: ['SUCCEEDED', 'FAILED', 'CRASHED', 'TIMED_OUT', 'LEASE_EXPIRED'],
  SUCCEEDED: [],
  FAILED: [],
  CRASHED: [],
  TIMED_OUT: [],
  LEASE_EXPIRED: [],
};

function assertTransition<S extends string>(
  entity: string,
  table: Record<S, readonly S[]>,
  from: S,
  to: S,
): S {
  if (!table[from]?.includes(to)) {
    throw new InvalidTransitionError(entity, from, to);
  }
  return to;
}

export const taskStateMachine = {
  transitions: TASK_TRANSITIONS,
  canTransition: (from: TaskStatus, to: TaskStatus) => TASK_TRANSITIONS[from].includes(to),
  assertTransition: (from: TaskStatus, to: TaskStatus) =>
    assertTransition('task', TASK_TRANSITIONS, from, to),
  isTerminal: (status: TaskStatus) => TASK_TRANSITIONS[status].length === 0,
};

export const runStateMachine = {
  transitions: RUN_TRANSITIONS,
  canTransition: (from: RunStatus, to: RunStatus) => RUN_TRANSITIONS[from].includes(to),
  assertTransition: (from: RunStatus, to: RunStatus) =>
    assertTransition('run', RUN_TRANSITIONS, from, to),
  isTerminal: (status: RunStatus) => RUN_TRANSITIONS[status].length === 0,
};

export const attemptStateMachine = {
  transitions: ATTEMPT_TRANSITIONS,
  canTransition: (from: AttemptStatus, to: AttemptStatus) =>
    ATTEMPT_TRANSITIONS[from].includes(to),
  assertTransition: (from: AttemptStatus, to: AttemptStatus) =>
    assertTransition('attempt', ATTEMPT_TRANSITIONS, from, to),
  isTerminal: (status: AttemptStatus) => ATTEMPT_TRANSITIONS[status].length === 0,
};
