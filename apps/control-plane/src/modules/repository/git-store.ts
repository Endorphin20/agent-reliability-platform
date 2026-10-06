import { CredentialStore } from '../credentials/credential-store';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Injectable } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { GitShaSchema } from '@arp/shared';

const exec = promisify(execFile);
@Injectable()
export class GitStore {
  constructor(private readonly credentials: CredentialStore = new CredentialStore()) {}
  async ensureCommit(path: string, repo: string, sha: string, credential?: string | null) {
    GitShaSchema.parse(sha);
    try { return await this.resolve(path, sha); } catch { /* Fetch only the exact requested object. */ }
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('Invalid repository');
    const directory = await mkdtemp(join(tmpdir(), 'arp-fetch-'));
    try {
      const askpass = join(directory, 'askpass.sh');
      await writeFile(askpass, '#!/bin/sh\ncase "$1" in *Username*) printf "%s" "x-access-token" ;; *) printf "%s" "$ARP_GIT_TOKEN" ;; esac\n', { mode: 0o700 });
      await exec('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'credential.helper=', '-C', path,
        'fetch', '--no-tags', '--no-recurse-submodules', `https://github.com/${repo}.git`, sha], {
        timeout: 120000, maxBuffer: 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: askpass, ARP_GIT_TOKEN: credential ? this.credentials.read(credential) : '' },
      });
      return await this.resolve(path, sha);
    } catch { throw new Error('Cannot obtain confirmed commit; refresh the local clone or check read permission'); }
    finally { await rm(directory, { recursive: true, force: true }); }
  }
  async run(path: string, args: string[]): Promise<string> {
    const { stdout } = await exec('git', ['-c', 'core.hooksPath=/dev/null', '-C', path, ...args], {
      timeout: 120000, maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' },
    });
    return stdout.trim();
  }
  async resolve(path: string, ref: string): Promise<string> {
    if (!ref || ref.startsWith('-') || /[\x00-\x20]/.test(ref)) throw new Error('Invalid Git ref');
    return GitShaSchema.parse(await this.run(path, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]));
  }
  async pin(path: string, sha: string, taskId: string) {
    GitShaSchema.parse(sha);
    if (!/^[a-zA-Z0-9_-]+$/.test(taskId)) throw new Error('Invalid task identifier');
    await this.run(path, ['update-ref', `refs/arp/tasks/${taskId}`, sha]);
  }
}
