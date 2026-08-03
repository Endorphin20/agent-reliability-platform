"""SWE-bench 子集金标验证：逐 fixture 复现基准判定协议，确认环境可用。

对每个 tasks/swb-*/task.yaml：
1. 本地克隆 repo_path 并 checkout base_ref，挂载进 arp-sandbox 容器（断网）；
2. 应用 test_patch，跑 fail_to_pass —— 必须失败（缺陷可复现）；
3. 应用 gold_patch，跑 fail_to_pass + pass_to_pass —— 必须通过（环境可判定）。

三步全过的实例才有资格进 swebench 评测集；任何一步不符说明测试环境与
基准假设不一致（依赖缺失/版本漂移），该实例弃用换备选。

用法：
    python3 scripts/swebench_validate.py [swb-django-15790 ...]
"""

from __future__ import annotations

import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import yaml

FIXTURE_TASKS_DIR = Path.home() / "Coding" / "agent-reliability" / "agent-fixture-repo" / "tasks"
SANDBOX_IMAGE = "arp-sandbox:latest"
EXEC_TIMEOUT_S = 1200


def sh(args: list[str], **kw) -> subprocess.CompletedProcess:
    return subprocess.run(args, capture_output=True, text=True, **kw)


def container_exec(cid: str, command: str) -> tuple[int, str]:
    proc = sh(
        ["docker", "exec", "-w", "/workspace", cid,
         "timeout", "--signal=KILL", str(EXEC_TIMEOUT_S), "sh", "-lc", command],
        timeout=EXEC_TIMEOUT_S + 60,
    )
    return proc.returncode, (proc.stdout + proc.stderr)


def git_apply(workdir: Path, patch: str) -> None:
    proc = subprocess.run(
        ["git", "apply", "--whitespace=nowarn"],
        cwd=workdir, input=patch, capture_output=True, text=True, timeout=60,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"git apply 失败: {proc.stderr[:800]}")


def validate(task_yaml: Path) -> bool:
    task = yaml.safe_load(task_yaml.read_text())
    fixture = task["id"]
    started = time.monotonic()
    tmp = Path(tempfile.mkdtemp(prefix=f"swb-val-{fixture}-"))
    cid = ""
    try:
        workdir = tmp / "repo"
        sh(["git", "clone", "--local", "--no-hardlinks", task["repo_path"], str(workdir)],
           timeout=300, check=True)
        sh(["git", "checkout", "--detach", task["base_ref"]],
           cwd=workdir, timeout=120, check=True)

        run = sh([
            "docker", "run", "-d", "--network", "none",
            "-v", f"{workdir}:/workspace",
            "--tmpfs", "/tmp:rw,size=512m", "--tmpfs", "/home/agent:rw,size=256m",
            "-e", "HOME=/home/agent",
            SANDBOX_IMAGE, "sleep", "infinity",
        ], timeout=120, check=True)
        cid = run.stdout.strip()

        git_apply(workdir, task["test_patch"])

        # 步骤 1：修复前定向测试必须失败
        for cmd in task["fail_to_pass"]:
            code, out = container_exec(cid, cmd)
            if code == 0:
                print(f"  [FAIL] 修复前 fail_to_pass 就通过了（测试选择有误）: {cmd}")
                return False

        git_apply(workdir, task["gold_patch"])

        # 步骤 2：金标修复后定向测试必须通过
        for cmd in task["fail_to_pass"]:
            code, out = container_exec(cid, cmd)
            if code != 0:
                print(f"  [FAIL] 金标修复后 fail_to_pass 未通过 (exit={code}): {cmd}")
                print("  ---- 输出尾部 ----")
                print("  " + "\n  ".join(out[-2000:].splitlines()))
                return False

        # 步骤 3：回归测试必须通过
        for cmd in task["pass_to_pass"]:
            code, out = container_exec(cid, cmd)
            if code != 0:
                print(f"  [FAIL] 金标修复后 pass_to_pass 未通过 (exit={code}): {cmd[:120]}...")
                print("  ---- 输出尾部 ----")
                print("  " + "\n  ".join(out[-2000:].splitlines()))
                return False

        print(f"  [PASS] {fixture}  ({int(time.monotonic() - started)}s)")
        return True
    except (subprocess.CalledProcessError, RuntimeError, subprocess.TimeoutExpired) as exc:
        detail = getattr(exc, "stderr", "") or str(exc)
        print(f"  [FAIL] {fixture} 环境错误: {str(detail)[:500]}")
        return False
    finally:
        if cid:
            sh(["docker", "rm", "-f", cid], timeout=60)
        shutil.rmtree(tmp, ignore_errors=True)


def main() -> None:
    names = sys.argv[1:]
    if names:
        yamls = [FIXTURE_TASKS_DIR / n / "task.yaml" for n in names]
    else:
        yamls = sorted(FIXTURE_TASKS_DIR.glob("swb-*/task.yaml"))
    passed, failed = [], []
    for task_yaml in yamls:
        print(f"== {task_yaml.parent.name}")
        (passed if validate(task_yaml) else failed).append(task_yaml.parent.name)
    print(f"\n通过 {len(passed)}: {' '.join(passed)}")
    print(f"失败 {len(failed)}: {' '.join(failed)}")


if __name__ == "__main__":
    main()
