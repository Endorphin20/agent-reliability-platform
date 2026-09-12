"""Runtime Worker：消费 run-commands、认领 Attempt、心跳续租、执行、完结上报。

可靠性要点（§4.5）：
- commandId 幂等：SET cmd:{commandId} NX EX 3600，重复投递直接 ACK；
- 心跳线程按 HEARTBEAT_MS 续租（必须 < LEASE_TTL_MS / 2）；
- 失败按分类映射 FailureCode 上报，恢复决策全部在 Control Plane Policy Engine；
- 优雅停机：SIGTERM/SIGINT 后不再领新消息，跑完当前 attempt 退出（滚动升级用）；
- XAUTOCLAIM：周期接管死 consumer 的 pending 消息，配合 commandId 幂等，
  重复接管天然安全（已消费的直接 ACK 清理僵尸 PEL）。
"""

import json
import logging
import os
import signal
import threading
import time

import redis

from arp_runtime.agents.llm import ModelRateLimitError
from arp_runtime.agents.self_agent.graph import AgentStuck, BudgetExceeded
from arp_runtime.config import get_settings
from arp_runtime.control_plane import ControlPlaneClient
from arp_runtime.events import EventEmitter
from arp_runtime.executors.fake import run_fake_executor
from arp_runtime.runner import AttemptOutcome, RealExecutor
from arp_runtime.sandbox.provider import SandboxCrashed, SandboxError
from arp_runtime.schemas.run_command import RunCommand
from arp_runtime.tools.guard import CommandRejected

logger = logging.getLogger("arp.worker")

RUN_COMMANDS_STREAM = "run-commands"
RUN_COMMANDS_GROUP = "runtime"


class HeartbeatThread(threading.Thread):
    def __init__(self, client: ControlPlaneClient, attempt_id: str, interval_ms: int) -> None:
        super().__init__(daemon=True)
        self._client = client
        self._attempt_id = attempt_id
        self._interval_s = interval_ms / 1000
        self._stop = threading.Event()

    def run(self) -> None:
        while not self._stop.wait(self._interval_s):
            try:
                self._client.heartbeat(self._attempt_id)
            except Exception as exc:  # noqa: BLE001 心跳失败不应打断执行，租约过期由 Control Plane 判定
                logger.warning("心跳失败 attempt=%s: %s", self._attempt_id, exc)

    def stop(self) -> None:
        self._stop.set()


