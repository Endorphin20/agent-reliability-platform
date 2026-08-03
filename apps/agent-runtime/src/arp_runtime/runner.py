"""真实 fixture 执行器：沙箱 + LangGraph Agent + 六步 Verifier（T6/T7/T8 汇合点）。

一次 attempt 的完整流程：
1. DockerSandboxProvider 检出 base_ref 并启动隔离容器；
2. RESUME_RUN：拉取平台 Checkpoint，git apply 累计补丁重建沙箱状态，
   Toolset 载入 completedToolCalls（副作用幂等），并给 Agent 注入失败反馈；
3. LangGraph 以 thread_id=runId 执行（图状态由 PostgresSaver 持久化，
   与平台 Checkpoint 构成双层检查点）；每轮工具执行后落一次平台 Checkpoint；
4. Agent FINISH 后执行 V1..V6 Verifier；全过 -> SUCCEEDED + PATCH 工件，
   任一步失败 -> FAILED(VERIFY_*)，恢复决策交给 Control Plane Policy Engine。
"""

import hashlib
import logging
import subprocess
import time
from dataclasses import dataclass, field
from typing import Any

from arp_runtime.agents.adapter import AgentAdapter, SelfLangGraphAdapter
from arp_runtime.agents.llm import build_model
from arp_runtime.agents.mini_swe import MiniSWEAgentAdapter
from arp_runtime.config import get_settings
from arp_runtime.control_plane import ControlPlaneClient
from arp_runtime.events import EventEmitter
from arp_runtime.sandbox.provider import DockerSandboxProvider, Sandbox
from arp_runtime.schemas.run_command import RunCommand
from arp_runtime.tools.toolset import Toolset
from arp_runtime.verifier.pipeline import VerifierPipeline, VerifyReport

logger = logging.getLogger("arp.runner")


@dataclass
class AttemptOutcome:
    """complete_attempt 上报的载荷（worker 组装 HTTP body）。"""

    status: str  # SUCCEEDED | FAILED
    failure_code: str | None = None
    used_tokens: int = 0
    used_seconds: int = 0
    verification: list[dict[str, Any]] = field(default_factory=list)
    patch: str | None = None
    judge: dict[str, Any] | None = None


def _read_gold_patch(fixture_id: str) -> str:
    """fake 模型的剧本补丁，从宿主侧 fixture 仓库读取（沙箱内不可见 solutions/）。"""
    from pathlib import Path

    settings = get_settings()
    path = Path(settings.fixture_repo_path).expanduser() / "solutions" / f"{fixture_id}.patch"
    return path.read_text() if path.is_file() else ""


def _current_diff(sandbox: Sandbox, base_commit: str) -> str:
    result = subprocess.run(
        ["git", "diff", base_commit],
        cwd=sandbox.workdir, capture_output=True, text=True, timeout=60,
    )
    return result.stdout if result.returncode == 0 else ""


def _restore_from_checkpoint(sandbox: Sandbox, checkpoint: dict[str, Any]) -> None:
    patch = checkpoint.get("appliedPatch")
    if not patch or not patch.strip():
        return
    subprocess.run(
        ["git", "apply", "-"],
        cwd=sandbox.workdir, input=patch.encode(),
        check=True, capture_output=True, timeout=30,
    )
    logger.info("已从 checkpoint %s 重放累计补丁（%d bytes）", checkpoint["id"], len(patch))


def _build_feedback(checkpoint: dict[str, Any], fine_grained: bool) -> str | None:
    failure = checkpoint.get("lastFailure")
    if not failure:
        return None
    verification = failure.get("verification")
    if checkpoint.get("feedbackMode") == "raw":
        # 实验三对照组：只给原始输出，不给失败分类与验证步骤的结构化解释
        detail = str(verification.get("detail"))[:3000] if verification else "(无输出)"
        parts = ["上一次尝试失败。原始输出如下：", detail]
    else:
        parts = [f"上一次尝试失败，失败码: {failure.get('failureCode')}"]
        if verification:
            detail = str(verification.get("detail"))[:3000]
            parts.append(f"验证步骤 {verification.get('step')} 未通过，详情: {detail}")
    if fine_grained:
        parts.append("请基于当前工作区继续修复（之前应用的补丁已保留）。")
    else:
        parts.append("工作区已重置为初始状态，请重新完成修复并避开上述失败原因。")
    return "\n".join(parts)


