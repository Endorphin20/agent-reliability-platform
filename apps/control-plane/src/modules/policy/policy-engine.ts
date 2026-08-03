import type { FailureCode, PolicyAction } from '@arp/shared';

/**
 * Policy Engine 恢复决策表（计划 §4.7）。纯函数实现，全分支单测覆盖。
 *
 * 每行含义：[未达 maxAttempts 时的动作, 达到 maxAttempts 时的动作]。
 * RESUME  = 从最近 checkpoint 恢复（发 RESUME_RUN）
 * RESTART = 丢弃进度重开一个 Attempt（发 START_RUN）
 */

export interface PolicyInput {
  failureCode: FailureCode;
  attemptNo: number;
  maxAttempts: number;
}

export interface PolicyDecisionResult {
  action: PolicyAction;
  reason: string;
  /** RESUME 时的退避毫秒数（30s * 2^n，仅模型类失败使用） */
  backoffMs: number;
}

const TABLE: Record<FailureCode, [PolicyAction, PolicyAction]> = {
  MODEL_RATE_LIMIT: ['RESUME', 'ESCALATE_HUMAN'],
  MODEL_API_ERROR: ['RESUME', 'ESCALATE_HUMAN'],
  MODEL_BAD_OUTPUT: ['RESUME', 'ESCALATE_HUMAN'],
  TOOL_EXEC_ERROR: ['RESUME', 'ESCALATE_HUMAN'],
  SANDBOX_CRASHED: ['RESUME', 'ESCALATE_HUMAN'],
  SANDBOX_START_FAILED: ['RESTART_ATTEMPT', 'ESCALATE_HUMAN'],
  WORKER_LOST: ['RESUME', 'ESCALATE_HUMAN'],
  PATCH_APPLY_FAILED: ['RESTART_ATTEMPT', 'ESCALATE_HUMAN'],
  AGENT_STUCK: ['RESTART_ATTEMPT', 'ESCALATE_HUMAN'],
  BUDGET_TOKENS_EXCEEDED: ['ESCALATE_HUMAN', 'ESCALATE_HUMAN'],
  BUDGET_TIME_EXCEEDED: ['ESCALATE_HUMAN', 'ESCALATE_HUMAN'],
  BUDGET_TURNS_EXCEEDED: ['ESCALATE_HUMAN', 'ESCALATE_HUMAN'],
  VERIFY_STATIC_FAILED: ['RESUME', 'ESCALATE_HUMAN'],
  VERIFY_TARGET_TESTS_FAILED: ['RESUME', 'ESCALATE_HUMAN'],
  VERIFY_REGRESSION_FAILED: ['RESUME', 'ESCALATE_HUMAN'],
  VERIFY_SCOPE_VIOLATION: ['RESTART_ATTEMPT', 'ABORT'],
  VERIFY_TEST_TAMPERING: ['RESTART_ATTEMPT', 'ABORT'],
  VERIFY_PATCH_MALFORMED: ['RESTART_ATTEMPT', 'ABORT'],
  HUMAN_REJECTED: ['ABORT', 'ABORT'],
  CANCELLED_BY_USER: ['ABORT', 'ABORT'],
};

const MODEL_FAILURES: ReadonlySet<FailureCode> = new Set([
  'MODEL_RATE_LIMIT',
  'MODEL_API_ERROR',
]);

export function decidePolicy(input: PolicyInput): PolicyDecisionResult {
  const [belowMax, atMax] = TABLE[input.failureCode];
  const reachedMax = input.attemptNo >= input.maxAttempts;
  const action = reachedMax ? atMax : belowMax;
  const backoffMs =
    action === 'RESUME' && MODEL_FAILURES.has(input.failureCode)
      ? 30_000 * 2 ** (input.attemptNo - 1)
      : 0;
  return {
    action,
    backoffMs,
    reason: `${input.failureCode} @ attempt ${input.attemptNo}/${input.maxAttempts} -> ${action}`,
  };
}
