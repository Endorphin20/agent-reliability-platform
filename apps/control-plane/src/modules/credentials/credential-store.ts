import { Injectable } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function dataDirectory() { return process.env.ARP_DATA_DIR || join(homedir(), '.arp'); }
@Injectable()
export class CredentialStore {
  save(kind: string, value: string): string {
    if (!['github', 'model'].includes(kind) || !value.trim() || value.length > 8192 || /[\r\n\0]/.test(value)) {
      throw new Error('Invalid credential');
    }
    const directory = join(dataDirectory(), 'credentials');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const ref = `${kind}-${randomUUID()}`;
    writeFileSync(join(directory, ref), value, { mode: 0o600, flag: 'wx' });
    return ref;
  }
  read(ref: string): string {
    if (!/^(github|model)-[a-f0-9-]{36}$/.test(ref)) throw new Error('Invalid credential reference');
    return readFileSync(join(dataDirectory(), 'credentials', ref), 'utf8');
  }
  accessToken(): string {
    const directory = dataDirectory();
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = join(directory, 'access-token');
    try { writeFileSync(file, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    return readFileSync(file, 'utf8').trim();
  }
}
