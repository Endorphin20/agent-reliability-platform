import { BadRequestException, Injectable } from '@nestjs/common';
import { CredentialStore } from '../credentials/credential-store';

export function parsePrUrl(url: string) {
  const match = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/([1-9]\d*)\/?$/.exec(url);
  if (!match) throw new BadRequestException('Expected a GitHub pull request URL');
  return { repo: `${match[1]}/${match[2]}`, number: Number(match[3]) };
}
@Injectable()
export class PrImportService {
  constructor(private readonly credentials: CredentialStore) {}
  async request(path: string, credential?: string | null, method = 'GET', body?: unknown): Promise<any> {
    const token = credential ? this.credentials.read(credential) : '';
    const response = await fetch(`https://api.github.com${path}`, {
      method, signal: AbortSignal.timeout(30000),
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
        ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw new BadRequestException(`GitHub HTTP ${response.status}; check repository permission, rate limit or resource availability`);
    return response.json();
  }
  async jobLog(repo: string, jobId: number, credential?: string | null): Promise<string> {
    const token = credential ? this.credentials.read(credential) : '';
    const response = await fetch(`https://api.github.com/repos/${repo}/actions/jobs/${jobId}/logs`, {
      redirect: 'manual', signal: AbortSignal.timeout(30000),
      headers: { Accept: 'application/vnd.github+json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    });
    let result = response;
    if (response.status === 302) {
      const location = response.headers.get('location');
      if (!location || new URL(location).protocol !== 'https:') throw new BadRequestException('Invalid log download location');
      // Signed download URLs receive no repository credential.
      result = await fetch(location, { signal: AbortSignal.timeout(30000), redirect: 'error' });
    }
    if (!result.ok || !result.body) throw new BadRequestException(`Logs unavailable (HTTP ${result.status}); provide failure evidence manually`);
    const reader = result.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
    try {
      while (total < 200000) {
        const next = await reader.read(); if (next.done) break;
        const chunk = next.value.slice(0, 200000 - total); chunks.push(chunk); total += chunk.length;
      }
    } finally { await reader.cancel(); }
    let text = Buffer.concat(chunks).toString('utf8');
    if (token) text = text.split(token).join('[REDACTED]');
    return text.replace(/(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)/g, '[REDACTED]') + (total >= 200000 ? '\n[log truncated at 200 KB]' : '');
  }
  async inspect(url: string, repo: string, credential?: string | null) {
    const parsed = parsePrUrl(url);
    if (parsed.repo.toLowerCase() !== repo.toLowerCase()) throw new BadRequestException('PR does not belong to the selected repository');
    const pr = await this.request(`/repos/${repo}/pulls/${parsed.number}`, credential);
    if (pr.state !== 'open' || pr.head.repo?.full_name !== pr.base.repo?.full_name) throw new BadRequestException('Only open, same-repository PRs are supported');
    const files: Array<{ filename: string; status: string; patch?: string }> = [];
    for (let page = 1; page <= 30; page++) {
      const batch = await this.request(`/repos/${repo}/pulls/${parsed.number}/files?per_page=100&page=${page}`, credential);
      files.push(...batch.map((f: any) => ({ filename: f.filename, status: f.status, patch: f.patch?.slice(0, 10000) })));
      if (batch.length < 100) break;
    }
    const checks: any[] = [];
    for (let page = 1; page <= 10; page++) {
      const batch = await this.request(`/repos/${repo}/commits/${pr.head.sha}/check-runs?per_page=100&page=${page}`, credential);
      checks.push(...batch.check_runs.filter((c: any) => ['failure', 'timed_out', 'cancelled', 'action_required'].includes(c.conclusion))
        .map((c: any) => ({ id: c.id, name: c.name, sha: c.head_sha, conclusion: c.conclusion,
          url: c.details_url, summary: c.output?.summary?.slice(0, 20000) ?? '', text: c.output?.text?.slice(0, 20000) ?? '' })));
      if (batch.check_runs.length < 100) break;
    }
    const workflowRuns = await this.request(`/repos/${repo}/actions/runs?head_sha=${pr.head.sha}&per_page=100`, credential);
    const runs = workflowRuns.workflow_runs.map((run: any) => ({ id: run.id, name: run.name, attempt: run.run_attempt,
      sha: run.head_sha, conclusion: run.conclusion, url: run.html_url, createdAt: run.created_at }));
    return { title: pr.title, description: pr.body || pr.title, headSha: pr.head.sha,
      baseSha: pr.base.sha, headBranch: pr.head.ref, baseBranch: pr.base.ref, files, checks,
      runs,
      checkoutSha: null, warning: 'CI checkout SHA must be confirmed from workflow logs; head_sha is not proof of checkout.' };
  }
}
