import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { CredentialStore } from '../credentials/credential-store';
import { LocalAuthGuard } from './local-auth.guard';

it('keeps secrets in private files and separates browser and worker authorization', () => {
  const directory = mkdtempSync(join(tmpdir(), 'arp-auth-test-'));
  const previous = process.env.ARP_DATA_DIR;
  process.env.ARP_DATA_DIR = directory;
  try {
    const store = new CredentialStore();
    const reference = store.save('github', 'CANARY_SECRET');
    expect(reference).not.toContain('CANARY');
    expect(statSync(join(directory, 'credentials', reference)).mode & 0o777).toBe(0o600);
    expect(store.read(reference)).toBe('CANARY_SECRET');
    const access = store.accessToken();
    expect(store.accessToken()).toBe(access);
    expect(readFileSync(join(directory, 'access-token'), 'utf8')).toBe(access);
    const guard = new LocalAuthGuard(store);
    const context = (path: string, token: string, origin?: string) => ({ switchToHttp: () => ({ getRequest: () => ({ path, headers: { authorization: `Bearer ${token}`, origin } }) }) }) as any;
    expect(guard.canActivate(context('/api/repositories', access))).toBe(true);
    expect(() => guard.canActivate(context('/internal/attempts/claim', access))).toThrow();
    expect(() => guard.canActivate(context('/api/repositories', access, 'https://untrusted.example'))).toThrow();
    const worker = createHmac('sha256', access).update('arp-worker').digest('hex');
    expect(guard.canActivate(context('/internal/attempts/claim', worker))).toBe(true);
    expect(() => guard.canActivate(context('/api/credentials', worker))).toThrow();
  } finally {
    if (previous === undefined) delete process.env.ARP_DATA_DIR; else process.env.ARP_DATA_DIR = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});
