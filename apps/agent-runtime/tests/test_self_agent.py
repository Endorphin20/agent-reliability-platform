"""SelfAgent 图的单元测试：不依赖 Docker / Postgres / 真实模型。"""

from typing import Any

import pytest
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage

from arp_runtime.agents.self_agent.graph import (
    PRUNE_KEEP_LAST_TOOL_RESULTS,
    AgentStuck,
    BudgetExceeded,
    SelfAgent,
    prune_messages,
)
from arp_runtime.schemas.run_command import Budget, RepoRef, RunCommand, TaskSpec


class StubEmitter:
    def __init__(self) -> None:
        self.events: list[tuple[str, dict[str, Any]]] = []
        self.sequence = 0
        self.attempt_no = 1

    def emit(self, event_type: str, payload: dict[str, Any]) -> int:
        self.sequence += 1
        self.events.append((event_type, payload))
        return self.sequence


class StubToolset:
    def __init__(self) -> None:
        self.calls: list[str] = []

    def read_file(self, path: str, start_line: int | None = None,
                  end_line: int | None = None) -> str:
        self.calls.append(f"read_file:{path}")
        return "file content"

    def search_code(self, pattern: str, glob: str = "**/*") -> str:
        self.calls.append(f"search_code:{pattern}")
        return "[no matches]"

    def apply_patch(self, patch: str, tool_call_id: str | None = None) -> str:
        self.calls.append("apply_patch")
        return "[ok] 补丁已应用"

    def run_command(self, command: str) -> str:
        self.calls.append(f"run_command:{command}")
        return "exit=0\nall tests passed"


class ScriptedModel:
    """按脚本返回消息，脚本耗尽后重复最后一条。"""

    model = "scripted"

    def __init__(self, script: list[AIMessage]) -> None:
        self.script = script
        self.n = 0

    def invoke(self, messages: list[Any]) -> AIMessage:
        message = self.script[min(self.n, len(self.script) - 1)]
        self.n += 1
        return message


def make_command(turns: int = 30, tokens: int = 100_000) -> RunCommand:
    return RunCommand(
        commandId="cmd:test:START_RUN:1",
        type="START_RUN",
        runId="run-test",
        attemptNo=1,
        agentKind="SELF_LANGGRAPH",
        repo=RepoRef(path="/tmp/repo", baseCommit="HEAD"),
        taskSpec=TaskSpec(
            fixtureId="ts-logic-001",
            description="修复缺陷",
            workdir="packages/ts-logic-001",
            allowedPaths=["packages/ts-logic-001/src/**"],
            staticCheck=["npm run typecheck"],
            failToPass=["npm run test:target"],
            passToPass=["npm test"],
        ),
        budget=Budget(
            tokens=tokens, seconds=900, turns=turns,
            remainingTokens=tokens, remainingSeconds=900,
        ),
    )


def usage(n: int = 100) -> dict[str, int]:
    return {"input_tokens": n, "output_tokens": 10, "total_tokens": n + 10}


def tool_msg(name: str, args: dict[str, Any], call_id: str) -> AIMessage:
    return AIMessage(
        content="", usage_metadata=usage(),
        tool_calls=[{"name": name, "args": args, "id": call_id}],
    )


def build_agent(script: list[AIMessage], **command_kwargs: Any) -> tuple[SelfAgent, StubToolset, StubEmitter]:
    toolset, emitter = StubToolset(), StubEmitter()
    agent = SelfAgent(
        make_command(**command_kwargs), toolset, emitter, ScriptedModel(script)
    )
    return agent, toolset, emitter


def test_happy_path_emits_model_and_budget_events() -> None:
    script = [
        tool_msg("read_file", {"path": "src/a.ts"}, "c1"),
        tool_msg("apply_patch", {"patch": "diff"}, "c2"),
        tool_msg("run_command", {"command": "npm run test:target"}, "c3"),
        AIMessage(content="FINISH", usage_metadata=usage()),
    ]
    agent, toolset, emitter = build_agent(script)
    state = agent.run(thread_id="t1")

    assert state["done"] is True
    assert toolset.calls == [
        "read_file:src/a.ts", "apply_patch", "run_command:npm run test:target",
    ]
    types = [t for t, _ in emitter.events]
    assert types.count("MODEL_CALL") == 4
    assert types.count("BUDGET_UPDATE") == 4
    assert state["used_tokens"] == 4 * 110


