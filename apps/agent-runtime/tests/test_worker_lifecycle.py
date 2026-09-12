"""worker 生命周期：优雅停机信号语义 + XAUTOCLAIM pending 接管。"""

import signal

import pytest

from arp_runtime.runner import AttemptOutcome
from arp_runtime.worker import Worker
from test_recovery_sequence import FakeControlPlane, FakeRedis, _command_fields, _make_worker


@pytest.fixture()
def restore_signals():
    originals = {
        sig: signal.getsignal(sig) for sig in (signal.SIGTERM, signal.SIGINT)
    }
    yield
    for sig, handler in originals.items():
        signal.signal(sig, handler)


class TestGracefulShutdown:
    def test_first_signal_sets_stopped_flag(
        self, monkeypatch: pytest.MonkeyPatch, restore_signals: None
    ) -> None:
        worker, _, _ = _make_worker(monkeypatch, None)
        worker.install_signal_handlers()

        handler = signal.getsignal(signal.SIGTERM)
        handler(signal.SIGTERM, None)

        assert worker._stopped is True

    def test_second_signal_forces_exit(
        self, monkeypatch: pytest.MonkeyPatch, restore_signals: None
    ) -> None:
        worker, _, _ = _make_worker(monkeypatch, None)
        worker.install_signal_handlers()
        exited: list[int] = []
        monkeypatch.setattr("arp_runtime.worker.os._exit", lambda code: exited.append(code))

        handler = signal.getsignal(signal.SIGTERM)
        handler(signal.SIGTERM, None)
        handler(signal.SIGTERM, None)

        assert exited == [130]


class FakeRedisWithAutoclaim(FakeRedis):
    """扩展：pending 列表 + xautoclaim 最小实现。"""

    def __init__(self) -> None:
        super().__init__()
        self.pending: list[tuple[str, dict]] = []

    def xautoclaim(self, stream, group, consumer, min_idle_time, start_id="0", count=10):
        claimed = self.pending[:count]
        self.pending = self.pending[count:]
        return ("0-0", claimed)


def _make_reclaim_worker(monkeypatch: pytest.MonkeyPatch) -> tuple[Worker, FakeRedisWithAutoclaim, FakeControlPlane]:
    worker, _, cp = _make_worker(monkeypatch, None)
    worker.redis = FakeRedisWithAutoclaim()
    worker.settings.reclaim_min_idle_ms = 60_000
    worker.settings.reclaim_interval_s = 30
    return worker, worker.redis, cp


class TestReclaimPending:
    """XAUTOCLAIM 的两种结局都必须安全（配合 commandId 幂等）。"""

    def test_unconsumed_message_executed_by_reclaimer(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """死 consumer 读了消息但没来得及消费：接管者正常执行（快路径接管）。"""
        worker, fake_redis, cp = _make_reclaim_worker(monkeypatch)
        monkeypatch.setattr(
            worker, "execute",
            lambda command, attempt_id, emitter: AttemptOutcome(status="SUCCEEDED"),
        )
        fake_redis.pending = [("9-1", _command_fields("cmd-orphan"))]

        assert worker.reclaim_pending() == 1
        assert cp.claims, "接管者应认领 attempt 并执行"
        assert cp.completed[-1][1]["status"] == "SUCCEEDED"
        assert fake_redis.acked == ["9-1"]

    def test_already_consumed_message_acked_without_rerun(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """死 consumer 已消费但没 ACK（僵尸 PEL）：幂等判重，只 ACK 不重跑。"""
        worker, fake_redis, cp = _make_reclaim_worker(monkeypatch)
        fake_redis.kv["cmd:cmd-done"] = "dead-worker"  # 幂等键已存在
        fake_redis.pending = [("9-2", _command_fields("cmd-done"))]

        assert worker.reclaim_pending() == 1
        assert cp.claims == [], "不应重复认领"
        assert fake_redis.acked == ["9-2"], "僵尸消息应被 ACK 清理"

    def test_empty_pending_noop(self, monkeypatch: pytest.MonkeyPatch) -> None:
        worker, fake_redis, cp = _make_reclaim_worker(monkeypatch)
        assert worker.reclaim_pending() == 0
        assert fake_redis.acked == []