class Worker:
    def __init__(self) -> None:
        self.settings = get_settings()
        self.redis = redis.Redis.from_url(self.settings.redis_url, decode_responses=True)
        self.cp = ControlPlaneClient()
        self._real_executor: RealExecutor | None = None
        self._stopped = False
        self._last_reclaim = 0.0

    def ensure_group(self) -> None:
        try:
            self.redis.xgroup_create(RUN_COMMANDS_STREAM, RUN_COMMANDS_GROUP, id="0", mkstream=True)
        except redis.ResponseError as exc:
            if "BUSYGROUP" not in str(exc):
                raise

    def cleanup_orphan_sandboxes(self) -> None:
        """启动时清扫上次崩溃遗留的沙箱容器（MVP 单 worker 假设）。"""
        try:
            from arp_runtime.sandbox.provider import DockerSandboxProvider

            count = DockerSandboxProvider().cleanup_orphans()
            if count:
                logger.warning("已清理 %d 个孤儿沙箱容器", count)
        except Exception as exc:  # noqa: BLE001 Docker 不可用时只跑 fake 任务，不阻塞启动
            logger.warning("孤儿沙箱清扫跳过: %s", exc)

    def install_signal_handlers(self) -> None:
        """优雅停机：首次 SIGTERM/SIGINT 停止领新消息、跑完当前 attempt 再退出；
        再来一次强制退出（租约过期 + XAUTOCLAIM 兜底未完成的工作）。"""

        def handle(signum: int, _frame: object) -> None:
            if self._stopped:
                logger.warning("再次收到 %s，强制退出", signal.Signals(signum).name)
                os._exit(130)
            logger.warning(
                "收到 %s，优雅停机：跑完当前命令后退出（再发一次强制退出）",
                signal.Signals(signum).name,
            )
            self._stopped = True

        signal.signal(signal.SIGTERM, handle)
        signal.signal(signal.SIGINT, handle)

    def reclaim_pending(self) -> int:
        """XAUTOCLAIM 接管空闲超阈值的 pending 消息（死 consumer 遗留）。

        两种结局都安全：commandId 已被死 consumer 消费过 -> handle_entry 幂等
        判重直接 ACK（清理僵尸 PEL）；没消费过 -> 本 worker 正常执行（快路径
        接管，不必等控制面租约过期再发新命令）。返回接管的消息数。
        """
        result = self.redis.xautoclaim(
            RUN_COMMANDS_STREAM,
            RUN_COMMANDS_GROUP,
            self.settings.worker_id,
            min_idle_time=self.settings.reclaim_min_idle_ms,
            start_id="0",
            count=10,
        )
        # redis-py 返回 (next_start_id, messages) 或 (next, messages, deleted_ids)
        messages = result[1]
        for entry_id, fields in messages:
            logger.warning("XAUTOCLAIM 接管 pending 消息 %s", entry_id)
            try:
                self.handle_entry(entry_id, fields)
            except Exception:  # noqa: BLE001
                logger.exception("接管消息 %s 处理失败，留在 pending 重试", entry_id)
        return len(messages)

    def _maybe_reclaim(self) -> None:
        now = time.monotonic()
        if now - self._last_reclaim < self.settings.reclaim_interval_s:
            return
        self._last_reclaim = now
        try:
            self.reclaim_pending()
        except Exception:  # noqa: BLE001 接管失败不影响主消费循环
            logger.exception("XAUTOCLAIM 扫描失败")

    def run_forever(self) -> None:
        self.install_signal_handlers()
        self.cleanup_orphan_sandboxes()
        self.ensure_group()
        logger.info("worker %s 开始消费 %s", self.settings.worker_id, RUN_COMMANDS_STREAM)
        while not self._stopped:
            self._maybe_reclaim()
            entries = self.redis.xreadgroup(
                RUN_COMMANDS_GROUP,
                self.settings.worker_id,
                {RUN_COMMANDS_STREAM: ">"},
                count=1,
                block=2000,
            )
            if not entries:
                continue
            for _stream, messages in entries:
                for entry_id, fields in messages:
                    if self._stopped:
                        # 停机窗口内刚读到但未开始的消息：不处理不 ACK，
                        # 留在 PEL 由其他 worker XAUTOCLAIM 接管
                        logger.info("停机中，消息 %s 留给其他 worker 接管", entry_id)
                        continue
                    try:
                        self.handle_entry(entry_id, fields)
                    except Exception:  # noqa: BLE001
                        logger.exception("处理命令 %s 失败，留在 pending 重试", entry_id)
        logger.info("worker %s 已优雅退出", self.settings.worker_id)

    def handle_entry(self, entry_id: str, fields: dict[str, str]) -> None:
        command = RunCommand.model_validate(json.loads(fields["data"]))

        # commandId 幂等：重复消费直接 ACK
        if not self.redis.set(f"cmd:{command.commandId}", self.settings.worker_id, nx=True, ex=3600):
            logger.info("重复命令 %s，跳过", command.commandId)
            self.redis.xack(RUN_COMMANDS_STREAM, RUN_COMMANDS_GROUP, entry_id)
            return

        if command.type == "CANCEL_RUN":
            self.redis.xack(RUN_COMMANDS_STREAM, RUN_COMMANDS_GROUP, entry_id)
            return

        claim = self.cp.claim_attempt(command.runId, command.attemptNo, self.settings.worker_id)
        attempt_id = claim["attemptId"]
        logger.info(
            "认领 run=%s attempt#%d id=%s (duplicate=%s)",
            command.runId, command.attemptNo, attempt_id, claim.get("duplicate"),
        )

        heartbeat = HeartbeatThread(self.cp, attempt_id, self.settings.heartbeat_ms)
        heartbeat.start()
        emitter = EventEmitter(self.redis, command.runId, attempt_id, command.attemptNo)
        try:
            outcome = self.execute(command, attempt_id, emitter)
            self.cp.complete_attempt(attempt_id, {
                "status": outcome.status,
                **({"failureCode": outcome.failure_code} if outcome.failure_code else {}),
                "usedTokens": outcome.used_tokens,
                "usedSeconds": outcome.used_seconds,
                "verification": outcome.verification,
                **({"patch": outcome.patch} if outcome.patch else {}),
                **({"judge": outcome.judge} if outcome.judge else {}),
            })
            logger.info(
                "run=%s attempt#%d 完结: %s %s",
                command.runId, command.attemptNo, outcome.status, outcome.failure_code or "",
            )
        except Exception as exc:  # noqa: BLE001
            failure_code = classify_failure(exc)
            logger.exception("执行失败，上报 %s", failure_code)
            try:
                emitter.emit("FAILURE_DETECTED", {
                    "failureCode": failure_code, "message": str(exc)[:2000],
                })
            except Exception:  # noqa: BLE001
                logger.exception("FAILURE_DETECTED 事件发送失败")
            try:
                self.cp.complete_attempt(
                    attempt_id, {"status": "FAILED", "failureCode": failure_code}
                )
            except Exception:  # noqa: BLE001 上报失败时由租约过期兜底
                logger.exception("完结上报失败，等待租约过期兜底")
        finally:
            heartbeat.stop()
            self.redis.xack(RUN_COMMANDS_STREAM, RUN_COMMANDS_GROUP, entry_id)

    def execute(self, command: RunCommand, attempt_id: str, emitter: EventEmitter) -> AttemptOutcome:
        if command.taskSpec.fixtureId == "fake":
            run_fake_executor(command, emitter)
            return AttemptOutcome(status="SUCCEEDED")
        if self._real_executor is None:
            self._real_executor = RealExecutor(self.cp)
        return self._real_executor.execute(command, attempt_id, emitter)


def classify_failure(exc: Exception) -> str:
    """失败分类器（§4.6）：异常 -> FailureCode，恢复策略由 Policy Engine 决定。"""
    if isinstance(exc, BudgetExceeded):
        return {
            "tokens": "BUDGET_TOKENS_EXCEEDED",
            "seconds": "BUDGET_TIME_EXCEEDED",
            "turns": "BUDGET_TURNS_EXCEEDED",
        }[exc.kind]
    if isinstance(exc, AgentStuck):
        return "AGENT_STUCK"
    if isinstance(exc, ModelRateLimitError):
        return "MODEL_RATE_LIMIT"
    if isinstance(exc, SandboxCrashed):
        return "SANDBOX_CRASHED"
    if isinstance(exc, SandboxError):
        return "SANDBOX_START_FAILED"
    if isinstance(exc, CommandRejected):
        return "TOOL_EXEC_ERROR"
    module = type(exc).__module__ or ""
    text = str(exc).lower()
    if module.startswith("docker"):
        return "SANDBOX_CRASHED"
    if module.startswith("openai") or module.startswith("langchain"):
        if "429" in text or "rate limit" in text:
            return "MODEL_RATE_LIMIT"
        return "MODEL_API_ERROR"
    if "429" in text or "rate limit" in text:
        return "MODEL_RATE_LIMIT"
    return "TOOL_EXEC_ERROR"


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    Worker().run_forever()


if __name__ == "__main__":
    main()
