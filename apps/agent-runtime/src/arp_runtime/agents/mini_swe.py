"""MiniSWEAgentAdapter（T10）：mini-swe-agent 作为对照 Agent 接入平台。

接入方式（Python API，比解析 CLI stdout 更稳）：
- SandboxEnvironment：mini-swe 的 bash 动作全部经 Sandbox.exec 在隔离容器内执行
  （与自研 Agent 同一安全边界：network none / read-only rootfs / 资源限额），
  每个动作产出 TOOL_CALL + COMMAND_EXEC 事件；
- InstrumentedMiniModel：litellm 走同一 OpenAI 兼容端点，接管 MODEL_CALL /
  BUDGET_UPDATE 事件、token 预算（Run 级累计）与 429 归一化、故障注入；
- capabilities.fineGrainedResume=False：RESUME 退化为 Attempt 级重启
  （recoveryMode=attempt-restart），失败反馈以文本注入新任务提示。
"""

import hashlib
import logging
import os
import time
from typing import Any

# 必须在 import minisweagent 之前设置：静默启动横幅；代理端点模型无 litellm
# 价格表，成本记 0（预算控制走我们自己的 token 口径，不用它的 cost_limit）
os.environ.setdefault("MSWEA_SILENT_STARTUP", "1")
os.environ.setdefault("MSWEA_COST_TRACKING", "ignore_errors")

from arp_runtime.agents.adapter import AdapterResult, AgentCapabilities
from arp_runtime.agents.llm import ModelRateLimitError, maybe_inject_model_fault
from arp_runtime.agents.self_agent.graph import AgentStuck, BudgetExceeded
from arp_runtime.config import get_settings
from arp_runtime.events import EventEmitter
from arp_runtime.sandbox.provider import Sandbox
from arp_runtime.schemas.run_command import Budget, RunCommand

logger = logging.getLogger("arp.mini_swe")

SYSTEM_TEMPLATE = """You are an autonomous software engineer working in a sandboxed repository.
You interact with the system exclusively through bash commands (one bash tool call per response).
"""

INSTANCE_TEMPLATE = """Please fix this issue: {{task}}

## Rules

1. Every response MUST contain exactly one `bash` tool call plus brief reasoning text.
2. Each command runs in a fresh subshell: prefix with `cd <dir> && ...` when needed.
3. Only modify files inside the allowed paths listed in the task. NEVER modify test files.
4. When the required tests pass, submit by running exactly:
   `echo COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT`
   (no other command combined with it).

## Useful patterns

- View file with line numbers: `nl -ba file | sed -n '1,80p'`
- Overwrite a file: `cat <<'EOF' > file ... EOF`
- In-place edit: `sed -i 's/old/new/' file` (GNU sed inside the sandbox)
"""

# 长输出截断模板（取自 mini-swe-agent 内置 mini.yaml，避免测试全量输出撑爆上下文）
OBSERVATION_TEMPLATE = """\
{%- if output.output | length < 10000 -%}
{
  "returncode": {{ output.returncode }},
  "output": {{ output.output | tojson }}
  {%- if output.exception_info %}, "exception_info": {{ output.exception_info | tojson }}{% endif %}
}
{%- else -%}
{
  "returncode": {{ output.returncode }},
  "output_head": {{ output.output[:5000] | tojson }},
  "output_tail": {{ output.output[-5000:] | tojson }},
  "elided_chars": {{ output.output | length - 10000 }},
  "warning": "Output too long."
  {%- if output.exception_info %}, "exception_info": {{ output.exception_info | tojson }}{% endif %}
}
{%- endif -%}"""

FORMAT_ERROR_TEMPLATE = """\
{% if finish_reason is defined and (finish_reason == "length" or (finish_reason == "tool_calls" and not has_tool_calls)) -%}
Your previous response was cut off (finish_reason={{ finish_reason }}) before producing a tool call. Respond more concisely and finish with exactly one bash tool call.
{%- else -%}
Tool call error:

<error>
{{error}}
</error>

Every response must call the `bash` tool exactly once with {"command": "..."}.
To finish, run exactly: `echo COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT`
{%- endif %}"""


