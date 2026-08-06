"""恢复时序集成测试：sandbox crash -> 失败分类上报 -> checkpoint 重建 -> 幂等缓存重放。

这条链路此前只靠 e2e.sh 手工验收。这里在进程内把各环节用真实实现串起来，
只在边界（redis / control-plane HTTP / docker）打桩，跑进 CI。
"""

import json
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest

from arp_runtime.agents.llm import ModelRateLimitError
from arp_runtime.agents.self_agent.graph import AgentStuck, BudgetExceeded
from arp_runtime.runner import _build_feedback, _restore_from_checkpoint
from arp_runtime.sandbox.provider import SandboxCrashed, SandboxError
from arp_runtime.tools.guard import CommandRejected
from arp_runtime.tools.toolset import Toolset
from arp_runtime.worker import Worker, classify_failure


class TestClassifyFailure:
    """异常 -> FailureCode 的映射是 Policy Engine 决策的输入，映射错了恢复策略就错了。"""

    @pytest.mark.parametrize(
        ("exc", "expected"),
        [
            (SandboxCrashed("容器消亡"), "SANDBOX_CRASHED"),
            (SandboxError("启动失败"), "SANDBOX_START_FAILED"),
            (BudgetExceeded("tokens", "烧满"), "BUDGET_TOKENS_EXCEEDED"),
            (BudgetExceeded("seconds", "超时"), "BUDGET_TIME_EXCEEDED"),
            (BudgetExceeded("turns", "轮次"), "BUDGET_TURNS_EXCEEDED"),
            (AgentStuck("循环"), "AGENT_STUCK"),
            (ModelRateLimitError("429"), "MODEL_RATE_LIMIT"),
            (CommandRejected("curl x", "denylist"), "TOOL_EXEC_ERROR"),
            (RuntimeError("rate limit exceeded"), "MODEL_RATE_LIMIT"),
            (RuntimeError("其他"), "TOOL_EXEC_ERROR"),
        ],
    )
    def test_mapping(self, exc: Exception, expected: str) -> None:
        assert classify_failure(exc) == expected


class FakeRedis:
    """只实现 worker/emitter 用到的最小子集。"""

    def __init__(self) -> None:
        self.streams: dict[str, list[dict]] = {}
        self.acked: list[str] = []
        self.kv: dict[str, str] = {}

    def set(self, key, value, nx=False, ex=None):
        if nx and key in self.kv:
            return None
        self.kv[key] = value
        return True

    def xadd(self, stream, fields):
        self.streams.setdefault(stream, []).append(fields)
        return b"1-1"

    def xack(self, stream, group, entry_id):
        self.acked.append(entry_id)
        return 1

    def events(self, stream: str = "trace-events") -> list[dict]:
        return [json.loads(f["data"]) for f in self.streams.get(stream, [])]


class FakeControlPlane:
    def __init__(self) -> None:
        self.completed: list[tuple[str, dict]] = []
        self.claims: list[tuple[str, int, str]] = []
        self.heartbeats: list[str] = []

    def claim_attempt(self, run_id, attempt_no, worker_id):
        self.claims.append((run_id, attempt_no, worker_id))
        return {"attemptId": f"att-{attempt_no}", "duplicate": False}

    def complete_attempt(self, attempt_id, payload):
        self.completed.append((attempt_id, payload))

    def heartbeat(self, attempt_id):
        self.heartbeats.append(attempt_id)


def _command_fields(command_id: str = "cmd-1") -> dict[str, str]:
    return {
        "data": json.dumps({
            "commandId": command_id,
            "type": "START_RUN",
            "runId": "run-x",
            "attemptNo": 1,
            "agentKind": "SELF_LANGGRAPH",
            "repo": {"path": "/tmp/repo", "baseCommit": "HEAD"},
            "taskSpec": {
                "fixtureId": "py-x", "description": "d", "workdir": "packages/py-x",
                "allowedPaths": ["packages/py-x/src/**"], "staticCheck": [],
                "failToPass": ["pytest"], "passToPass": [],
            },
            "budget": {
                "tokens": 1000, "seconds": 60, "turns": 5,
                "remainingTokens": 1000, "remainingSeconds": 60,
            },
        })
    }


