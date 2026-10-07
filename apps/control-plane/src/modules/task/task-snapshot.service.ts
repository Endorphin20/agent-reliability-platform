import { createHash } from 'node:crypto';
import { RunCommandSchema, TaskSnapshotSchema, type TaskSnapshot } from '@arp/shared';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
export function digestSnapshot(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}
export function commandFromSnapshot(raw: TaskSnapshot, repoPath: string, runId: string,
  attemptNo: number, usedTokens = 0, usedSeconds = 0, checkpointId?: string) {
  const snapshot = TaskSnapshotSchema.parse(raw);
  const type = checkpointId ? 'RESUME_RUN' : 'START_RUN';
  return RunCommandSchema.parse({
    schemaVersion: 2, snapshot,
    commandId: `cmd:${runId}:${type}:${attemptNo}`, type, runId, attemptNo,
    agentKind: snapshot.agentKind, repo: { path: repoPath, baseCommit: snapshot.executionSha },
    taskSpec: { description: snapshot.description, workdir: snapshot.config.workdir,
      allowedPaths: snapshot.config.allowedPaths, staticCheck: snapshot.config.staticCheck,
      failToPass: [...new Set([snapshot.baseline.command, ...snapshot.config.failToPass])], passToPass: snapshot.config.passToPass,
      acceptanceCriteria: snapshot.config.acceptanceCriteria },
    budget: { tokens: snapshot.budget.tokens, seconds: snapshot.budget.seconds, turns: snapshot.budget.turns,
      remainingTokens: Math.max(0, snapshot.budget.tokens - usedTokens),
      remainingSeconds: Math.max(0, snapshot.budget.seconds - usedSeconds) },
    ...(checkpointId ? { checkpointId } : {}),
  });
}