def _digest(text: str) -> str:
    return "sha256:" + hashlib.sha256(text.encode()).hexdigest()[:16]


class SandboxEnvironment:
    """mini-swe Environment 协议实现：动作路由到平台 Docker 沙箱。"""

    def __init__(self, sandbox: Sandbox, emitter: EventEmitter, cwd: str) -> None:
        self.sandbox = sandbox
        self.emitter = emitter
        self.cwd = cwd
        self.config = {"cwd": cwd}

    def execute(self, action: dict, cwd: str = "") -> dict[str, Any]:
        from minisweagent.exceptions import Submitted

        command = action.get("command", "")
        start = time.monotonic()
        result = self.sandbox.exec(command, cwd=cwd or self.cwd)
        duration_ms = int((time.monotonic() - start) * 1000)
        self.emitter.emit("TOOL_CALL", {
            "toolCallId": action.get("tool_call_id") or f"mini-{self.emitter.sequence + 1}",
            "tool": "bash",
            "args": {"command": command[:1000]},
            "resultDigest": _digest(result.stdout),
            "durationMs": duration_ms,
            "cached": False,
        })
        self.emitter.emit("COMMAND_EXEC", {
            "command": command[:1000],
            "exitCode": result.exit_code,
            "stdoutTail": result.stdout[-2000:],
            "durationMs": duration_ms,
        })
        output = {"output": result.stdout, "returncode": result.exit_code, "exception_info": ""}
        lines = result.stdout.lstrip().splitlines(keepends=True)
        if lines and lines[0].strip() == "COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT" and result.exit_code == 0:
            submission = "".join(lines[1:])
            raise Submitted({
                "role": "exit",
                "content": submission,
                "extra": {"exit_status": "Submitted", "submission": submission},
            })
        return output

    def get_template_vars(self, **kwargs) -> dict[str, Any]:
        return {"cwd": self.cwd, **kwargs}

    def serialize(self) -> dict:
        return {"info": {"config": {"environment": self.config,
                                    "environment_type": "arp_runtime.SandboxEnvironment"}}}


class InstrumentedMiniModel:
    """LitellmModel 包装：MODEL_CALL/BUDGET_UPDATE 事件 + Run 级 token 预算 + 429 归一化。"""

    def __init__(self, emitter: EventEmitter, budget: Budget) -> None:
        from minisweagent.models.litellm_model import LitellmModel

        settings = get_settings()
        self._inner = LitellmModel(
            model_name=f"openai/{settings.llm_model}",
            model_kwargs={
                "api_base": settings.llm_base_url or None,
                "api_key": settings.llm_api_key,
                "temperature": 0,
                "timeout": 120,
                "drop_params": True,
            },
            cost_tracking="ignore_errors",
            observation_template=OBSERVATION_TEMPLATE,
            format_error_template=FORMAT_ERROR_TEMPLATE,
        )
        self.config = self._inner.config
        self.emitter = emitter
        self.budget = budget
        # Run 级累计口径：本 attempt 之前已消耗的 token（重启后仍占预算）
        self.prior_tokens = max(0, budget.tokens - budget.remainingTokens)
        self.attempt_tokens = 0
        self.turn = 0
        self._started = time.time()

    @property
    def used_tokens_total(self) -> int:
        return self.prior_tokens + self.attempt_tokens

    def query(self, messages: list[dict], **kwargs) -> dict:
        maybe_inject_model_fault()
        start = time.monotonic()
        try:
            message = self._inner.query(messages, **kwargs)
        except Exception as exc:
            from minisweagent.exceptions import FormatError

            if isinstance(exc, FormatError):
                self.turn += 1
                raise
            if "429" in str(exc) or "rate limit" in str(exc).lower():
                raise ModelRateLimitError(str(exc)) from exc
            raise
        usage = (message.get("extra", {}).get("response") or {}).get("usage") or {}
        prompt_tokens = int(usage.get("prompt_tokens") or 0)
        completion_tokens = int(usage.get("completion_tokens") or 0)
        self.attempt_tokens += prompt_tokens + completion_tokens
        self.turn += 1
        self.emitter.emit("MODEL_CALL", {
            "model": self.config.model_name,
            "promptTokens": prompt_tokens,
            "completionTokens": completion_tokens,
            "latencyMs": int((time.monotonic() - start) * 1000),
            "turn": self.turn,
        })
        self.emitter.emit("BUDGET_UPDATE", {
            "usedTokens": self.used_tokens_total,
            "usedSeconds": int(time.time() - self._started),
            "usedTurns": self.turn,
        })
        if self.used_tokens_total > self.budget.tokens:
            raise BudgetExceeded("tokens", f"{self.used_tokens_total}/{self.budget.tokens}")
        return message

    # 其余协议方法直接代理内层 LitellmModel
    def format_message(self, **kwargs) -> dict:
        return self._inner.format_message(**kwargs)

    def format_observation_messages(self, message, outputs, template_vars=None) -> list[dict]:
        return self._inner.format_observation_messages(message, outputs, template_vars)

    def get_template_vars(self, **kwargs) -> dict[str, Any]:
        return self._inner.get_template_vars(**kwargs)

    def serialize(self) -> dict:
        return self._inner.serialize()