def _make_worker(monkeypatch: pytest.MonkeyPatch, crash: Exception | None) -> tuple[Worker, FakeRedis, FakeControlPlane]:
    worker = object.__new__(Worker)
    worker.settings = SimpleNamespace(worker_id="w-test", heartbeat_ms=60_000)
    worker.redis = FakeRedis()
    worker.cp = FakeControlPlane()
    worker._real_executor = None
    worker._stopped = False
    if crash is not None:
        def boom(command, attempt_id, emitter):
            raise crash
        monkeypatch.setattr(worker, "execute", boom)
    return worker, worker.redis, worker.cp


class TestWorkerCrashReporting:
    """沙箱中途死亡：worker 必须上报 SANDBOX_CRASHED 并发 FAILURE_DETECTED，
    而不是把死沙箱当普通工具失败喂回模型。"""

    def test_sandbox_crash_reported_and_acked(self, monkeypatch: pytest.MonkeyPatch) -> None:
        worker, fake_redis, cp = _make_worker(monkeypatch, SandboxCrashed("容器被杀"))

        worker.handle_entry("1-1", _command_fields())

        attempt_id, payload = cp.completed[-1]
        assert attempt_id == "att-1"
        assert payload["status"] == "FAILED"
        assert payload["failureCode"] == "SANDBOX_CRASHED"

        failure_events = [e for e in fake_redis.events() if e["type"] == "FAILURE_DETECTED"]
        assert len(failure_events) == 1
        assert failure_events[0]["payload"]["failureCode"] == "SANDBOX_CRASHED"
        # 无论成败消息都必须 ACK，重试由控制面重新投递而非 pending 堆积
        assert fake_redis.acked == ["1-1"]

    def test_duplicate_command_skipped(self, monkeypatch: pytest.MonkeyPatch) -> None:
        worker, fake_redis, cp = _make_worker(monkeypatch, None)
        fake_redis.kv["cmd:cmd-1"] = "other-worker"  # 已被消费过

        worker.handle_entry("1-2", _command_fields("cmd-1"))

        assert cp.claims == []  # 幂等：不重复认领
        assert fake_redis.acked == ["1-2"]


def _init_repo(path: Path) -> str:
    subprocess.run(["git", "init", "-q"], cwd=path, check=True)
    subprocess.run(["git", "config", "user.email", "t@t"], cwd=path, check=True)
    subprocess.run(["git", "config", "user.name", "t"], cwd=path, check=True)
    (path / "app.py").write_text("def add(a, b):\n    return a - b\n")
    subprocess.run(["git", "add", "-A"], cwd=path, check=True)
    subprocess.run(["git", "commit", "-qm", "init"], cwd=path, check=True)
    return subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=path, check=True,
        capture_output=True, text=True,
    ).stdout.strip()


class TestCheckpointRestore:
    """RESUME 的第一步：把 checkpoint 里的累计补丁重放到新沙箱工作区。"""

    def test_applied_patch_replayed(self, tmp_path: Path) -> None:
        base = _init_repo(tmp_path)
        # 模拟第一次 attempt 的修改并抓 diff 作为 checkpoint 补丁
        (tmp_path / "app.py").write_text("def add(a, b):\n    return a + b\n")
        patch = subprocess.run(
            ["git", "diff", base], cwd=tmp_path, check=True,
            capture_output=True, text=True,
        ).stdout
        subprocess.run(["git", "checkout", "--", "."], cwd=tmp_path, check=True)
        assert "a - b" in (tmp_path / "app.py").read_text()

        sandbox = SimpleNamespace(workdir=tmp_path)
        _restore_from_checkpoint(sandbox, {"id": "cp-1", "appliedPatch": patch})
        assert "a + b" in (tmp_path / "app.py").read_text()

    def test_empty_patch_noop(self, tmp_path: Path) -> None:
        _init_repo(tmp_path)
        sandbox = SimpleNamespace(workdir=tmp_path)
        _restore_from_checkpoint(sandbox, {"id": "cp-1", "appliedPatch": None})


