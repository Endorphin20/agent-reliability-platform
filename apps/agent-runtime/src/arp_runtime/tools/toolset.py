"""受控工具集：read_file / search_code / apply_patch / run_command。

- 读写类工具直接操作宿主侧工作副本（与容器 /workspace 同一目录）；
- run_command 只在沙箱容器内执行，且必须通过 guard 校验（禁止 shell=True 直通）；
- 每次调用产出 TOOL_CALL 事件；恢复场景命中 completedToolCalls 缓存则跳过执行
  并打 cached=true（§4.5 副作用幂等）。
"""

import hashlib
import re
import subprocess
import time
from pathlib import Path
from typing import Any, Callable

from arp_runtime.events import EventEmitter
from arp_runtime.sandbox.provider import Sandbox
from arp_runtime.tools.guard import CommandRejected, validate_command


def _digest(text: str) -> str:
    return "sha256:" + hashlib.sha256(text.encode()).hexdigest()[:16]


def parse_patch_stats(patch: str) -> list[dict[str, Any]]:
    """从 unified diff 提取每个文件的变更类型和增删行数（FILE_CHANGE payload）。"""
    changes: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None
    for line in patch.splitlines():
        if line.startswith("diff --git"):
            if current:
                changes.append(current)
            current = {"path": "", "changeType": "modify",
                       "diffStat": {"additions": 0, "deletions": 0}}
        elif current is not None:
            if line.startswith("+++ b/"):
                current["path"] = line[6:].strip()
            elif line.startswith("new file mode"):
                current["changeType"] = "create"
            elif line.startswith("deleted file mode"):
                current["changeType"] = "delete"
            elif line.startswith("--- a/") and current["changeType"] == "delete":
                current["path"] = line[6:].strip()
            elif line.startswith("+") and not line.startswith("+++"):
                current["diffStat"]["additions"] += 1
            elif line.startswith("-") and not line.startswith("---"):
                current["diffStat"]["deletions"] += 1
    if current:
        changes.append(current)
    return [c for c in changes if c["path"]]


class ToolExecutionError(Exception):
    pass


