import { mkdtempSync, rmSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CredentialStore } from './credential-store';

describe('local credential storage', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'arp-secrets-')); process.env.ARP_DATA_DIR = root; });
  afterEach(() => { delete process.env.ARP_DATA_DIR; rmSync(root, { recursive: true, force: true }); });
  it('stores only an opaque reference outside task data with owner-only permissions', () => {
    const store = new CredentialStore();
    const ref = store.save('github', 'canary-test-secret');
    expect(ref).not.toContain('canary');
    expect(store.read(ref)).toBe('canary-test-secret');
    expect(statSync(join(root, 'credentials', ref)).mode & 0o777).toBe(0o600);
  });
  it('rejects path traversal references', () => {
    expect(() => new CredentialStore().read('../outside')).toThrow();
  });
  it('creates a stable local access key without returning it as task metadata', () => {
    const store = new CredentialStore();
    const token = store.accessToken();
    expect(token.length).toBeGreaterThan(32);
    expect(new CredentialStore().accessToken()).toBe(token);
    expect(readFileSync(join(root, 'access-token'), 'utf8')).toBe(token);
  });
});