def test_stuck_detection_raises_after_repeated_identical_calls() -> None:
    # 参数相同但消息/调用 id 各不相同（LangGraph 按消息 id 去重，真实模型每次 id 都新）
    script = [
        tool_msg("read_file", {"path": "src/a.ts"}, f"loop-{i}") for i in range(4)
    ]
    agent, _, _ = build_agent(script)
    with pytest.raises(AgentStuck):
        agent.run(thread_id="t2")


def test_turn_budget_exceeded() -> None:
    # 每轮换不同参数避免触发卡死检测
    script = [
        tool_msg("read_file", {"path": f"src/{i}.ts"}, f"c{i}") for i in range(10)
    ]
    agent, _, _ = build_agent(script, turns=3)
    with pytest.raises(BudgetExceeded) as excinfo:
        agent.run(thread_id="t3")
    assert excinfo.value.kind == "turns"


def test_token_budget_exceeded() -> None:
    script = [
        tool_msg("read_file", {"path": f"src/{i}.ts"}, f"c{i}") for i in range(10)
    ]
    agent, _, _ = build_agent(script, tokens=250)  # 第三次调用累计 330 > 250
    with pytest.raises(BudgetExceeded) as excinfo:
        agent.run(thread_id="t4")
    assert excinfo.value.kind == "tokens"


def test_prune_messages_folds_old_large_tool_results() -> None:
    """仅最近 K 条工具结果保留全文，更早的大结果替换为占位摘要，
    且不改动原消息列表（checkpoint 完整性；failure-analysis RC2）。"""
    big = "x" * 5_000
    messages: list[Any] = [SystemMessage(content="sys"), HumanMessage(content="task")]
    total = PRUNE_KEEP_LAST_TOOL_RESULTS + 3
    for i in range(total):
        messages.append(tool_msg("read_file", {"path": f"f{i}"}, f"c{i}"))
        messages.append(ToolMessage(content=big, tool_call_id=f"c{i}"))

    pruned = prune_messages(messages)

    folded = [m for m in pruned
              if isinstance(m, ToolMessage) and "[已折叠]" in str(m.content)]
    intact = [m for m in pruned
              if isinstance(m, ToolMessage) and str(m.content) == big]
    assert len(folded) == 3
    assert len(intact) == PRUNE_KEEP_LAST_TOOL_RESULTS
    # 折叠的是最早的，保留 tool_call_id 配对（OpenAI 协议要求逐一应答）
    assert folded[0].tool_call_id == "c0"
    # 原列表未被修改
    assert all(str(m.content) == big for m in messages if isinstance(m, ToolMessage))


def test_prune_messages_keeps_small_results() -> None:
    messages: list[Any] = [SystemMessage(content="sys")]
    for i in range(PRUNE_KEEP_LAST_TOOL_RESULTS + 5):
        messages.append(tool_msg("run_command", {"command": f"ls {i}"}, f"c{i}"))
        messages.append(ToolMessage(content="exit=0", tool_call_id=f"c{i}"))
    pruned = prune_messages(messages)
    assert all("[已折叠]" not in str(m.content) for m in pruned)


def test_tool_error_fed_back_to_model_not_raised() -> None:
    class ExplodingToolset(StubToolset):
        def apply_patch(self, patch: str, tool_call_id: str | None = None) -> str:
            raise RuntimeError("补丁不可应用")

    script = [
        tool_msg("apply_patch", {"patch": "bad"}, "c1"),
        AIMessage(content="FINISH", usage_metadata=usage()),
    ]
    toolset, emitter = ExplodingToolset(), StubEmitter()
    agent = SelfAgent(make_command(), toolset, emitter, ScriptedModel(script))
    state = agent.run(thread_id="t5")  # 不应抛异常
    assert state["done"] is True
    tool_feedback = [
        m for m in state["messages"] if m.type == "tool" and "[error]" in str(m.content)
    ]
    assert tool_feedback, "工具失败应以 [error] 反馈给模型"
