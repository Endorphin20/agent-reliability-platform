import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitStore } from './git-store';

describe('pinned repository objects', () => {
  let path: string;
  beforeEach(() => {
    path = mkdtempSync(join(tmpdir(), 'arp-git-test-'));
    execFileSync('git', ['init', '-q', path]);
    execFileSync('git', ['-C', path, 'config', 'user.email', 'test@example.invalid']);
    execFileSync('git', ['-C', path, 'config', 'user.name', 'Test']);
    writeFileSync(join(path, 'code.py'), 'original');
    execFileSync('git', ['-C', path, 'add', '.']);
    execFileSync('git', ['-C', path, 'commit', '-qm', 'base']);
  });
  afterEach(() => rmSync(path, { recursive: true, force: true }));
  it('pins a full SHA even when the source branch moves', async () => {
    const git = new GitStore();
    const first = await git.resolve(path, 'HEAD');
    await git.pin(path, first, 'task-1');
    writeFileSync(join(path, 'code.py'), 'changed');
    execFileSync('git', ['-C', path, 'commit', '-qam', 'next']);
    expect(await git.resolve(path, 'refs/arp/tasks/task-1')).toBe(first);
    expect(await git.resolve(path, 'HEAD')).not.toBe(first);
  });
  it('rejects option injection and non-commit objects', async () => {
    const git = new GitStore();
    await expect(git.resolve(path, '--help')).rejects.toThrow();
    const blob = execFileSync('git', ['-C', path, 'rev-parse', 'HEAD:code.py']).toString().trim();
    await expect(git.resolve(path, blob)).rejects.toThrow();
  });
});
