import { digestSnapshot, commandFromSnapshot } from './task-snapshot.service';

const snapshot = {
  schemaVersion: 2 as const, mode: 'REAL' as const, repositoryId: 'r', configVersion: 1,
  executionSha: 'a'.repeat(40), agentKind: 'SELF_LANGGRAPH' as const, title: 'bug', description: 'fix',
  config: { runtime: 'python-pytest' as const, preparation: 'image' as const, image: 'image',
    dependencyFiles: [], workdir: '.', allowedPaths: ['src/**'], protectedPaths: ['tests/**'],
    staticCheck: [], failToPass: ['pytest'], passToPass: [], acceptanceCriteria: ['fixed'] },
  baseline: { command: 'pytest', expected: ['test_bug'] },
  budget: { tokens: 100, seconds: 50, turns: 10, maxAttempts: 3 },
  delivery: { kind: 'patch' as const, targetBranch: 'feature', expectedTargetSha: 'a'.repeat(40) },
};
it('hashes equivalent input independent of object key order', () => {
  expect(digestSnapshot(snapshot)).toBe(digestSnapshot({ ...snapshot, budget: { maxAttempts: 3, turns: 10, seconds: 50, tokens: 100 } }));
});
it('builds recovery from frozen inputs and remaining budget', () => {
  const c = commandFromSnapshot(snapshot, '/repo', 'run', 2, 80, 40, 'checkpoint');
  expect(c.repo.baseCommit).toBe(snapshot.executionSha);
  expect(c.budget.remainingTokens).toBe(20);
  expect(c.budget.remainingSeconds).toBe(10);
  expect(c.type).toBe('RESUME_RUN');
  expect(c.snapshot).toEqual(snapshot);
});
it('always rechecks the original failure even when other target commands are configured', () => {
  const c = commandFromSnapshot({ ...snapshot, baseline: { command: 'pytest tests/test_original.py', expected: ['test_bug'] } }, '/repo', 'run', 1);
  expect(c.taskSpec.failToPass).toEqual(['pytest tests/test_original.py', 'pytest']);
});
