"""模型接入层。

- provider=openai：ChatOpenAI（兼容 GLM 等 OpenAI 协议端点，配置见 .env）。
- provider=fake：确定性脚本模型（CI / e2e / 无 key 环境），按固定策略
  diagnose(read_file) -> edit(apply_patch 金标) -> test(run_command) -> finish，
  金标补丁由宿主侧 runner 注入（沙箱内 Agent 无法读 solutions/）。
- FAULT_INJECT=model-429：第 3 次模型调用抛一次 429（限流恢复演示）。
"""

import re
from typing import Any

from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AIMessage, BaseMessage

from arp_runtime.config import get_settings


class ModelRateLimitError(Exception):
    """映射到 MODEL_RATE_LIMIT 失败码。"""


_fault_calls = 0
_fault_fired = False


def maybe_inject_model_fault() -> None:
    global _fault_calls, _fault_fired
    settings = get_settings()
    if settings.fault_inject != "model-429" or _fault_fired:
        return
    _fault_calls += 1
    if _fault_calls >= 3:
        _fault_fired = True
        raise ModelRateLimitError("injected 429: rate limit exceeded (FAULT_INJECT=model-429)")


def reset_fault_injection_for_test() -> None:
    global _fault_calls, _fault_fired
    _fault_calls = 0
    _fault_fired = False


class FakeScriptedModel:
    """脚本化假模型：接口对齐『输入 messages -> 输出带 tool_calls 的 AIMessage』。

    步数由消息历史推导（而非实例计数器），因此进程崩溃后从 LangGraph
    checkpoint 恢复时能接着上次的进度继续。
    """

    model = "fake-scripted"

    def __init__(self, gold_patch: str, fail_to_pass: list[str]) -> None:
        self.gold_patch = gold_patch
        self.fail_to_pass = fail_to_pass
        match = re.search(r"^\+\+\+ b/(\S+)", gold_patch, re.MULTILINE)
        self.target_file = match.group(1) if match else "README.md"

    def invoke(self, messages: list[BaseMessage]) -> AIMessage:
        maybe_inject_model_fault()
        step = sum(1 for m in messages if isinstance(m, AIMessage)) + 1
        usage = {"input_tokens": 200, "output_tokens": 40, "total_tokens": 240}
        if step == 1:
            return AIMessage(
                content="diagnose：先读缺陷文件确认现状",
                tool_calls=[{
                    "name": "read_file",
                    "args": {"path": self.target_file},
                    "id": f"fake-step-{step}",
                }],
                usage_metadata=usage,
            )
        if step == 2:
            return AIMessage(
                content="plan：按边界条件修复；edit：应用补丁",
                tool_calls=[{
                    "name": "apply_patch",
                    "args": {"patch": self.gold_patch},
                    "id": f"fake-step-{step}",
                }],
                usage_metadata=usage,
            )
        if step == 3 and self.fail_to_pass:
            return AIMessage(
                content="test：运行定向测试验证修复",
                tool_calls=[{
                    "name": "run_command",
                    "args": {"command": self.fail_to_pass[0]},
                    "id": f"fake-step-{step}",
                }],
                usage_metadata=usage,
            )
        return AIMessage(content="修复完成，测试通过。FINISH", usage_metadata=usage)


class OpenAICompatibleModel:
    """真实模型包装：429 归一化为 MODEL_RATE_LIMIT，重试交给平台 Policy Engine。"""

    def __init__(self, tools: list[dict[str, Any]]) -> None:
        from langchain_openai import ChatOpenAI

        settings = get_settings()
        self.model = settings.llm_model
        base: BaseChatModel = ChatOpenAI(
            model=settings.llm_model,
            api_key=settings.llm_api_key or "missing-key",
            base_url=settings.llm_base_url or None,
            temperature=0,
            timeout=120,
            max_retries=0,
        )
        self._bound = base.bind_tools(tools)

    def invoke(self, messages: list[BaseMessage]) -> AIMessage:
        maybe_inject_model_fault()
        try:
            return self._bound.invoke(messages)  # type: ignore[return-value]
        except Exception as exc:  # noqa: BLE001
            if "429" in str(exc) or "rate limit" in str(exc).lower():
                raise ModelRateLimitError(str(exc)) from exc
            raise


def build_model(gold_patch: str, fail_to_pass: list[str]) -> Any:
    settings = get_settings()
    if settings.llm_provider == "fake":
        return FakeScriptedModel(gold_patch, fail_to_pass)
    return OpenAICompatibleModel(tool_specs())


def tool_specs() -> list[dict[str, Any]]:
    """OpenAI function-calling 工具描述（bind_tools 输入）。"""
    def spec(name: str, description: str, properties: dict[str, Any], required: list[str]) -> dict:
        return {
            "type": "function",
            "function": {
                "name": name,
                "description": description,
                "parameters": {"type": "object", "properties": properties, "required": required},
            },
        }

    return [
        spec("read_file", "读取仓库内文件内容（相对仓库根路径）",
             {"path": {"type": "string"}}, ["path"]),
        spec("search_code", "在仓库内按正则搜索代码，返回 文件:行号:内容",
             {"pattern": {"type": "string"}, "glob": {"type": "string"}}, ["pattern"]),
        spec("apply_patch", "应用 unified diff 补丁到仓库（git apply）",
             {"patch": {"type": "string"}}, ["patch"]),
        spec("run_command",
             "在沙箱内执行白名单命令（pnpm/npm/node/python/pytest/git status 等），工作目录为仓库根",
             {"command": {"type": "string"}}, ["command"]),
    ]


def usage_tokens(message: AIMessage) -> tuple[int, int]:
    meta = message.usage_metadata or {}
    return int(meta.get("input_tokens", 0)), int(meta.get("output_tokens", 0))
