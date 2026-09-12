"""LLM 摘要 condenser（CONTEXT_MODE=condense）：缓存、降级、预算口径。"""

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage

from arp_runtime.agents.condenser import Condenser
from arp_runtime.agents.llm import FakeCondenserModel
from arp_runtime.agents.self_agent.graph import PRUNE_MIN_CHARS, prune_messages


class CountingModel(FakeCondenserModel):
    def __init__(self) -> None:
        self.calls = 0

    def invoke(self, messages):
        self.calls += 1
        return super().invoke(messages)


class BrokenModel:
    model = "broken"

    def invoke(self, messages):
        raise RuntimeError("condenser 挂了")


class RecordingEmitter:
    def __init__(self) -> None:
        self.events: list[tuple[str, dict]] = []

    def emit(self, type_: str, payload: dict) -> None:
        self.events.append((type_, payload))


class TestCondenser:
    def test_summarizes_and_counts_tokens(self) -> None:
        emitter = RecordingEmitter()
        condenser = Condenser(CountingModel(), emitter)

        summary = condenser("call-1", "x" * 5000)

        assert "已压缩摘要" in summary and "5000 字符" in summary
        assert condenser.take_new_tokens() == 60  # fake: 50 prompt + 10 completion
        assert condenser.take_new_tokens() == 0, "结算后应清零"
        types = [t for t, _ in emitter.events]
        assert types == ["MODEL_CALL"]
        assert emitter.events[0][1]["model"].endswith("(condenser)")

    def test_cache_by_key_invokes_model_once(self) -> None:
        model = CountingModel()
        condenser = Condenser(model)

        first = condenser("call-1", "内容 A" * 1000)
        second = condenser("call-1", "内容 A" * 1000)

        assert first == second
        assert model.calls == 1, "同一 tool_call_id 只摘要一次"

    def test_failure_degrades_to_fold_placeholder(self) -> None:
        condenser = Condenser(BrokenModel())

        summary = condenser("call-1", "y" * 3000)

        assert "已折叠" in summary and "3000 字符" in summary
        assert condenser.take_new_tokens() == 0

    def test_long_input_clipped_head_and_tail(self) -> None:
        captured: list[str] = []

        class CapturingModel(FakeCondenserModel):
            def invoke(self, messages):
                captured.append(str(messages[-1].content))
                return super().invoke(messages)

        condenser = Condenser(CapturingModel())
        content = "H" * 20_000 + "T" * 20_000
        condenser("call-1", content)

        assert len(captured[0]) < len(content)
        assert captured[0].startswith("H") and captured[0].endswith("T"), \
            "应保留头部（签名/路径）与尾部（报错通常在尾部）"


class TestPruneWithCondense:
    def _history(self, n_tools: int) -> list:
        messages = [SystemMessage(content="sys"), HumanMessage(content="task")]
        for i in range(n_tools):
            messages.append(AIMessage(content="", tool_calls=[
                {"name": "read_file", "args": {"path": "a.py"}, "id": f"call-{i}"}
            ]))
            messages.append(ToolMessage(
                content=f"结果{i}:" + "z" * (PRUNE_MIN_CHARS + 100),
                tool_call_id=f"call-{i}",
            ))
        return messages

    def test_old_results_condensed_recent_kept(self) -> None:
        condenser = Condenser(FakeCondenserModel())
        messages = self._history(10)  # 10 条工具结果，保留最近 8 条

        pruned = prune_messages(messages, condenser)

        tool_messages = [m for m in pruned if isinstance(m, ToolMessage)]
        condensed = [m for m in tool_messages if "已压缩摘要" in str(m.content)]
        assert len(condensed) == 2, "最早 2 条应被摘要"
        assert all("结果" in str(m.content) for m in tool_messages[2:]), "近期结果保留全文"

    def test_without_condenser_falls_back_to_fold(self) -> None:
        pruned = prune_messages(self._history(10), None)
        tool_messages = [m for m in pruned if isinstance(m, ToolMessage)]
        assert sum("已折叠" in str(m.content) for m in tool_messages) == 2
