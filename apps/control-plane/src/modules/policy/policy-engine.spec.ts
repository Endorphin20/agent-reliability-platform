import { FAILURE_CODES } from '@arp/shared';
import { decidePolicy } from './policy-engine';

describe('Policy Engine 决策表（全分支）', () => {
  it('全部失败码在未达/已达 maxAttempts 两种情形下都有确定决策', () => {
    for (const code of FAILURE_CODES) {
      const below = decidePolicy({ failureCode: code, attemptNo: 1, maxAttempts: 3 });
      const atMax = decidePolicy({ failureCode: code, attemptNo: 3, maxAttempts: 3 });
      expect(below.action).toBeDefined();
      expect(atMax.action).toBeDefined();
    }
  });

  it.each([
    ['WORKER_LOST', 'RESUME'],
    ['SANDBOX_CRASHED', 'RESUME'],
    ['MODEL_RATE_LIMIT', 'RESUME'],
    ['SANDBOX_START_FAILED', 'RESTART_ATTEMPT'],
    ['PATCH_APPLY_FAILED', 'RESTART_ATTEMPT'],
    ['AGENT_STUCK', 'RESTART_ATTEMPT'],
    ['BUDGET_TOKENS_EXCEEDED', 'ESCALATE_HUMAN'],
    ['VERIFY_SCOPE_VIOLATION', 'RESTART_ATTEMPT'],
    ['HUMAN_REJECTED', 'ABORT'],
  ] as const)('未达上限：%s -> %s', (code, expected) => {
    expect(decidePolicy({ failureCode: code, attemptNo: 1, maxAttempts: 3 }).action).toBe(expected);
  });

  it.each([
    ['WORKER_LOST', 'ESCALATE_HUMAN'],
    ['VERIFY_SCOPE_VIOLATION', 'ABORT'],
    ['VERIFY_TEST_TAMPERING', 'ABORT'],
    ['BUDGET_TIME_EXCEEDED', 'ESCALATE_HUMAN'],
  ] as const)('达到上限：%s -> %s', (code, expected) => {
    expect(decidePolicy({ failureCode: code, attemptNo: 3, maxAttempts: 3 }).action).toBe(expected);
  });

  it('模型限流退避按 30s * 2^n 递增', () => {
    expect(decidePolicy({ failureCode: 'MODEL_RATE_LIMIT', attemptNo: 1, maxAttempts: 3 }).backoffMs).toBe(30_000);
    expect(decidePolicy({ failureCode: 'MODEL_RATE_LIMIT', attemptNo: 2, maxAttempts: 3 }).backoffMs).toBe(60_000);
    expect(decidePolicy({ failureCode: 'WORKER_LOST', attemptNo: 1, maxAttempts: 3 }).backoffMs).toBe(0);
  });
});