def build_task_text(command: RunCommand, feedback: str | None) -> str:
    spec = command.taskSpec
    parts = [
        spec.description,
        f"Package directory (default working dir for your commands): {spec.workdir}",
        f"Note: file paths in the task description are relative to the repository root; "
        f"your shell starts inside {spec.workdir}/, so strip that prefix when referencing "
        f"files from the description (e.g. src/..., tests/...).",
        f"Allowed paths (only modify files matching these): {spec.allowedPaths}",
        f"Static check that must pass: {spec.staticCheck}",
        f"Targeted tests that must go from FAIL to PASS: {spec.failToPass}",
        f"Regression tests that must keep passing: {spec.passToPass}",
    ]
    if feedback:
        parts.append(f"\nPrevious attempt feedback:\n{feedback}")
    return "\n".join(parts)


class MiniSWEAgentAdapter:
    def __init__(self, sandbox: Sandbox, emitter: EventEmitter, on_checkpoint: Any = None) -> None:
        self.sandbox = sandbox
        self.emitter = emitter
        self.on_checkpoint = on_checkpoint

    def capabilities(self) -> AgentCapabilities:
        return {"fineGrainedResume": False}

    def execute(
        self, command: RunCommand, resume: bool, feedback: str | None
    ) -> AdapterResult:
        from minisweagent.agents.default import DefaultAgent

        if resume:
            # 不应发生：runner 对 fineGrainedResume=False 的 adapter 传 resume=False
            logger.warning("MINI_SWE 不支持细粒度恢复，退化为全新执行")

        settings = get_settings()
        if settings.llm_provider == "fake":
            raise RuntimeError("MINI_SWE adapter 需要真实模型（LLM_PROVIDER=openai）")

        model = InstrumentedMiniModel(self.emitter, command.budget)
        env = SandboxEnvironment(
            self.sandbox, self.emitter, cwd=f"/workspace/{command.taskSpec.workdir}"
        )
        agent = DefaultAgent(
            model, env,
            system_template=SYSTEM_TEMPLATE,
            instance_template=INSTANCE_TEMPLATE,
            step_limit=command.budget.turns,
            cost_limit=0,  # 成本口径统一走 token 预算（InstrumentedMiniModel）
            wall_time_limit_seconds=command.budget.remainingSeconds,
        )
        started = time.time()
        result = agent.run(task=build_task_text(command, feedback))
        exit_status = result.get("exit_status", "")

        if self.on_checkpoint:
            # Attempt 级检查点：只记录用量与进度（不支持工具级重放）
            self.on_checkpoint(model.used_tokens_total, int(time.time() - started))

        if exit_status == "TimeExceeded":
            raise BudgetExceeded("seconds", f"wall_time>{command.budget.remainingSeconds}s")
        if exit_status == "LimitsExceeded":
            raise BudgetExceeded("turns", f"{model.turn}/{command.budget.turns}")
        if exit_status == "RepeatedFormatError":
            raise AgentStuck("mini-swe 连续输出非法工具调用（RepeatedFormatError）")
        # Submitted（或其他正常结束）：交给 runner 的 V1-V6 门禁定成败
        return AdapterResult(used_tokens=model.used_tokens_total)
