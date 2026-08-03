"""六步 Verifier 门禁（计划 §4.8，T8）。

V1 补丁良构：工作区相对 base 有非空 diff 且 git 可解析；
V2 范围合规：所有变更文件命中 allowed_paths（fnmatch glob）；
V3 静态检查：static_check 命令全部 exit 0；
V4 定向测试：fail_to_pass 命令全部 exit 0；
V5 回归测试：pass_to_pass 命令全部 exit 0；
V6 测试防篡改：tests/**、*.test.*、test_* 文件相对 base 无变更。

短路语义：某步失败立即停止（后续步不执行）；每步产出
VERIFICATION_RESULT 事件并回传 Control Plane 落库。
"""

import subprocess
import time
from dataclasses import dataclass
from fnmatch import fnmatch
from pathlib import Path
from typing import Any, Callable

from arp_runtime.events import EventEmitter
from arp_runtime.sandbox.provider import Sandbox
from arp_runtime.schemas.run_command import TaskSpec

TEST_FILE_MARKERS = ("tests/", ".test.", ".spec.", "/test_")


@dataclass
class StepResult:
    step: str
    passed: bool
    failure_code: str | None
    detail: dict[str, Any]
    duration_ms: int


@dataclass
class VerifyReport:
    passed: bool
    results: list[StepResult]
    patch: str  # 相对 base 的最终 diff（成功时作为 PATCH 工件）

    @property
    def failure_code(self) -> str | None:
        for result in self.results:
            if not result.passed:
                return result.failure_code
        return None


def _git_diff(workdir: Path, base_commit: str) -> str:
    result = subprocess.run(
        ["git", "diff", base_commit],
        cwd=workdir, capture_output=True, text=True, timeout=60,
    )
    if result.returncode != 0:
        raise RuntimeError(f"git diff 失败: {result.stderr[:500]}")
    return result.stdout


def _changed_files(workdir: Path, base_commit: str) -> list[str]:
    result = subprocess.run(
        ["git", "diff", "--name-only", base_commit],
        cwd=workdir, capture_output=True, text=True, timeout=60,
    )
    return [line for line in result.stdout.splitlines() if line.strip()]


def _is_test_file(path: str) -> bool:
    return any(marker in path for marker in TEST_FILE_MARKERS)


class VerifierPipeline:
    def __init__(
        self,
        sandbox: Sandbox,
        emitter: EventEmitter,
        task_spec: TaskSpec,
        base_commit: str,
        on_result: Callable[[StepResult], None] | None = None,
    ) -> None:
        self.sandbox = sandbox
        self.emitter = emitter
        self.spec = task_spec
        self.base_commit = base_commit
        self.on_result = on_result

    def _record(self, step: str, passed: bool, failure_code: str | None,
                detail: dict[str, Any], started: float) -> StepResult:
        result = StepResult(
            step=step, passed=passed, failure_code=None if passed else failure_code,
            detail=detail, duration_ms=int((time.monotonic() - started) * 1000),
        )
        # 共享契约里 failureCode 是 optional（非 nullable），通过时必须整个省略
        self.emitter.emit("VERIFICATION_RESULT", {
            "step": step, "passed": passed, "detail": detail,
            **({"failureCode": result.failure_code} if result.failure_code else {}),
        })
        if self.on_result:
            self.on_result(result)
        return result

    def _run_commands(self, step: str, commands: list[str], failure_code: str) -> StepResult:
        started = time.monotonic()
        for command in commands:
            exec_result = self.sandbox.exec(command, cwd=f"/workspace/{self.spec.workdir}")
            if exec_result.exit_code != 0:
                return self._record(step, False, failure_code, {
                    "command": command,
                    "exitCode": exec_result.exit_code,
                    "stdoutTail": exec_result.stdout[-3000:],
                }, started)
        return self._record(step, True, None, {"commands": commands}, started)

    def run(self) -> VerifyReport:
        results: list[StepResult] = []

        def fail(report_patch: str = "") -> VerifyReport:
            return VerifyReport(passed=False, results=results, patch=report_patch)

        # V1 补丁良构
        started = time.monotonic()
        try:
            patch = _git_diff(self.sandbox.workdir, self.base_commit)
        except RuntimeError as exc:
            results.append(self._record("V1", False, "VERIFY_PATCH_MALFORMED",
                                        {"error": str(exc)}, started))
            return fail()
        if not patch.strip():
            results.append(self._record("V1", False, "VERIFY_PATCH_MALFORMED",
                                        {"error": "工作区相对 base 无任何变更"}, started))
            return fail()
        results.append(self._record("V1", True, None,
                                    {"patchBytes": len(patch.encode())}, started))

        # V2 范围合规
        started = time.monotonic()
        changed = _changed_files(self.sandbox.workdir, self.base_commit)
        violations = [
            path for path in changed
            if not any(fnmatch(path, pattern) for pattern in self.spec.allowedPaths)
        ]
        if violations:
            results.append(self._record("V2", False, "VERIFY_SCOPE_VIOLATION",
                                        {"violations": violations, "allowed": self.spec.allowedPaths},
                                        started))
            return fail(patch)
        results.append(self._record("V2", True, None, {"changedFiles": changed}, started))

        # V6 提前于测试执行：若测试被篡改，V4/V5 的通过毫无意义，且属高危信号。
        # （事件与落库仍按步骤名 V6 上报，短路顺序是实现细节）
        started = time.monotonic()
        tampered = [path for path in changed if _is_test_file(path)]
        if tampered:
            results.append(self._record("V6", False, "VERIFY_TEST_TAMPERING",
                                        {"tamperedFiles": tampered}, started))
            return fail(patch)
        results.append(self._record("V6", True, None, {"checkedFiles": len(changed)}, started))

        # V3 静态检查
        v3 = self._run_commands("V3", self.spec.staticCheck, "VERIFY_STATIC_FAILED")
        results.append(v3)
        if not v3.passed:
            return fail(patch)

        # V4 定向测试
        v4 = self._run_commands("V4", self.spec.failToPass, "VERIFY_TARGET_TESTS_FAILED")
        results.append(v4)
        if not v4.passed:
            return fail(patch)

        # V5 回归测试
        v5 = self._run_commands("V5", self.spec.passToPass, "VERIFY_REGRESSION_FAILED")
        results.append(v5)
        if not v5.passed:
            return fail(patch)

        return VerifyReport(passed=True, results=results, patch=patch)
