/**
 * 全部跨服务枚举的单点定义（唯一真相源）。
 * Prisma enum 与 Python 端 Pydantic 枚举都是本文件的镜像，
 * 契约测试会做集合比对，任何一端增减值都会失败。
 */

export const TASK_SOURCES = ["MANUAL", "GITHUB_ISSUE", "WORKFLOW_RUN"] as const;
export type TaskSource = (typeof TASK_SOURCES)[number];

export const TASK_STATUSES = [
  "CREATED",
  "QUEUED",
  "RUNNING",
  "AWAITING_APPROVAL",
  "APPROVED",
  "PR_CREATED",
  "PR_FAILED",
  "RESOLVED",
  "REJECTED",
  "FAILED",
  "CANCELLED",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const RUN_STATUSES = [
  "PENDING",
  "DISPATCHED",
  "RUNNING",
  "VERIFYING",
  "INTERRUPTED",
  "RECOVERING",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const ATTEMPT_STATUSES = [
  "CLAIMED",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "CRASHED",
  "TIMED_OUT",
  "LEASE_EXPIRED",
] as const;
export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];

export const AGENT_KINDS = ["SELF_LANGGRAPH", "MINI_SWE"] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

export const TRACE_EVENT_TYPES = [
  "MODEL_CALL",
  "TOOL_CALL",
  "FILE_CHANGE",
  "COMMAND_EXEC",
  "STATE_TRANSITION",
  "CHECKPOINT_SAVED",
  "FAILURE_DETECTED",
  "RECOVERY_ACTION",
  "VERIFICATION_RESULT",
  "APPROVAL_EVENT",
  "BUDGET_UPDATE",
] as const;
export type TraceEventType = (typeof TRACE_EVENT_TYPES)[number];

export const FAILURE_CODES = [
  "MODEL_RATE_LIMIT",
  "MODEL_API_ERROR",
  "MODEL_BAD_OUTPUT",
  "TOOL_EXEC_ERROR",
  "PATCH_APPLY_FAILED",
  "SANDBOX_START_FAILED",
  "SANDBOX_CRASHED",
  "WORKER_LOST",
  "BUDGET_TOKENS_EXCEEDED",
  "BUDGET_TIME_EXCEEDED",
  "BUDGET_TURNS_EXCEEDED",
  "AGENT_STUCK",
  "VERIFY_PATCH_MALFORMED",
  "VERIFY_SCOPE_VIOLATION",
  "VERIFY_STATIC_FAILED",
  "VERIFY_TARGET_TESTS_FAILED",
  "VERIFY_REGRESSION_FAILED",
  "VERIFY_TEST_TAMPERING",
  "HUMAN_REJECTED",
  "CANCELLED_BY_USER",
] as const;
export type FailureCode = (typeof FAILURE_CODES)[number];

export const POLICY_ACTIONS = [
  "RESUME",
  "RESTART_ATTEMPT",
  "ESCALATE_HUMAN",
  "ABORT",
] as const;
export type PolicyAction = (typeof POLICY_ACTIONS)[number];

export const APPROVAL_STATUSES = ["PENDING", "APPROVED", "REJECTED"] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const OUTBOX_STATUSES = ["PENDING", "PUBLISHED", "FAILED"] as const;
export type OutboxStatus = (typeof OUTBOX_STATUSES)[number];

export const ARTIFACT_KINDS = ["PATCH", "TEST_REPORT", "LOG", "JUDGE_REPORT"] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export const RUN_COMMAND_TYPES = ["START_RUN", "RESUME_RUN", "CANCEL_RUN"] as const;
export type RunCommandType = (typeof RUN_COMMAND_TYPES)[number];

export const VERIFIER_STEPS = ["V1", "V2", "V3", "V4", "V5", "V6"] as const;
export type VerifierStep = (typeof VERIFIER_STEPS)[number];