class Toolset:
    def __init__(
        self,
        sandbox: Sandbox,
        emitter: EventEmitter,
        completed_tool_calls: dict[str, str] | None = None,
        allowed_paths: list[str] | None = None,
        command_cwd: str | None = None,
    ) -> None:
        self.sandbox = sandbox
        self.emitter = emitter
        # {toolCallId: resultDigest} —— 恢复时不重放已完成的副作用
        self.completed: dict[str, str] = dict(completed_tool_calls or {})
        self.allowed_paths = allowed_paths
        # 任务 workdir（容器内路径），run_command 的默认工作目录
        self.command_cwd = command_cwd or "/workspace"
        # 包目录相对仓库根的前缀（如 packages/py-api-001），用于 read_file 纠错提示
        self.workdir_prefix = self.command_cwd.removeprefix("/workspace").strip("/")
        self._counter = 0

    def _next_id(self) -> str:
        # 必须带 attempt 编号：跨 attempt 的序列号会重叠，否则恢复后误命中缓存
        self._counter += 1
        return (
            f"tc-{self.sandbox.run_id}-a{self.emitter.attempt_no}"
            f"-{self.emitter.sequence}-{self._counter}"
        )

    def _record(
        self,
        tool: str,
        args: dict[str, Any],
        fn: Callable[[], str],
        tool_call_id: str | None = None,
    ) -> str:
        call_id = tool_call_id or self._next_id()
        if call_id in self.completed:
            self.emitter.emit("TOOL_CALL", {
                "toolCallId": call_id, "tool": tool, "args": args,
                "resultDigest": self.completed[call_id], "durationMs": 0, "cached": True,
            })
            return f"[cached] {tool} 已在中断前完成，结果摘要 {self.completed[call_id]}"
        start = time.monotonic()
        try:
            result = fn()
        except Exception as exc:
            # 失败调用同样是审计信息：不发事件的话，guard 拒绝在时间线上完全
            # 不可见（failure-analysis RC3——被迫去 checkpoint blob 里取证）
            self.emitter.emit("TOOL_CALL", {
                "toolCallId": call_id, "tool": tool, "args": args,
                "resultDigest": _digest(str(exc)),
                "durationMs": int((time.monotonic() - start) * 1000),
                "cached": False, "error": str(exc)[:500],
            })
            raise
        digest = _digest(result)
        self.completed[call_id] = digest
        self.emitter.emit("TOOL_CALL", {
            "toolCallId": call_id, "tool": tool, "args": args,
            "resultDigest": digest,
            "durationMs": int((time.monotonic() - start) * 1000), "cached": False,
        })
        return result

    # ---- 工具实现 ----

    # 无行范围时的默认窗口：大文件全文回读是上下文膨胀的主因
    # （failure-analysis RC2：django/sympy 数千行文件读三四个后每轮固定背 37-48k token）
    READ_DEFAULT_WINDOW = 200
    READ_MAX_CHARS = 50_000

    def read_file(self, path: str, start_line: int | None = None,
                  end_line: int | None = None) -> str:
        def impl() -> str:
            target = (self.sandbox.workdir / path).resolve()
            if not str(target).startswith(str(self.sandbox.workdir.resolve())):
                raise ToolExecutionError(f"路径越界: {path}")
            if not target.is_file():
                # 高频错误是漏了包目录前缀（path 需相对仓库根），主动给纠错提示
                if self.workdir_prefix:
                    candidate = (self.sandbox.workdir / self.workdir_prefix / path).resolve()
                    if candidate.is_file():
                        return (f"[error] 文件不存在: {path}。"
                                f"path 需相对仓库根，你可能想读 {self.workdir_prefix}/{path}")
                return f"[error] 文件不存在: {path}（path 需相对仓库根）"
            lines = target.read_text(errors="replace").splitlines()
            total = len(lines)
            first = max(1, start_line or 1)
            if end_line is not None:
                last = min(total, end_line)
            elif start_line is not None:
                last = min(total, first + self.READ_DEFAULT_WINDOW - 1)
            else:
                last = total if total <= self.READ_DEFAULT_WINDOW else self.READ_DEFAULT_WINDOW
            numbered = "\n".join(
                f"{i:6}|{lines[i - 1]}" for i in range(first, last + 1)
            )[: self.READ_MAX_CHARS]
            if first > 1 or last < total:
                header = (f"[{path} 共 {total} 行，显示 {first}-{last}；"
                          f"用 start_line/end_line 读取其他区间，"
                          f"建议先 search_code 定位行号]\n")
                return header + numbered
            return numbered
        args: dict[str, Any] = {"path": path}
        if start_line is not None:
            args["start_line"] = start_line
        if end_line is not None:
            args["end_line"] = end_line
        return self._record("read_file", args, impl)

    def search_code(self, pattern: str, glob: str = "**/*") -> str:
        def impl() -> str:
            try:
                compiled = re.compile(pattern)
            except re.error as exc:
                return f"[error] 非法正则: {exc}"
            hits: list[str] = []
            for file in sorted(self.sandbox.workdir.glob(glob)):
                if not file.is_file() or ".git" in file.parts or "node_modules" in file.parts:
                    continue
                try:
                    for lineno, line in enumerate(file.read_text(errors="replace").splitlines(), 1):
                        if compiled.search(line):
                            rel = file.relative_to(self.sandbox.workdir)
                            hits.append(f"{rel}:{lineno}: {line.strip()[:200]}")
                            if len(hits) >= 100:
                                return "\n".join(hits)
                except OSError:
                    continue
            return "\n".join(hits) if hits else "[no matches]"
        return self._record("search_code", {"pattern": pattern, "glob": glob}, impl)

    def apply_patch(self, patch: str, tool_call_id: str | None = None) -> str:
        def impl() -> str:
            # 幂等预检：反向 apply 成功说明补丁已应用过，直接跳过（§4.5）
            reverse = subprocess.run(
                ["git", "apply", "--check", "--reverse", "-"],
                cwd=self.sandbox.workdir, input=patch.encode(),
                capture_output=True, timeout=30,
            )
            if reverse.returncode == 0:
                return "[skipped] 补丁已应用（反向校验通过）"
            check = subprocess.run(
                ["git", "apply", "--check", "-"],
                cwd=self.sandbox.workdir, input=patch.encode(),
                capture_output=True, timeout=30,
            )
            if check.returncode != 0:
                raise ToolExecutionError(
                    f"补丁不可应用: {check.stderr.decode(errors='replace')[:2000]}"
                )
            subprocess.run(
                ["git", "apply", "-"],
                cwd=self.sandbox.workdir, input=patch.encode(),
                check=True, capture_output=True, timeout=30,
            )
            for change in parse_patch_stats(patch):
                self.emitter.emit("FILE_CHANGE", change)
            return "[ok] 补丁已应用"
        return self._record("apply_patch", {"patchDigest": _digest(patch)}, impl, tool_call_id)

    def run_command(self, command: str, timeout_s: int | None = None) -> str:
        def impl() -> str:
            try:
                validate_command(command)
            except CommandRejected as exc:
                raise ToolExecutionError(str(exc)) from exc
            start = time.monotonic()
            result = self.sandbox.exec(command, timeout_s=timeout_s, cwd=self.command_cwd)
            self.emitter.emit("COMMAND_EXEC", {
                "command": command,
                "exitCode": result.exit_code,
                "stdoutTail": result.stdout[-2000:],
                **({"stderrTail": result.stderr[-2000:]} if result.stderr else {}),
                "durationMs": int((time.monotonic() - start) * 1000),
            })
            return f"exit={result.exit_code}\n{result.combined[-8000:]}"
        return self._record("run_command", {"command": command}, impl)