class RealExecutor:
    def __init__(self, cp: ControlPlaneClient) -> None:
        self.cp = cp
        self.provider = DockerSandboxProvider()
        self.settings = get_settings()

    def execute(self, command: RunCommand, attempt_id: str, emitter: EventEmitter) -> AttemptOutcome:
        fine_grained = command.agentKind != "MINI_SWE"

        sandbox = self.provider.start(command.runId, command.repo.path, command.repo.baseCommit)
        try:
            # RESUME：细粒度 adapter 重建沙箱状态 + 载入副作用缓存；
            # 粗粒度 adapter（mini-SWE）退化为重启，只继承失败反馈文本（IM-06）
            completed_tool_calls: dict[str, str] = {}
            feedback: str | None = None
            resume = command.type == "RESUME_RUN" and command.checkpointId is not None
            if resume:
                checkpoint = self.cp.get_checkpoint(command.checkpointId)
                feedback = _build_feedback(checkpoint, fine_grained)
                if fine_grained:
                    _restore_from_checkpoint(sandbox, checkpoint)
                    completed_tool_calls = dict(checkpoint.get("completedToolCalls") or {})

            toolset = Toolset(
                sandbox,
                emitter,
                completed_tool_calls=completed_tool_calls,
                allowed_paths=command.taskSpec.allowedPaths,
                command_cwd=f"/workspace/{command.taskSpec.workdir}",
            )

            def on_checkpoint(used_tokens: int, used_seconds: int) -> None:
                diff = _current_diff(sandbox, command.repo.baseCommit)
                checkpoint_id = self.cp.save_checkpoint(command.runId, {
                    "attemptId": attempt_id,
                    "threadId": command.runId,
                    "baseCommit": command.repo.baseCommit,
                    "appliedPatchSha": (
                        "sha256:" + hashlib.sha256(diff.encode()).hexdigest()[:16]
                        if diff.strip() else None
                    ),
                    "appliedPatch": diff if diff.strip() else None,
                    "completedToolCalls": toolset.completed,
                    "usedTokens": used_tokens,
                    "usedSeconds": used_seconds,
                })
                emitter.emit("CHECKPOINT_SAVED", {
                    "checkpointId": checkpoint_id,
                    "usedTokens": used_tokens,
                    "usedSeconds": used_seconds,
                })
                # FAULT_INJECT=kill-worker：首个含补丁的 checkpoint 落盘后硬杀进程，
                # 演示 LEASE_EXPIRED -> WORKER_LOST -> RESUME 的平台恢复路径。
                # 选这个时机是因为 apply_patch 已进 completedToolCalls 而 LangGraph
                # 尚未持久化该 tools 节点，恢复重放必然命中幂等缓存（cached=true）
                if (
                    self.settings.fault_inject == "kill-worker"
                    and command.attemptNo == 1
                    and diff.strip()
                ):
                    import os

                    logger.warning("FAULT_INJECT=kill-worker：模拟进程崩溃 os._exit(137)")
                    os._exit(137)

            adapter: AgentAdapter
            if command.agentKind == "MINI_SWE":
                adapter = MiniSWEAgentAdapter(sandbox, emitter, on_checkpoint=on_checkpoint)
            else:
                model = build_model(
                    _read_gold_patch(command.taskSpec.fixtureId), command.taskSpec.failToPass
                )
                adapter = SelfLangGraphAdapter(
                    toolset, emitter, model,
                    database_url=self.settings.database_url, on_checkpoint=on_checkpoint,
                )

            started = time.monotonic()
            result = adapter.execute(
                command,
                resume=resume and adapter.capabilities()["fineGrainedResume"],
                feedback=feedback,
            )
            used_tokens = result.used_tokens
            used_seconds = int(time.monotonic() - started)

            # 六步 Verifier 门禁
            verification: list[dict[str, Any]] = []
            pipeline = VerifierPipeline(
                sandbox, emitter, command.taskSpec, command.repo.baseCommit,
                on_result=lambda r: verification.append({
                    "step": r.step, "passed": r.passed, "failureCode": r.failure_code,
                    "detail": r.detail, "durationMs": r.duration_ms,
                }),
            )
            report: VerifyReport = pipeline.run()

            if report.passed:
                # LLM Judge：独立模型对补丁按验收条款逐条打分（不否决，失败返回 None）
                from arp_runtime.judge import judge_run

                judge = judge_run(
                    command.taskSpec.acceptanceCriteria, report.patch or "", verification
                )
                return AttemptOutcome(
                    status="SUCCEEDED",
                    used_tokens=used_tokens, used_seconds=used_seconds,
                    verification=verification, patch=report.patch, judge=judge,
                )
            # 验证失败也落一次 checkpoint，RESUME 时能带着当前工作区状态继续修
            on_checkpoint(used_tokens, used_seconds)
            return AttemptOutcome(
                status="FAILED", failure_code=report.failure_code,
                used_tokens=used_tokens, used_seconds=used_seconds,
                verification=verification, patch=report.patch or None,
            )
        finally:
            sandbox.destroy()
