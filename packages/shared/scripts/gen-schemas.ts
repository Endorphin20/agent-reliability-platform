/**
 * 用 zod v4 原生 toJSONSchema 把契约导出为 JSON Schema，提交入库。
 * Python 端契约测试用这些文件校验 Pydantic 序列化结果。
 * 运行：pnpm gen:schemas
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { TraceEventSchema } from "../src/trace-event";
import { RunCommandSchema } from "../src/run-command";
import * as enums from "../src/enums";

const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "schemas");
mkdirSync(outDir, { recursive: true });

function emit(name: string, schema: z.ZodType) {
  const jsonSchema = z.toJSONSchema(schema, { target: "draft-7", io: "output" });
  writeFileSync(join(outDir, `${name}.json`), JSON.stringify(jsonSchema, null, 2) + "\n");
  console.log(`wrote schemas/${name}.json`);
}

emit("trace-event", TraceEventSchema);
emit("run-command", RunCommandSchema);

// 枚举清单单独导出，供 Python / Prisma 做集合比对
const enumSets: Record<string, readonly string[]> = {
  TaskSource: enums.TASK_SOURCES,
  TaskStatus: enums.TASK_STATUSES,
  RunStatus: enums.RUN_STATUSES,
  AttemptStatus: enums.ATTEMPT_STATUSES,
  AgentKind: enums.AGENT_KINDS,
  TraceEventType: enums.TRACE_EVENT_TYPES,
  FailureCode: enums.FAILURE_CODES,
  PolicyAction: enums.POLICY_ACTIONS,
  ApprovalStatus: enums.APPROVAL_STATUSES,
  OutboxStatus: enums.OUTBOX_STATUSES,
  ArtifactKind: enums.ARTIFACT_KINDS,
  RunCommandType: enums.RUN_COMMAND_TYPES,
  VerifierStep: enums.VERIFIER_STEPS,
};
writeFileSync(join(outDir, "enums.json"), JSON.stringify(enumSets, null, 2) + "\n");
console.log("wrote schemas/enums.json");
