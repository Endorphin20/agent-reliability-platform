"""run_command 白名单 / denylist 校验（计划 §8）。

规则：
- 命令必须命中白名单前缀之一（按空格分词后前缀匹配）；
- 命中 denylist 正则直接拒绝（即使前缀合法，例如 `git diff; curl ...`）；
- 禁止 shell 元字符注入绕过：`;`、`&&`、`||`、反引号、`$(`。
"""

import re

ALLOWED_PREFIXES: tuple[tuple[str, ...], ...] = (
    ("pnpm",),
    ("npm",),
    ("node",),
    ("npx", "vitest"),
    ("tsc",),

    ("python",),
    ("python3",),
    ("pytest",),
    ("uv",),
    ("pip",),
    ("git", "status"),
    ("git", "diff"),
    ("git", "apply"),
    ("git", "add"),
    ("git", "stash"),
    ("ls",),
    ("cat",),
)

DENYLIST_PATTERN = re.compile(r"(curl|wget|ssh|sudo|docker|rm\s+-rf\s+/)", re.IGNORECASE)
SHELL_INJECTION_PATTERN = re.compile(r"[;&|`]|\$\(")


class CommandRejected(Exception):
    def __init__(self, command: str, reason: str) -> None:
        super().__init__(f"命令被拒绝: {reason}: {command}")
        self.command = command
        self.reason = reason


def validate_command(command: str) -> None:
    stripped = command.strip()
    if not stripped:
        raise CommandRejected(command, "空命令")
    if DENYLIST_PATTERN.search(stripped):
        raise CommandRejected(command, "命中 denylist")
    if SHELL_INJECTION_PATTERN.search(stripped):
        raise CommandRejected(command, "含 shell 注入元字符")
    tokens = stripped.split()
    for prefix in ALLOWED_PREFIXES:
        if tuple(tokens[: len(prefix)]) == prefix:
            return
    raise CommandRejected(command, "不在白名单")
