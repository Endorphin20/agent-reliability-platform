"""DockerSandboxProvider 集成测试（T5 验收：超时强杀、清理、隔离）。

需要本机 docker daemon 与 arp-sandbox:latest 镜像；不可用时自动 skip。
"""

import shutil
import subprocess
import uuid
from pathlib import Path

import pytest

pytest.importorskip("docker")
import docker  # noqa: E402

from arp_runtime.sandbox.provider import DockerSandboxProvider, LABEL_RUN_ID  # noqa: E402


def _docker_ready() -> bool:
    try:
        client = docker.from_env()
        client.ping()
        client.images.get("arp-sandbox:latest")
        return True
    except Exception:  # noqa: BLE001
        return False


pytestmark = pytest.mark.skipif(not _docker_ready(), reason="docker 或 arp-sandbox 镜像不可用")


@pytest.fixture(scope="module")
def fixture_repo(tmp_path_factory) -> Path:
    """构造一个最小 git 仓库当作 fixture 源。"""
    repo = tmp_path_factory.mktemp("mini-repo")
    (repo / "hello.txt").write_text("hello sandbox\n")
    subprocess.run(["git", "init", "-b", "main"], cwd=repo, check=True, capture_output=True)
    subprocess.run(["git", "add", "."], cwd=repo, check=True, capture_output=True)
    subprocess.run(
        ["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"],
        cwd=repo, check=True, capture_output=True,
    )
    return repo


@pytest.fixture()
def provider() -> DockerSandboxProvider:
    return DockerSandboxProvider()


class TestSandbox:
    def test_exec_and_destroy(self, provider, fixture_repo):
        run_id = f"test-{uuid.uuid4().hex[:8]}"
        sandbox = provider.start(run_id, str(fixture_repo), "main")
        try:
            result = sandbox.exec("cat hello.txt")
            assert result.exit_code == 0
            assert "hello sandbox" in result.stdout
        finally:
            sandbox.destroy()
        client = docker.from_env()
        assert client.containers.list(all=True, filters={"label": f"{LABEL_RUN_ID}={run_id}"}) == []

    def test_timeout_kill(self, provider, fixture_repo):
        run_id = f"test-{uuid.uuid4().hex[:8]}"
        sandbox = provider.start(run_id, str(fixture_repo), "main")
        try:
            result = sandbox.exec("sleep 30", timeout_s=2)
            assert result.exit_code in (124, 137)  # timeout --signal=KILL
        finally:
            sandbox.destroy()

    def test_network_isolated(self, provider, fixture_repo):
        run_id = f"test-{uuid.uuid4().hex[:8]}"
        sandbox = provider.start(run_id, str(fixture_repo), "main")
        try:
            # 镜像内没有 curl/wget；用 node fetch 验证外网不可达
            result = sandbox.exec(
                "node -e \"fetch('https://example.com').then(()=>process.exit(0)).catch(()=>process.exit(1))\"",
                timeout_s=15,
            )
            assert result.exit_code != 0
        finally:
            sandbox.destroy()

    def test_readonly_rootfs(self, provider, fixture_repo):
        run_id = f"test-{uuid.uuid4().hex[:8]}"
        sandbox = provider.start(run_id, str(fixture_repo), "main")
        try:
            assert sandbox.exec("touch /evil").exit_code != 0      # 根文件系统只读
            assert sandbox.exec("touch /tmp/ok").exit_code == 0    # tmpfs 可写
            assert sandbox.exec("touch /workspace/ok").exit_code == 0  # 工作区可写
        finally:
            sandbox.destroy()

    def test_cleanup_orphans(self, provider, fixture_repo):
        run_id = f"test-{uuid.uuid4().hex[:8]}"
        sandbox = provider.start(run_id, str(fixture_repo), "main")
        # 模拟 worker 崩溃：不调用 destroy，直接清扫
        shutil.rmtree(sandbox.workdir, ignore_errors=True)
        assert provider.cleanup_orphans() >= 1
        client = docker.from_env()
        assert client.containers.list(all=True, filters={"label": LABEL_RUN_ID}) == []
