"""Toolset 单元测试（无需 docker）：read_file 行窗口与失败调用事件。

背景见 docs/failure-analysis.md：
- RC2：read_file 全文回读大文件导致上下文膨胀 → 行窗口 + 行号输出；
- RC3：工具执行失败不产出 TOOL_CALL 事件 → 失败也发事件（带 error 字段）。
"""

from pathlib import Path

import pytest

from arp_runtime.tools.toolset import Toolset, ToolExecutionError


class StubEmitter:
    def __init__(self) -> None:
        self.events: list[tuple[str, dict]] = []
        self.attempt_no = 1
        self.sequence = 0

    def emit(self, event_type: str, payload: dict) -> int:
        self.sequence += 1
        self.events.append((event_type, payload))
        return self.sequence


class StubSandbox:
    def __init__(self, workdir: Path) -> None:
        self.workdir = workdir
        self.run_id = "run-test"


@pytest.fixture()
def toolset(tmp_path: Path) -> Toolset:
    (tmp_path / "big.py").write_text(
        "\n".join(f"line {i}" for i in range(1, 501))
    )
    (tmp_path / "small.py").write_text("a = 1\nb = 2\n")
    return Toolset(StubSandbox(tmp_path), StubEmitter())


class TestReadFileWindow:
    def test_small_file_returned_whole_with_line_numbers(self, toolset: Toolset):
        out = toolset.read_file("small.py")
        assert "1|a = 1" in out
        assert "2|b = 2" in out
        assert "[small.py" not in out  # 完整返回时不加截断头

    def test_large_file_truncated_to_default_window(self, toolset: Toolset):
        out = toolset.read_file("big.py")
        assert "共 500 行，显示 1-200" in out
        assert "line 200" in out
        assert "line 201" not in out

    def test_line_range(self, toolset: Toolset):
        out = toolset.read_file("big.py", start_line=300, end_line=302)
        assert "共 500 行，显示 300-302" in out
        assert "300|line 300" in out
        assert "302|line 302" in out
        assert "line 303" not in out

    def test_start_line_only_uses_default_window(self, toolset: Toolset):
        out = toolset.read_file("big.py", start_line=450)
        assert "显示 450-500" in out

    def test_range_recorded_in_tool_call_args(self, toolset: Toolset):
        toolset.read_file("big.py", start_line=1, end_line=5)
        _, payload = toolset.emitter.events[-1]
        assert payload["args"] == {"path": "big.py", "start_line": 1, "end_line": 5}


class TestFailedToolCallEvent:
    def test_rejected_command_emits_tool_call_with_error(self, toolset: Toolset):
        with pytest.raises(ToolExecutionError):
            toolset.run_command("make build")
        events = [(t, p) for t, p in toolset.emitter.events if t == "TOOL_CALL"]
        assert len(events) == 1
        _, payload = events[0]
        assert payload["cached"] is False
        assert "不在白名单" in payload["error"]

    def test_success_has_no_error_field(self, toolset: Toolset):
        toolset.read_file("small.py")
        _, payload = toolset.emitter.events[-1]
        assert "error" not in payload
