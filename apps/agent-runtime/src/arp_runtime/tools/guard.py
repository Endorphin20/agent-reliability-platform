"""run_command 白名单 / denylist 校验（计划 §8）。

规则：
- 命令必须命中白名单前缀之一（按空格分词后前缀匹配）；
- 允许前导 `KEY=VALUE` 环境变量赋值（及 `env` 前缀），剥离后再做前缀匹配——
  SWE-bench 失败分析（docs/failure-analysis.md RC1）证明：拒绝
  `PYTHONPATH=/workspace python3 ...` 这类合法测试命令不会让 Agent 放弃，
  只会让它烧预算绕路，且绕路方式（`python3 -c` 内联脚本）更难审计；
- 命中 denylist 正则直接拒绝（全串扫描，含环境变量值；即使前缀合法，
  例如 `git diff; curl ...`）；
- 禁止 shell 元字符注入绕过：`;`、`&&`、`||`、反引号、`$(`；
- 拒绝消息必须把白名单告诉调用方：Agent 第一次被拒就该知道边界在哪，
  而不是盲试。
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
# 前导环境变量赋值：KEY=VALUE（VALUE 不能含空白；引号包裹的复杂值不放行）
ENV_ASSIGNMENT_PATTERN = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=\S*$")


class CommandRejected(Exception):
    def __init__(self, command: str, reason: str) -> None:
        super().__init__(f"命令被拒绝: {reason}: {command}")
        self.command = command
        self.reason = reason


def _allowed_prefixes_hint() -> str:
    return "允许的命令前缀: " + ", ".join(" ".join(p) for p in ALLOWED_PREFIXES) + \
        "（可带前导 KEY=VALUE 环境变量赋值）"


def validate_command(command: str) -> None:
    stripped = command.strip()
    if not stripped:
        raise CommandRejected(command, "空命令")
    if DENYLIST_PATTERN.search(stripped):
        raise CommandRejected(command, "命中 denylist")
    if SHELL_INJECTION_PATTERN.search(stripped):
        raise CommandRejected(
            command, "含 shell 注入元字符（; && || ` $( 均不允许，请拆成多条命令）"
        )
    tokens = stripped.split()
    # 剥离 `env` 前缀与前导 KEY=VALUE 赋值后再做白名单匹配
    idx = 1 if tokens[0] == "env" else 0
    while idx < len(tokens) and ENV_ASSIGNMENT_PATTERN.match(tokens[idx]):
        idx += 1
    rest = tokens[idx:]
    if not rest:
        raise CommandRejected(command, "只有环境变量赋值，没有命令")
    for prefix in ALLOWED_PREFIXES:
        if tuple(rest[: len(prefix)]) == prefix:
            return
    raise CommandRejected(command, f"不在白名单。{_allowed_prefixes_hint()}")
