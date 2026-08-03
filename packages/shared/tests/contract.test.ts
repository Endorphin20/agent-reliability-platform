import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  RunCommandSchema,
  TraceEventSchema,
  traceEventIdempotencyKey,
  TRACE_EVENT_TYPES,
} from "../src/index";

const fixturesDir = join(__dirname, "..", "fixtures");

function loadFixture(name: string): unknown[] {
  return JSON.parse(readFileSync(join(fixturesDir, name), "utf8"));
}

describe("TraceEvent 契约", () => {
  const events = loadFixture("trace-events.json");

  it("全部共享样例通过 zod 校验", () => {
    for (const event of events) {
      const result = TraceEventSchema.safeParse(event);
      expect(result.success, JSON.stringify(result.success ? null : result.error.issues)).toBe(true);
    }
  });

  it("样例覆盖全部 11 种事件类型", () => {
    const covered = new Set(events.map((e) => (e as { type: string }).type));
    for (const type of TRACE_EVENT_TYPES) {
      expect(covered.has(type), `缺少 ${type} 样例`).toBe(true);
    }
  });

  it("幂等键与信封字段一致", () => {
    for (const raw of events) {
      const event = TraceEventSchema.parse(raw);
      expect(event.idempotencyKey).toBe(
        traceEventIdempotencyKey(event.runId, event.attemptNo, event.attemptSequence),
      );
    }
  });

  it("payload 与 type 不匹配时校验失败", () => {
    const bad = {
      ...(events[0] as object),
      type: "TOOL_CALL", // MODEL_CALL 的 payload 配 TOOL_CALL 类型
    };
    expect(TraceEventSchema.safeParse(bad).success).toBe(false);
  });
});

describe("RunCommand 契约", () => {
  const commands = loadFixture("run-commands.json");

  it("全部共享样例通过 zod 校验", () => {
    for (const command of commands) {
      const result = RunCommandSchema.safeParse(command);
      expect(result.success, JSON.stringify(result.success ? null : result.error.issues)).toBe(true);
    }
  });

  it("RESUME_RUN 样例带 checkpointId", () => {
    const resume = commands
      .map((c) => RunCommandSchema.parse(c))
      .find((c) => c.type === "RESUME_RUN");
    expect(resume?.checkpointId).toBeTruthy();
  });
});
