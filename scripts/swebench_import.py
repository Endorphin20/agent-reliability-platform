"""SWE-bench Lite 子集导入：把选定实例转成平台 fixture（tasks/swb-*/task.yaml）。

设计取舍（详见 docs/experiment-report.md swebench 一节）：
- 只选 django(>=4.2) 与 sympy(>=1.11) 的近期实例：两者纯 Python、零编译依赖，
  可在统一的 arp-sandbox 镜像内离线跑测试，绕开 SWE-bench 官方每实例 3GB
  docker 镜像在 arm64 Mac 上的不可行性；
- FAIL_TO_PASS / PASS_TO_PASS 转成可执行命令：
  django: "test_x (a.b.C)" -> runtests.py label "a.b.C.test_x"（docstring 形式
  的条目无法转 label，跳过并记录在 meta_skipped_pass_to_pass）；
  sympy: 裸函数名 + test_patch 中的测试文件 -> pytest node id；
- 基准自带 test_patch 存入 task.yaml 的 test_patch 字段：Agent 不可见，
  Verifier 在 V6 之后应用、跑完测试回滚。

用法：
    cd apps/agent-runtime && uv run --with pyarrow python ../../scripts/swebench_import.py
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parent.parent
PARQUET = REPO_ROOT / "data" / "swebench" / "lite_test.parquet"
FIXTURE_TASKS_DIR = Path.home() / "Coding" / "agent-reliability" / "agent-fixture-repo" / "tasks"
SWEBENCH_REPOS = Path.home() / "Coding" / "agent-reliability" / "swebench-repos"

# 候选实例（含备选）：django 4.2/5.0 与 sympy 1.11+，P2P 规模小的优先（验证快）。
# 实际入选以 swebench_validate.py 金标验证通过为准。
CANDIDATES = [
    "django__django-15790",
    "django__django-15814",
    "django__django-15851",
    "django__django-16046",
    "django__django-16527",
    "django__django-16873",
    "django__django-15819",
    "django__django-16255",
    "sympy__sympy-23117",
    "sympy__sympy-23191",
    "sympy__sympy-24152",
    "sympy__sympy-24909",
    "sympy__sympy-24066",
    "sympy__sympy-24213",
]

ACCEPTANCE_CRITERIA = [
    "补丁直接修复 problem statement 描述的缺陷，而非绕过或隐藏症状",
    "改动最小化：不引入与问题无关的重构、格式化或多余变更",
    "实现方式与仓库既有代码风格和抽象一致，不破坏公开 API 语义",
]

DJANGO_ENTRY_RE = re.compile(r"^(\w+) \(([\w.]+)\)$")


def django_labels(entries: list[str]) -> tuple[list[str], list[str]]:
    """'test_x (a.b.C)' -> 'a.b.C.test_x'；无法解析（docstring 条目）的跳过。"""
    labels: list[str] = []
    skipped: list[str] = []
    for entry in entries:
        match = DJANGO_ENTRY_RE.match(entry.strip())
        if match:
            name, qualifier = match.group(1), match.group(2)
            # py3.11+ unittest 格式是 "test_x (a.b.C.test_x)"，方法名已含在
            # qualifier 里；旧格式 "test_x (a.b.C)" 才需要拼接
            label = qualifier if qualifier.endswith(f".{name}") else f"{qualifier}.{name}"
            labels.append(label)
        else:
            skipped.append(entry)
    return sorted(set(labels)), skipped


def test_files_from_patch(test_patch: str) -> list[str]:
    files = re.findall(r"^diff --git a/(\S+) b/", test_patch, flags=re.MULTILINE)
    return [f for f in files if f.endswith(".py")]


def build_commands(row: dict) -> tuple[list[str], list[str], list[str]]:
    """返回 (fail_to_pass 命令, pass_to_pass 命令, 跳过的 P2P 条目)。"""
    f2p = json.loads(row["FAIL_TO_PASS"])
    p2p = json.loads(row["PASS_TO_PASS"])

    if row["repo"] == "django/django":
        base = "PYTHONPATH=/workspace python3 tests/runtests.py --settings=test_sqlite --parallel=1 -v1"
        f2p_labels, f2p_skipped = django_labels(f2p)
        p2p_labels, p2p_skipped = django_labels(p2p)
        if not f2p_labels:
            raise ValueError(f"{row['instance_id']}: FAIL_TO_PASS 无可解析条目: {f2p_skipped}")
        fail_cmds = [f"{base} {' '.join(f2p_labels)}"]
        pass_cmds = [f"{base} {' '.join(p2p_labels)}"] if p2p_labels else []
        return fail_cmds, pass_cmds, p2p_skipped

    if row["repo"] == "sympy/sympy":
        files = test_files_from_patch(row["test_patch"])
        if len(files) != 1:
            raise ValueError(f"{row['instance_id']}: 期望恰好 1 个测试文件，实际 {files}")
        test_file = files[0]
        f2p_ids = " ".join(f"{test_file}::{name}" for name in sorted(set(f2p)))
        fail_cmds = [f"python3 -m pytest -q --no-header {f2p_ids}"]
        pass_cmds = []
        if p2p:
            p2p_ids = " ".join(f"{test_file}::{name}" for name in sorted(set(p2p)))
            pass_cmds = [f"python3 -m pytest -q --no-header {p2p_ids}"]
        return fail_cmds, pass_cmds, []

    raise ValueError(f"不支持的仓库: {row['repo']}")


def fixture_id(instance_id: str) -> str:
    # django__django-15790 -> swb-django-15790
    repo, num = instance_id.split("__")
    return f"swb-{num}"


def to_task_yaml(row: dict) -> dict:
    repo_dir = "django" if row["repo"] == "django/django" else "sympy"
    fail_cmds, pass_cmds, skipped = build_commands(row)
    return {
        "id": fixture_id(row["instance_id"]),
        "title": f"SWE-bench Lite: {row['instance_id']}",
        "category": "swebench",
        "language": "python",
        "workdir": ".",
        "base_ref": row["base_commit"],
        "description": row["problem_statement"],
        "allowed_paths": ["**"],
        "setup": [],
        "static_check": [],
        "fail_to_pass": fail_cmds,
        "pass_to_pass": pass_cmds,
        "gold_patch": row["patch"],
        "acceptance_criteria": ACCEPTANCE_CRITERIA,
        "repo_path": str(SWEBENCH_REPOS / repo_dir),
        "test_patch": row["test_patch"],
        # 以下为溯源元数据（FixtureRegistry 不读取）
        "meta_swebench_instance": row["instance_id"],
        "meta_swebench_version": row["version"],
        "meta_skipped_pass_to_pass": skipped,
    }


def main() -> None:
    import pyarrow.parquet as pq

    ids = sys.argv[1:] or CANDIDATES
    rows = {r["instance_id"]: r for r in pq.read_table(PARQUET).to_pylist()}
    for instance_id in ids:
        row = rows.get(instance_id)
        if row is None:
            print(f"[skip] 数据集中不存在: {instance_id}")
            continue
        task = to_task_yaml(row)
        out_dir = FIXTURE_TASKS_DIR / task["id"]
        out_dir.mkdir(parents=True, exist_ok=True)
        out = out_dir / "task.yaml"
        out.write_text(
            yaml.safe_dump(task, allow_unicode=True, sort_keys=False, width=10_000),
            encoding="utf-8",
        )
        print(f"[ok] {instance_id} -> {out}  "
              f"(P2P 跳过 {len(task['meta_skipped_pass_to_pass'])} 条)")


if __name__ == "__main__":
    main()
