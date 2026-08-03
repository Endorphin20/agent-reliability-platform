"""FakeExecutor（T4 空转闭环）：产出 10 个脚本化 TraceEvent 后成功。

用途：验证 Outbox -> Streams -> 认领 -> 事件回流 -> SSE 的全链路，
以及 kill worker 后的租约过期 + 恢复重投。真实 Agent 在 T6 接入。
"""

import hashlib
import time

from arp_runtime.events import EventEmitter
from arp_runtime.schemas.run_command import RunCommand


def run_fake_executor(command: RunCommand, emitter: EventEmitter) -> None:
    def digest(text: str) -> str:
        return "sha256:" + hashlib.sha256(text.encode()).hexdigest()[:16]

    steps = [
        ("MODEL_CALL", {"model": "fake-model", "promptTokens": 100, "completionTokens": 50, "latencyMs": 30, "turn": 1}),
        ("TOOL_CALL", {"toolCallId": f"tc-{command.runId}-1", "tool": "read_file", "args": {"path": "src/app.ts"}, "resultDigest": digest("read"), "durationMs": 5, "cached": False}),
        ("MODEL_CALL", {"model": "fake-model", "promptTokens": 200, "completionTokens": 80, "latencyMs": 25, "turn": 2}),
        ("TOOL_CALL", {"toolCallId": f"tc-{command.runId}-2", "tool": "apply_patch", "args": {"path": "src/app.ts"}, "resultDigest": digest("patch"), "durationMs": 8, "cached": False}),
        ("FILE_CHANGE", {"path": "src/app.ts", "changeType": "modify", "diffStat": {"additions": 3, "deletions": 1}}),
        ("COMMAND_EXEC", {"command": "pnpm test", "exitCode": 0, "stdoutTail": "3 passed", "durationMs": 120}),
        ("CHECKPOINT_SAVED", {"checkpointId": f"fake-ckpt-{command.runId}", "usedTokens": 430, "usedSeconds": 2}),
        ("MODEL_CALL", {"model": "fake-model", "promptTokens": 300, "completionTokens": 60, "latencyMs": 20, "turn": 3}),
        ("BUDGET_UPDATE", {"usedTokens": 790, "usedSeconds": 3, "usedTurns": 3}),
        ("COMMAND_EXEC", {"command": "pnpm vitest run", "exitCode": 0, "stdoutTail": "all passed", "durationMs": 200}),
    ]
    for event_type, payload in steps:
        emitter.emit(event_type, payload)
        time.sleep(0.5)  # 拉长执行窗口，让 kill worker 的故障注入有可乘之机
