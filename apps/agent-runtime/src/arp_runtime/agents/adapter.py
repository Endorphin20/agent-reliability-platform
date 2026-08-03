"""AgentAdapter 协议（T10）。

对照公平性（计划 IM-06）：
- capabilities().fineGrainedResume 声明恢复粒度；
- SELF_LANGGRAPH = True：从 LangGraph checkpoint 细粒度恢复（工具调用级）；
- MINI_SWE = False：RESUME 命令退化为 Attempt 级重启（recoveryMode=attempt-restart），
  失败反馈以文本形式注入新一轮任务提示。
评测页与实验报告按 recoveryMode 分组展示，不做跨粒度横比。
"""

from dataclasses import dataclass
from typing import Any, Protocol, TypedDict

from arp_runtime.schemas.run_command import RunCommand


class AgentCapabilities(TypedDict):
    fineGrainedResume: bool


@dataclass
class AdapterResult:
    """Agent 循环结束后的用量汇总（Verifier 门禁由 runner 统一执行）。"""

    used_tokens: int


class AgentAdapter(Protocol):
    def capabilities(self) -> AgentCapabilities: ...

    def execute(
        self, command: RunCommand, resume: bool, feedback: str | None
    ) -> AdapterResult: ...


class SelfLangGraphAdapter:
    """自研 LangGraph Agent 的 Adapter 包装（细粒度恢复：thread_id=runId 的图状态）。"""

    def __init__(
        self,
        toolset: Any,
        emitter: Any,
        model: Any,
        database_url: str,
        on_checkpoint: Any,
    ) -> None:
        self.toolset = toolset
        self.emitter = emitter
        self.model = model
        self.database_url = database_url
        self.on_checkpoint = on_checkpoint

    def capabilities(self) -> AgentCapabilities:
        return {"fineGrainedResume": True}

    def execute(
        self, command: RunCommand, resume: bool, feedback: str | None
    ) -> AdapterResult:
        from langgraph.checkpoint.postgres import PostgresSaver

        from arp_runtime.agents.self_agent.graph import SelfAgent

        with PostgresSaver.from_conn_string(self.database_url) as saver:
            saver.setup()  # 幂等建表
            agent = SelfAgent(
                command, self.toolset, self.emitter, self.model,
                checkpointer=saver, on_checkpoint=self.on_checkpoint,
            )
            final_state = agent.run(
                thread_id=command.runId, resume=resume, feedback=feedback
            )
        return AdapterResult(used_tokens=int(final_state.get("used_tokens", 0)))
