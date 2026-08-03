"""DockerSandboxProvider（计划 §8 安全边界）。

固定启动参数（任务不可覆盖）：
- CPU / 内存 / pids 限制，--read-only 根文件系统 + tmpfs /tmp
- 默认 network none；绝不挂载 docker.sock / 宿主 HOME / 平台源码
- 仅把 fixture 的工作副本挂到 /workspace (rw)
- label arp.run_id 用于故障注入定位与孤儿清扫
"""

import logging
import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path

import docker
from docker.models.containers import Container

from arp_runtime.config import get_settings

logger = logging.getLogger("arp.sandbox")

LABEL_RUN_ID = "arp.run_id"


@dataclass
class ExecResult:
    exit_code: int
    stdout: str


class SandboxError(Exception):
    pass


class SandboxCrashed(SandboxError):
    """沙箱容器在执行中途消亡（被杀/OOM）。必须快速失败并冒泡到 worker，
    映射 SANDBOX_CRASHED 交给 Policy Engine 决策 RESUME，绝不能当作普通
    工具失败反馈给模型（否则 Agent 会对着死沙箱空转烧预算）。"""


class Sandbox:
    def __init__(self, container: Container, workdir: Path, run_id: str) -> None:
        self.container = container
        self.workdir = workdir  # 宿主侧工作副本（挂载到容器 /workspace）
        self.run_id = run_id

    def exec(self, command: str, timeout_s: int | None = None, cwd: str = "/workspace") -> ExecResult:
        settings = get_settings()
        limit = timeout_s or settings.sandbox_timeout_s
        # 用容器内 GNU timeout 实现超时强杀（124 = 超时退出码）
        wrapped = ["timeout", "--signal=KILL", str(limit), "sh", "-lc", command]
        try:
            exit_code, output = self.container.exec_run(wrapped, workdir=cwd, demux=False)
        except docker.errors.DockerException as exc:
            raise SandboxCrashed(f"沙箱容器不可用（run={self.run_id}）: {exc}") from exc
        stdout = output.decode("utf-8", errors="replace") if output else ""
        return ExecResult(exit_code=exit_code, stdout=stdout)

    def destroy(self) -> None:
        try:
            self.container.remove(force=True)
        except docker.errors.APIError:
            logger.warning("销毁容器失败 run=%s（可能已不存在）", self.run_id)
        shutil.rmtree(self.workdir, ignore_errors=True)


class DockerSandboxProvider:
    def __init__(self) -> None:
        self.settings = get_settings()
        self.client = docker.from_env()

    def _prepare_workdir(self, repo_path: str, base_ref: str) -> Path:
        """把 fixture 仓库在 base_ref 处的工作副本检出到独立临时目录。"""
        workdir = Path(tempfile.mkdtemp(prefix="arp-sandbox-"))
        source = Path(repo_path).expanduser()
        if not source.exists():
            raise SandboxError(f"fixture 仓库不存在: {source}")
        try:
            subprocess.run(
                ["git", "clone", "--local", "--no-hardlinks", str(source), str(workdir / "repo")],
                check=True, capture_output=True, timeout=120,
            )
            subprocess.run(
                ["git", "checkout", "--detach", base_ref],
                cwd=workdir / "repo", check=True, capture_output=True, timeout=60,
            )
        except subprocess.CalledProcessError as exc:
            shutil.rmtree(workdir, ignore_errors=True)
            raise SandboxError(f"检出 {base_ref} 失败: {exc.stderr.decode(errors='replace')}") from exc
        return workdir / "repo"

    def start(self, run_id: str, repo_path: str, base_ref: str) -> Sandbox:
        workdir = self._prepare_workdir(repo_path, base_ref)
        try:
            container = self.client.containers.run(
                self.settings.sandbox_image,
                command=["sleep", "infinity"],
                detach=True,
                labels={LABEL_RUN_ID: run_id},
                nano_cpus=int(self.settings.sandbox_cpus * 1e9),
                mem_limit=self.settings.sandbox_memory,
                pids_limit=256,
                network_mode=(
                    "none" if self.settings.sandbox_network_mode == "none" else "bridge"
                ),
                read_only=True,
                tmpfs={"/tmp": "rw,size=512m", "/home/agent": "rw,size=256m"},
                volumes={str(workdir): {"bind": "/workspace", "mode": "rw"}},
                working_dir="/workspace",
                environment={"HOME": "/home/agent"},
            )
        except docker.errors.DockerException as exc:
            shutil.rmtree(workdir.parent, ignore_errors=True)
            raise SandboxError(f"沙箱启动失败: {exc}") from exc
        logger.info("沙箱已启动 run=%s container=%s", run_id, container.short_id)
        return Sandbox(container=container, workdir=workdir, run_id=run_id)

    def cleanup_orphans(self) -> int:
        """Runtime 启动时清扫上次崩溃遗留的沙箱容器。"""
        orphans = self.client.containers.list(all=True, filters={"label": LABEL_RUN_ID})
        for container in orphans:
            logger.warning("清理孤儿沙箱 %s (run=%s)",
                           container.short_id, container.labels.get(LABEL_RUN_ID))
            container.remove(force=True)
        return len(orphans)
