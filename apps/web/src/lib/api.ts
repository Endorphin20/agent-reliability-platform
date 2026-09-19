/** Control Plane API 客户端与类型（唯一真相源 = control-plane DB，IM-03）。 */

export const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:3801";

export async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`${init?.method ?? "GET"} ${path} ${response.status}: ${body.slice(0, 300)}`);
  }
  return response.json() as Promise<T>;
}

// ---- 类型（与 control-plane API 响应对齐） ----

export type AgentKind = "SELF_LANGGRAPH" | "MINI_SWE";

export interface TaskListItem {
  id: string;
  title: string;
  status: string;
  fixtureId: string | null;
  createdAt: string;
  runs: { id: string; agentKind: AgentKind; status: string; createdAt: string }[];
  approval: {
    id: string;
    status: string;
    prUrl: string | null;
    prError?: string | null;
  } | null;
}

export interface TaskListResponse {
  items: TaskListItem[];
  total: number;
  page: number;
  pageSize: number;
}

export interface Fixture {
  id: string;
  title: string;
  category: string;
  acceptanceCriteria: string[];
}

export interface Attempt {
  id: string;
  no: number;
  status: string;
  failureCode: string | null;
  workerId: string | null;
  createdAt: string;
  endedAt: string | null;
}

export interface PolicyDecision {
  id: string;
  attemptId: string;
  failureCode: string;
  action: string;
  reason: string;
  createdAt: string;
}

export interface VerificationResult {
  id: string;
  attemptId: string;
  step: "V1" | "V2" | "V3" | "V4" | "V5" | "V6";
  passed: boolean;
  failureCode: string | null;
  detail: Record<string, unknown>;
  durationMs: number;
  createdAt: string;
}

export interface RunDetail {
  id: string;
  taskId: string;
  agentKind: AgentKind;
  status: string;
  budgetTokens: number;
  budgetSeconds: number;
  budgetTurns: number;
  usedTokens: number;
  usedSeconds: number;
  createdAt: string;
  updatedAt: string;
  attempts: Attempt[];
  policyDecisions: PolicyDecision[];
  verificationResults: VerificationResult[];
}

export interface TraceEvent {
  runSequence: number;
  attemptId: string | null;
  attemptSequence: number;
  type: string;
  payload: Record<string, unknown>;
  occurredAt: string;
}

export interface JudgeReport {
  model: string;
  criteria: { criterion: string; score: number; rationale: string }[];
  overallComment: string;
}

export interface EvaluationSummary {
  total: number;
  resolved: number;
  resolveRate: number;
  firstTrySuccessRate: number;
  recoveredRate: number | null;
  scopeViolations: number;
  avgTokens: number;
  totalCostUsd: number;
  avgWallSeconds: number;
  avgJudgeScore: number | null;
}

export interface EvaluationRun {
  id: string;
  suite: string;
  agentKind: AgentKind;
  faultInjection: string | null;
  startedAt: string;
  finishedAt: string | null;
  summary: EvaluationSummary | null;
}

export interface EvaluationResultRow {
  id: string;
  fixtureId: string;
  runId: string;
  resolved: boolean;
  firstTrySuccess: boolean;
  recovered: boolean | null;
  recoveryMode: string | null;
  scopeViolations: number;
  tokens: number;
  costUsd: string;
  wallSeconds: number;
  judgeScores: { criteria?: { criterion: string; score: number }[] } | null;
}

export interface EvaluationDetail extends EvaluationRun {
  results: EvaluationResultRow[];
}
