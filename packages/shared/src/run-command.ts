import { z } from "zod";
import { AGENT_KINDS, RUN_COMMAND_TYPES } from "./enums";

/**
 * RunCommand：Control Plane 经 Transactional Outbox 发布到 Redis Streams
 * `run-commands` 主题、由 Runtime Worker 消费的命令。
 * commandId 即幂等键：`cmd:${runId}:${type}:${attemptNo}`。
 */

export const TaskSpecSchema = z.object({
  fixtureId: z.string(),
  description: z.string(),
  workdir: z.string(), // 命令执行目录（相对仓库根）
  allowedPaths: z.array(z.string()),
  staticCheck: z.array(z.string()),
  failToPass: z.array(z.string()),
  passToPass: z.array(z.string()),
  acceptanceCriteria: z.array(z.string()), // LLM Judge 逐条打分依据
  // SWE-bench 类任务：验证用测试来自基准自带的 test_patch，Agent 不可见，
  // Verifier 在 V6 之后、跑测试之前应用，跑完立即回滚
  testPatch: z.string().optional(),
});

export const BudgetSchema = z.object({
  tokens: z.number().int().positive(),
  seconds: z.number().int().positive(),
  turns: z.number().int().positive(),
  remainingTokens: z.number().int().nonnegative(),
  remainingSeconds: z.number().int().nonnegative(),
});

export const RunCommandSchema = z.object({
  commandId: z.string().min(1),
  type: z.enum(RUN_COMMAND_TYPES),
  runId: z.string().min(1),
  attemptNo: z.number().int().positive(),
  agentKind: z.enum(AGENT_KINDS),
  repo: z.object({
    path: z.string(),
    baseCommit: z.string(),
  }),
  taskSpec: TaskSpecSchema,
  budget: BudgetSchema,
  checkpointId: z.string().optional(),
});

export type RunCommand = z.infer<typeof RunCommandSchema>;
export type TaskSpec = z.infer<typeof TaskSpecSchema>;
export type Budget = z.infer<typeof BudgetSchema>;

export function runCommandId(runId: string, type: string, attemptNo: number): string {
  return `cmd:${runId}:${type}:${attemptNo}`;
}
