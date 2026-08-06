#!/usr/bin/env python3
"""Failure Taxonomy：按批次汇总失败归类与 token 分布（Markdown 输出）。

分类口径（failureCode → 类别）：
- 预算耗尽:   BUDGET_* （探索/迭代把预算烧满，Agent 能力或工具效率问题）
- 补丁质量:   VERIFY_TARGET_FAILED / VERIFY_REGRESSION_FAILED / VERIFY_STATIC_FAILED
- 治理拦截:   VERIFY_SCOPE_VIOLATION / VERIFY_TEST_TAMPERING
- 环境/故障:  SANDBOX_CRASHED / WORKER_LOST / MODEL_RATE_LIMIT / SANDBOX_SETUP_FAILED
- 卡死:       AGENT_STUCK

用法: uv run python scripts/failure_taxonomy.py [evaluationRunId ...]
      不带参数时汇总所有批次。
"""
import statistics
import sys

import psycopg

DSN = "postgresql://arp:arp@localhost:55432/arp"

CATEGORY = {
    "BUDGET_TOKENS_EXCEEDED": "预算耗尽",
    "BUDGET_TIME_EXCEEDED": "预算耗尽",
    "BUDGET_TURNS_EXCEEDED": "预算耗尽",
    "VERIFY_PATCH_MALFORMED": "补丁质量",
    "VERIFY_TARGET_TESTS_FAILED": "补丁质量",
    "VERIFY_REGRESSION_FAILED": "补丁质量",
    "VERIFY_STATIC_FAILED": "补丁质量",
    "VERIFY_SCOPE_VIOLATION": "治理拦截",
    "VERIFY_TEST_TAMPERING": "治理拦截",
    "PATCH_APPLY_FAILED": "补丁质量",
    "SANDBOX_CRASHED": "环境/故障",
    "SANDBOX_START_FAILED": "环境/故障",
    "WORKER_LOST": "环境/故障",
    "MODEL_RATE_LIMIT": "环境/故障",
    "MODEL_API_ERROR": "环境/故障",
    "MODEL_BAD_OUTPUT": "环境/故障",
    "TOOL_EXEC_ERROR": "环境/故障",
    "AGENT_STUCK": "卡死",
    "HUMAN_REJECTED": "人工拒绝",
    "CANCELLED_BY_USER": "人工取消",
}

QUERY = """
SELECT er."evaluationRunId", ev.suite, ev."agentKind"::text, ev."faultInjection",
       er."fixtureId", er.resolved, er.tokens, er."wallSeconds",
       (SELECT a."failureCode"::text FROM "Attempt" a
        WHERE a."runId" = er."runId" ORDER BY a.no DESC LIMIT 1) AS last_failure
FROM "EvaluationResult" er
JOIN "EvaluationRun" ev ON ev.id = er."evaluationRunId"
{where}
ORDER BY ev."startedAt", er."fixtureId"
"""


def fmt_tokens(values: list[int]) -> str:
    if not values:
        return "-"
    return f"{int(statistics.mean(values)/1000)}k/{int(statistics.median(values)/1000)}k"


def main() -> None:
    ids = sys.argv[1:]
    where = 'WHERE er."evaluationRunId" = ANY(%s)' if ids else ""
    with psycopg.connect(DSN) as conn:
        rows = conn.execute(QUERY.format(where=where), (ids,) if ids else None).fetchall()

    batches: dict[str, list] = {}
    for row in rows:
        batches.setdefault(row[0], []).append(row)

    print("| 批次 | suite/agent/fault | 解决 | 失败分类 | tokens 均值/中位（解决 vs 失败） |")
    print("| --- | --- | --- | --- | --- |")
    for batch_id, items in batches.items():
        _, suite, agent, fault, *_ = items[0][:5] + (None,) * 0
        suite, agent, fault = items[0][1], items[0][2], items[0][3]
        resolved = [r for r in items if r[5]]
        failed = [r for r in items if not r[5]]
        cats: dict[str, list[str]] = {}
        for r in failed:
            cat = CATEGORY.get(r[8] or "", r[8] or "未知")
            cats.setdefault(cat, []).append(r[4])
        cat_text = "; ".join(
            f"{cat}×{len(fx)}（{', '.join(fx)}）" for cat, fx in cats.items()
        ) or "-"
        print(f"| {batch_id[:12]} | {suite}/{agent}/{fault or 'none'} "
              f"| {len(resolved)}/{len(items)} | {cat_text} "
              f"| {fmt_tokens([r[6] for r in resolved])} vs {fmt_tokens([r[6] for r in failed])} |")


if __name__ == "__main__":
    main()
