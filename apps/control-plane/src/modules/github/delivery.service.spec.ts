import { assertDeliveryTarget, deliveryBranch } from './delivery.service';
it('rejects a target branch that moved after verification', () => {
  expect(() => assertDeliveryTarget('a'.repeat(40), 'b'.repeat(40))).toThrow();
  expect(() => assertDeliveryTarget('a'.repeat(40), 'a'.repeat(40))).not.toThrow();
});
it('uses a deterministic branch for the approved patch', () => {
  expect(deliveryBranch('task-1', 'f'.repeat(64))).toBe('arp-fix/task-1-ffffffffffff');
});

import { DeliveryService } from './delivery.service';
it('reconciles an existing PR before checking a target that may have moved afterwards', async () => {
  const snapshot = { schemaVersion: 2, mode: 'REAL', repositoryId: 'repo', configVersion: 1, executionSha: 'a'.repeat(40),
    agentKind: 'SELF_LANGGRAPH', title: 'Fix', description: 'Fix',
    config: { runtime: 'python-pytest', preparation: 'image', image: 'image', dependencyFiles: [], workdir: '.', allowedPaths: ['src/**'], protectedPaths: [], staticCheck: [], failToPass: ['pytest'], passToPass: [], acceptanceCriteria: ['fixed'] },
    baseline: { command: 'pytest', expected: ['test_bug'] }, budget: { tokens: 10000, seconds: 900, turns: 30, maxAttempts: 3 },
    delivery: { kind: 'pull-request', targetBranch: 'feature', expectedTargetSha: 'a'.repeat(40) } };
  const request = jest.fn().mockResolvedValue([{ body: 'arp-delivery:job:digest', html_url: 'https://github.com/a/b/pull/2' }]);
  const prisma = { deliveryJob: { findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'job', patchDigest: 'digest', branch: 'arp-fix/task',
    approval: { task: { snapshot, project: { writeCredential: 'ref', githubRepo: 'a/b' } }, run: {} } }) } };
  const service = new DeliveryService(prisma as any, {} as any, { request } as any);
  expect(await (service as any).deliver('job', 'lease')).toBe('https://github.com/a/b/pull/2');
  expect(request).toHaveBeenCalledTimes(1);
  expect(request.mock.calls[0][0]).toContain('/pulls?');
});
