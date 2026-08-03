import { z } from "zod";
import {
  FAILURE_CODES,
  POLICY_ACTIONS,
  VERIFIER_STEPS,
} from "./enums";

/**
 * TraceEvent：Runtime 产出、经 Redis Streams 回流、Control Plane 落库并 SSE 分发的事件。
 * 信封字段全类型共有；payload 按 type 收窄（discriminated union）。
 * 幂等键组成：`${runId}:${attemptNo}:${attemptSequence}`（见 §4.5）。
 */

const envelope = {
  runId: z.string().min(1),
  attemptId: z.string().min(1),
  attemptNo: z.number().int().positive(),
  attemptSequence: z.number().int().positive(),
  occurredAt: z.iso.datetime(),
  idempotencyKey: z.string().min(1),
};

export const ModelCallPayload = z.object({
  model: z.string(),
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  latencyMs: z.number().int().nonnegative(),
  turn: z.number().int().nonnegative(),
});

export const ToolCallPayload = z.object({
  toolCallId: z.string(),
  tool: z.string(),
  args: z.record(z.string(), z.unknown()),
  resultDigest: z.string(),
  durationMs: z.number().int().nonnegative(),
  cached: z.boolean(),
});

export const FileChangePayload = z.object({
  path: z.string(),
  changeType: z.enum(["modify", "create", "delete"]),
  diffStat: z.object({
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
  }),
});

export const CommandExecPayload = z.object({
  command: z.string(),
  exitCode: z.number().int(),
  stdoutTail: z.string(),
  durationMs: z.number().int().nonnegative(),
});

export const StateTransitionPayload = z.object({
  entity: z.enum(["task", "run", "attempt"]),
  from: z.string(),
  to: z.string(),
});

export const CheckpointSavedPayload = z.object({
  checkpointId: z.string(),
  usedTokens: z.number().int().nonnegative(),
  usedSeconds: z.number().int().nonnegative(),
});

export const FailureDetectedPayload = z.object({
  failureCode: z.enum(FAILURE_CODES),
  message: z.string(),
});

export const RecoveryActionPayload = z.object({
  action: z.enum(POLICY_ACTIONS),
  fromCheckpointId: z.string().nullable(),
  newAttemptNo: z.number().int().positive(),
});

export const VerificationResultPayload = z.object({
  step: z.enum(VERIFIER_STEPS),
  passed: z.boolean(),
  failureCode: z.enum(FAILURE_CODES).optional(),
  detail: z.record(z.string(), z.unknown()),
});

export const ApprovalEventPayload = z.object({
  status: z.enum(["PENDING", "APPROVED", "REJECTED"]),
  reviewer: z.string().nullable(),
  prUrl: z.string().nullable(),
});

export const BudgetUpdatePayload = z.object({
  usedTokens: z.number().int().nonnegative(),
  usedSeconds: z.number().int().nonnegative(),
  usedTurns: z.number().int().nonnegative(),
});

export const TraceEventSchema = z.discriminatedUnion("type", [
  z.object({ ...envelope, type: z.literal("MODEL_CALL"), payload: ModelCallPayload }),
  z.object({ ...envelope, type: z.literal("TOOL_CALL"), payload: ToolCallPayload }),
  z.object({ ...envelope, type: z.literal("FILE_CHANGE"), payload: FileChangePayload }),
  z.object({ ...envelope, type: z.literal("COMMAND_EXEC"), payload: CommandExecPayload }),
  z.object({ ...envelope, type: z.literal("STATE_TRANSITION"), payload: StateTransitionPayload }),
  z.object({ ...envelope, type: z.literal("CHECKPOINT_SAVED"), payload: CheckpointSavedPayload }),
  z.object({ ...envelope, type: z.literal("FAILURE_DETECTED"), payload: FailureDetectedPayload }),
  z.object({ ...envelope, type: z.literal("RECOVERY_ACTION"), payload: RecoveryActionPayload }),
  z.object({ ...envelope, type: z.literal("VERIFICATION_RESULT"), payload: VerificationResultPayload }),
  z.object({ ...envelope, type: z.literal("APPROVAL_EVENT"), payload: ApprovalEventPayload }),
  z.object({ ...envelope, type: z.literal("BUDGET_UPDATE"), payload: BudgetUpdatePayload }),
]);

export type TraceEvent = z.infer<typeof TraceEventSchema>;

export function traceEventIdempotencyKey(
  runId: string,
  attemptNo: number,
  attemptSequence: number,
): string {
  return `${runId}:${attemptNo}:${attemptSequence}`;
}
