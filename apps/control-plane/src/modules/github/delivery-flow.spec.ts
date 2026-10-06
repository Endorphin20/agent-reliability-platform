import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DeliveryService } from './delivery.service';

jest.mock('node:child_process', () => {
  const invoke = jest.fn();
  const custom = require('node:util').promisify.custom;
  invoke[custom] = (...args: unknown[]) => invoke(...args);
  return { execFile: invoke };
});

function fixture() {
  const sha = 'a'.repeat(40), patch = 'diff --git a/src/a.py b/src/a.py\n';
  const digest = createHash('sha256').update(patch).digest('hex');
  const snapshot = { schemaVersion: 2, mode: 'REAL', repositoryId: 'repo', configVersion: 1, executionSha: sha,
    agentKind: 'SELF_LANGGRAPH', title: 'Fix', description: 'Fix',
    config: { runtime: 'python-pytest', preparation: 'image', image: 'image', dependencyFiles: [], workdir: '.', allowedPaths: ['src/**'], protectedPaths: [], staticCheck: [], failToPass: ['pytest'], passToPass: [], acceptanceCriteria: ['fixed'] },
    baseline: { command: 'pytest', expected: ['test_bug'] }, budget: { tokens: 10000, seconds: 900, turns: 30, maxAttempts: 3 },
    delivery: { kind: 'pull-request', targetBranch: 'feature', expectedTargetSha: sha } };
  const job = { id: 'job', patchDigest: digest, branch: 'arp-fix/task', leaseToken: 'lease', status: 'RUNNING', leaseExpiresAt: new Date(Date.now() + 60000),
    approval: { task: { snapshot, project: { writeCredential: 'ref', githubRepo: 'a/b', repoPath: '/tmp/source' } }, run: { id: 'run', createdAt: new Date('2026-10-06T00:00:00Z') } } };
  const prisma = { deliveryJob: { findUniqueOrThrow: jest.fn().mockResolvedValue(job), update: jest.fn().mockResolvedValue(job) },
    artifact: { findFirst: jest.fn().mockResolvedValue({ content: patch }) } };
  return { job, prisma, sha };
}

beforeEach(() => {
  jest.clearAllMocks();
  (execFile as unknown as jest.Mock).mockImplementation(async (_cmd, args: string[]) => ({ stdout: args.includes('rev-parse') ? 'c'.repeat(40) : '', stderr: '' }));
});

it('retries only delivery after a lost create-PR response and never repeats the push', async () => {
  const { prisma, sha } = fixture();
  let created: { body: string; html_url: string } | null = null;
  const request = jest.fn(async (path: string, _credential: string, method: string, body?: any) => {
    if (method === 'POST') { created = { body: body.body, html_url: 'https://github.com/a/b/pull/3' }; throw new Error('response lost'); }
    if (path.includes('/pulls?')) return created ? [created] : [];
    return { object: { sha } };
  });
  const service = new DeliveryService(prisma as any, { read: () => 'CANARY_GITHUB_TOKEN' } as any, { request } as any);
  await expect((service as any).deliver('job', 'lease')).rejects.toThrow('response lost');
  expect(await (service as any).deliver('job', 'lease')).toBe('https://github.com/a/b/pull/3');
  const calls = (execFile as unknown as jest.Mock).mock.calls;
  expect(calls.filter(([, args]) => args.includes('push'))).toHaveLength(1);
  expect(JSON.stringify(calls.map(([cmd, args]) => [cmd, args]))).not.toContain('CANARY_GITHUB_TOKEN');
  expect(request.mock.calls.filter((call) => call[2] === 'POST')).toHaveLength(1);
});

it('does not push when the target moved or the approved patch changed', async () => {
  const { prisma, sha } = fixture();
  const request = jest.fn(async (path: string) => path.includes('/pulls?') ? [] : { object: { sha: 'b'.repeat(40) } });
  const service = new DeliveryService(prisma as any, {} as any, { request } as any);
  await expect((service as any).deliver('job', 'lease')).rejects.toThrow('Target branch changed');
  request.mockImplementation(async (path: string) => path.includes('/pulls?') ? [] : { object: { sha } });
  prisma.artifact.findFirst.mockResolvedValue({ content: 'tampered patch' });
  await expect((service as any).deliver('job', 'lease')).rejects.toThrow('Patch changed');
  expect(execFile).not.toHaveBeenCalled();
});