class StubEmitter:
    def __init__(self) -> None:
        self.events: list[tuple[str, dict]] = []
        self.sequence = 0
        self.attempt_no = 2  # 恢复后的 attempt

    def emit(self, event_type: str, payload: dict) -> int:
        self.sequence += 1
        self.events.append((event_type, payload))
        return self.sequence


class TestIdempotentReplay:
    """RESUME 的第二步：命中 completedToolCalls 的副作用（apply_patch）
    必须跳过执行并打 cached=true——这是"从断点继续而非从零重跑"的机制本体。"""

    PATCH = (
        "diff --git a/app.py b/app.py\n"
        "--- a/app.py\n"
        "+++ b/app.py\n"
        "@@ -1,2 +1,2 @@\n"
        " def add(a, b):\n"
        "-    return a - b\n"
        "+    return a + b\n"
    )

    def test_completed_patch_not_reapplied(self, tmp_path: Path) -> None:
        _init_repo(tmp_path)
        sandbox = SimpleNamespace(workdir=tmp_path, run_id="run-x")

        # attempt 1：正常应用补丁（LangGraph 的 tool_call_id 跨 attempt 稳定）
        first = Toolset(sandbox, StubEmitter())
        first.apply_patch(self.PATCH, tool_call_id="lg-call-7")
        assert "a + b" in (tmp_path / "app.py").read_text()

        # 崩溃恢复：工作区已由 checkpoint 重建，completedToolCalls 载入新 Toolset
        emitter = StubEmitter()
        resumed = Toolset(sandbox, emitter, completed_tool_calls=dict(first.completed))
        result = resumed.apply_patch(self.PATCH, tool_call_id="lg-call-7")

        assert result.startswith("[cached]")
        tool_calls = [p for t, p in emitter.events if t == "TOOL_CALL"]
        assert tool_calls[-1]["cached"] is True
        assert tool_calls[-1]["durationMs"] == 0

    def test_new_calls_still_execute_after_resume(self, tmp_path: Path) -> None:
        _init_repo(tmp_path)
        sandbox = SimpleNamespace(workdir=tmp_path, run_id="run-x")
        emitter = StubEmitter()
        resumed = Toolset(sandbox, emitter, completed_tool_calls={"lg-call-7": "sha256:x"})

        out = resumed.read_file("app.py")
        assert "a - b" in out
        assert [p["cached"] for t, p in emitter.events if t == "TOOL_CALL"] == [False]


class TestFeedbackModes:
    """恢复注入的失败反馈：结构化 vs 原始输出（实验三的两种模式）。"""

    CHECKPOINT = {
        "lastFailure": {
            "failureCode": "VERIFY_FAIL_TO_PASS",
            "verification": {"step": "V4", "detail": "1 failed: test_add"},
        },
    }

    def test_structured_feedback_names_failure_code_and_step(self) -> None:
        text = _build_feedback(dict(self.CHECKPOINT), fine_grained=True)
        assert "VERIFY_FAIL_TO_PASS" in text
        assert "V4" in text
        assert "之前应用的补丁已保留" in text

    def test_raw_feedback_omits_classification(self) -> None:
        checkpoint = dict(self.CHECKPOINT, feedbackMode="raw")
        text = _build_feedback(checkpoint, fine_grained=False)
        assert "VERIFY_FAIL_TO_PASS" not in text
        assert "1 failed: test_add" in text
        assert "工作区已重置" in text

    def test_no_failure_no_feedback(self) -> None:
        assert _build_feedback({}, fine_grained=True) is None
