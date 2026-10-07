import { describe, expect, it } from 'vitest';
import { TaskSnapshotSchema, RepositoryConfigSchema } from '../src/task-snapshot';

const config = {
  runtime: 'python-pytest', image: 'arp-sandbox:latest',
  preparation: 'image', dependencyFiles: ['requirements.lock'],
  workdir: '.', allowedPaths: ['src/**'], protectedPaths: ['tests/**'],
  staticCheck: [], failToPass: ['python -m pytest tests/test_bug.py'], passToPass: [],
  acceptanceCriteria: ['The bug is fixed'],
};
const snapshot = {
  schemaVersion: 2, mode: 'REAL', repositoryId: 'repo-1', configVersion: 1,
  executionSha: 'a'.repeat(40), agentKind: 'SELF_LANGGRAPH', config,
  description: 'Fix boundary condition', title: 'Fix bug',
  baseline: { command: config.failToPass[0], expected: ['tests/test_bug.py::test_bug'] },
  budget: { tokens: 10000, seconds: 900, turns: 20, maxAttempts: 3 },
  delivery: { kind: 'patch', targetBranch: 'feature', expectedTargetSha: 'a'.repeat(40) },
};

describe('immutable task input contract', () => {
  it('accepts an explicit old configuration version and a full SHA', () => {
    expect(TaskSnapshotSchema.parse(snapshot).configVersion).toBe(1);
  });
  it.each(['main', 'v1', 'a'.repeat(7)])('rejects mutable or abbreviated ref %s', (executionSha) => {
    expect(TaskSnapshotSchema.safeParse({ ...snapshot, executionSha }).success).toBe(false);
  });
  it.each(['../outside', '/etc', 'src/../../secret', 'src\\..\\secret'])('rejects escaping workdir %s', (workdir) => {
    expect(RepositoryConfigSchema.safeParse({ ...config, workdir }).success).toBe(false);
  });
  it('rejects secrets and unknown configuration fields', () => {
    expect(RepositoryConfigSchema.safeParse({ ...config, token: 'secret' }).success).toBe(false);
  });
  it('rejects missing failure evidence and nonpositive task budgets', () => {
    expect(TaskSnapshotSchema.safeParse({ ...snapshot, baseline: { command: 'pytest', expected: [] } }).success).toBe(false);
    expect(TaskSnapshotSchema.safeParse({ ...snapshot, budget: { ...snapshot.budget, tokens: 0 } }).success).toBe(false);
  });
});
