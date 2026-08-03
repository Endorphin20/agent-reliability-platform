"""六步 Verifier 的单元测试：git 仓库为真，沙箱 exec 打桩。"""

import subprocess
from pathlib import Path
from typing import Any

import pytest

from arp_runtime.schemas.run_command import TaskSpec
from arp_runtime.verifier.pipeline import VerifierPipeline


class StubEmitter:
    def __init__(self) -> None:
        self.events: list[tuple[str, dict[str, Any]]] = []

    def emit(self, event_type: str, payload: dict[str, Any]) -> int:
        self.events.append((event_type, payload))
        return len(self.events)


class StubSandbox:
    """workdir 是真实 git 仓库；exec 按预设表返回。"""

    def __init__(self, workdir: Path, exec_results: dict[str, int] | None = None) -> None:
        self.workdir = workdir
        self.run_id = "run-test"
        self.exec_results = exec_results or {}

    def exec(self, command: str, timeout_s: int | None = None, cwd: str = "/workspace"):
        from arp_runtime.sandbox.provider import ExecResult

        exit_code = self.exec_results.get(command, 0)
        return ExecResult(exit_code=exit_code, stdout=f"stub output for {command}")


@pytest.fixture
def repo(tmp_path: Path) -> tuple[Path, str]:
    """初始化一个含 src/ 与 tests/ 的 git 仓库，返回 (workdir, base_commit)。"""
    def git(*args: str) -> str:
        return subprocess.run(
            ["git", *args], cwd=tmp_path, check=True, capture_output=True, text=True,
        ).stdout.strip()

    (tmp_path / "pkg" / "src").mkdir(parents=True)
    (tmp_path / "pkg" / "tests").mkdir(parents=True)
    (tmp_path / "pkg" / "src" / "main.ts").write_text("export const x = 1;\n")
    (tmp_path / "pkg" / "tests" / "main.test.js").write_text("// test\n")
    git("init")
    git("-c", "user.email=t@t", "-c", "user.name=t", "add", ".")
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "base")
    return tmp_path, git("rev-parse", "HEAD")


def make_spec() -> TaskSpec:
    return TaskSpec(
        fixtureId="x", description="d", workdir="pkg",
        allowedPaths=["pkg/src/**"],
        staticCheck=["npm run typecheck"],
        failToPass=["npm run test:target"],
        passToPass=["npm test"],
    )


def run_pipeline(workdir: Path, base: str, exec_results: dict[str, int] | None = None):
    sandbox = StubSandbox(workdir, exec_results)
    return VerifierPipeline(sandbox, StubEmitter(), make_spec(), base).run()


def test_v1_fails_on_empty_diff(repo: tuple[Path, str]) -> None:
    workdir, base = repo
    report = run_pipeline(workdir, base)
    assert not report.passed
    assert report.failure_code == "VERIFY_PATCH_MALFORMED"
    assert [r.step for r in report.results] == ["V1"]


def test_v2_fails_on_out_of_scope_change(repo: tuple[Path, str]) -> None:
    workdir, base = repo
    (workdir / "pkg" / "other.ts").write_text("out of scope\n")
    subprocess.run(["git", "add", "."], cwd=workdir, check=True, capture_output=True)
    report = run_pipeline(workdir, base)
    assert report.failure_code == "VERIFY_SCOPE_VIOLATION"


def test_v6_fails_on_test_tampering(repo: tuple[Path, str]) -> None:
    workdir, base = repo
    (workdir / "pkg" / "src" / "main.ts").write_text("export const x = 2;\n")
    (workdir / "pkg" / "tests" / "main.test.js").write_text("// hacked\n")
    report = run_pipeline(workdir, base)
    # 篡改的测试文件不在 allowed_paths 内，先被 V2 拦下也是正确行为；
    # 这里将 tests/** 加入 allowed 验证 V6 自身逻辑
    spec = make_spec()
    spec = spec.model_copy(update={"allowedPaths": ["pkg/**"]})
    sandbox = StubSandbox(workdir)
    report = VerifierPipeline(sandbox, StubEmitter(), spec, base).run()
    assert report.failure_code == "VERIFY_TEST_TAMPERING"


def test_v4_fails_when_target_tests_fail(repo: tuple[Path, str]) -> None:
    workdir, base = repo
    (workdir / "pkg" / "src" / "main.ts").write_text("export const x = 2;\n")
    report = run_pipeline(workdir, base, {"npm run test:target": 1})
    assert report.failure_code == "VERIFY_TARGET_TESTS_FAILED"
    assert [r.step for r in report.results] == ["V1", "V2", "V6", "V3", "V4"]


def test_all_pass_returns_patch(repo: tuple[Path, str]) -> None:
    workdir, base = repo
    (workdir / "pkg" / "src" / "main.ts").write_text("export const x = 2;\n")
    report = run_pipeline(workdir, base)
    assert report.passed
    assert report.failure_code is None
    assert "export const x = 2;" in report.patch
    assert [r.step for r in report.results] == ["V1", "V2", "V6", "V3", "V4", "V5"]
