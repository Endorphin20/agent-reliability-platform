import { PrImportService, parsePrUrl } from './pr-import.service';
import { CredentialStore } from '../credentials/credential-store';

it('rejects URLs outside GitHub pull requests', () => {
  expect(() => parsePrUrl('https://attacker.example/example/repo/pull/1')).toThrow();
  expect(parsePrUrl('https://github.com/example/repo/pull/42').number).toBe(42);
});
it('preserves unknown CI checkout context and returns failure evidence', async () => {
  const service = new PrImportService(new CredentialStore());
  jest.spyOn(service, 'request').mockImplementation(async (path) => {
    if (path.includes('/files')) return [{ filename: 'src/parser.py', status: 'modified', patch: '@@ diff' }];
    if (path.includes('/check-runs')) return { check_runs: [{ id: 1, name: 'pytest', conclusion: 'failure', head_sha: 'b'.repeat(40), output: { summary: 'test_empty failed' } }] };
    if (path.includes('/actions/runs')) return { workflow_runs: [] };
    return { title: 'Fix parser', body: 'bug', state: 'open', head: { sha: 'a'.repeat(40), ref: 'feature', repo: { full_name: 'example/repo' } }, base: { sha: 'c'.repeat(40), repo: { full_name: 'example/repo' } } };
  });
  const imported = await service.inspect('https://github.com/example/repo/pull/1', 'example/repo');
  expect(imported.checkoutSha).toBeNull();
  expect(imported.headSha).toBe('a'.repeat(40));
  expect(imported.checks[0].sha).toBe('b'.repeat(40));
  expect(imported.files[0].patch).toBe('@@ diff');
});
