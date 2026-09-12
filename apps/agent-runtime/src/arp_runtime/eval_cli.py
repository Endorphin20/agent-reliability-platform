"""arp-eval：评测批次 CLI（T11）。

用法：
    arp-eval run --suite fixture-12 --agent self
    arp-eval run --suite fixture-12 --agent mini-swe
    arp-eval run --suite fixture-12 --agent self --fault-inject kill-sandbox
    arp-eval run --suite fixture-12 --agent self --fault-inject kill-sandbox --no-recovery
    arp-eval run --suite fixture-12 --agent self --feedback raw
    arp-eval report            # 汇总最近批次
    arp-eval report --id <evaluationRunId>

说明：
- 串行跑批：每个 fixture 走 POST /api/tasks 全链路（沙箱 + Verifier + Judge），
  轮询至终态后写一行 EvaluationResult；
- kill-sandbox 故障注入由本 CLI 执行（第 1 个 checkpoint 后 docker rm -f 容器，
  验证 SANDBOX_CRASHED -> Policy RESUME -> checkpoint 恢复闭环）；
- kill-worker / model-429 需要 worker 以 FAULT_INJECT=<mode> 启动（演示模式），
  本 CLI 只负责跑批与记录；
- recoveryMode 按 IM-06 记录：SELF_LANGGRAPH=checkpoint，MINI_SWE=attempt-restart，
  两者恢复粒度不同，报告分组展示、不直接横比。
"""

import json
import subprocess
import time
from typing import Any

import httpx
import typer

from arp_runtime.config import get_settings

app = typer.Typer(help="Agent Reliability Platform 评测 CLI", no_args_is_help=True)

AGENT_KIND = {"self": "SELF_LANGGRAPH", "mini-swe": "MINI_SWE"}
RECOVERY_MODE = {"SELF_LANGGRAPH": "checkpoint", "MINI_SWE": "attempt-restart"}

# 计价假设（USD / 1M tokens，输入价+输出价）；代理端点未提供计费口径，
# 按公开定价近似，用于批次间相对比较（绝对值仅供参考）
MODEL_PRICES: dict[str, tuple[float, float]] = {
    "gpt-5.5": (1.25, 10.0),
    "claude-opus-4-6": (5.0, 25.0),
}
DEFAULT_PRICE = (2.0, 8.0)

# Run 终态；INTERRUPTED + ESCALATE_HUMAN 也视为终态（等人工介入，评测记未解决）
TERMINAL_RUN = {"SUCCEEDED", "FAILED", "CANCELLED"}
POLL_INTERVAL_S = 5
RUN_TIMEOUT_S = 1500


def _client() -> httpx.Client:
    return httpx.Client(base_url=get_settings().control_plane_url, timeout=30.0)


# swebench 任务显著更重：预算与轮询超时单独放宽
SWEBENCH_BUDGET = {"budgetTokens": 400_000, "budgetSeconds": 2400, "budgetTurns": 50}
SWEBENCH_RUN_TIMEOUT_S = 3600


def _suite_fixtures(client: httpx.Client, suite: str) -> list[str]:
    fixtures = [f["id"] for f in client.get("/api/fixtures").json() if f["id"] != "fake"]
    handmade = sorted(f for f in fixtures if not f.startswith("swb-"))
    if suite == "fixture-12":
        return handmade
    if suite == "smoke":
        return handmade[:2]
    if suite == "swebench":
        return sorted(f for f in fixtures if f.startswith("swb-"))
    raise typer.BadParameter(f"未知 suite: {suite}（可选 fixture-12 | smoke | swebench）")


def _kill_sandbox_when_ready(client: httpx.Client, run_id: str, timeout_s: int = 300) -> bool:
    """等第 1 个 CHECKPOINT_SAVED 出现后强杀沙箱容器（有进度可恢复时注入才有意义）。"""
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        events = client.get(f"/api/runs/{run_id}/events", params={"type": "CHECKPOINT_SAVED"}).json()
        if events:
            result = subprocess.run(
                ["docker", "ps", "-q", "--filter", f"label=arp.run_id={run_id}"],
                capture_output=True, text=True, timeout=30,
            )
            container = result.stdout.strip().splitlines()
            if container:
                subprocess.run(["docker", "rm", "-f", container[0]],
                               capture_output=True, timeout=30)
                typer.echo(f"  [fault] 已强杀沙箱容器 {container[0]}（run={run_id}）")
                return True
            typer.echo("  [fault] checkpoint 已出现但容器已不在（可能刚好结束）")
            return False
        run = client.get(f"/api/runs/{run_id}").json()
        if run["status"] in TERMINAL_RUN:
            typer.echo("  [fault] run 已终态，放弃注入")
            return False
        time.sleep(2)
    return False


def _wait_terminal(client: httpx.Client, run_id: str, timeout_s: int = RUN_TIMEOUT_S) -> dict[str, Any]:
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        run = client.get(f"/api/runs/{run_id}").json()
        if run["status"] in TERMINAL_RUN:
            return run
        if run["status"] == "INTERRUPTED":
            decisions = run.get("policyDecisions", [])
            if decisions and decisions[-1]["action"] in ("ESCALATE_HUMAN", "ABORT"):
                return run
        time.sleep(POLL_INTERVAL_S)
    return client.get(f"/api/runs/{run_id}").json()


def _cost_usd(client: httpx.Client, run_id: str) -> float:
    """按 MODEL_CALL 事件的 prompt/completion tokens 与价格表估算成本。"""
    events = client.get(f"/api/runs/{run_id}/events", params={"type": "MODEL_CALL"}).json()
    total = 0.0
    for event in events:
        payload = event["payload"]
        # condenser 调用以 "<model>(condenser)" 标注，计价对齐底层模型
        model = str(payload.get("model", "")).split("/")[-1].removesuffix("(condenser)")
        input_price, output_price = MODEL_PRICES.get(model, DEFAULT_PRICE)
        total += payload.get("promptTokens", 0) / 1e6 * input_price
        total += payload.get("completionTokens", 0) / 1e6 * output_price
    return round(total, 4)


def _collect_result(
    client: httpx.Client, fixture_id: str, run_id: str, fault: str, agent_kind: str
) -> dict[str, Any]:
    timeout_s = SWEBENCH_RUN_TIMEOUT_S if fixture_id.startswith("swb-") else RUN_TIMEOUT_S
    run = _wait_terminal(client, run_id, timeout_s)
    resolved = run["status"] == "SUCCEEDED"
    attempts = run.get("attempts", [])
    scope_violations = sum(
        1 for v in run.get("verificationResults", [])
        if v["step"] == "V2" and not v["passed"]
    )
    judge_scores: dict[str, Any] = {}
    if resolved:
        judge_response = client.get(f"/api/runs/{run_id}/judge")
        if judge_response.status_code == 200:
            judge_scores = judge_response.json()
    wall_seconds = run.get("usedSeconds", 0)
    if not wall_seconds:
        # 失败/中断的 run 可能没有完整上报 usedSeconds，用时间戳兜底
        from datetime import datetime

        created = datetime.fromisoformat(run["createdAt"].replace("Z", "+00:00"))
        updated = datetime.fromisoformat(run["updatedAt"].replace("Z", "+00:00"))
        wall_seconds = max(0, int((updated - created).total_seconds()))
    return {
        "fixtureId": fixture_id,
        "runId": run_id,
        "resolved": resolved,
        "firstTrySuccess": resolved and len(attempts) == 1,
        "recovered": (resolved and len(attempts) > 1) if fault != "none" else None,
        "recoveryMode": RECOVERY_MODE[agent_kind] if fault != "none" else None,
        "scopeViolations": scope_violations,
        "tokens": run.get("usedTokens", 0),
        "costUsd": _cost_usd(client, run_id),
        "wallSeconds": wall_seconds,
        "judgeScores": judge_scores,
    }


@app.command()
def run(
    suite: str = typer.Option("fixture-12", help="任务集：fixture-12 | smoke | swebench"),
    agent: str = typer.Option(..., help="self | mini-swe"),
    fault_inject: str = typer.Option(
        "none", "--fault-inject", help="none | kill-sandbox | kill-worker | model-429"
    ),
    no_recovery: bool = typer.Option(
        False, "--no-recovery", help="禁用恢复（Policy 全 ABORT，实验二对照组）"
    ),
    feedback: str = typer.Option(
        "structured", help="RESUME 反馈模式：structured | raw（实验三）"
    ),
    tasks: str = typer.Option("", help="逗号分隔的 fixture id，覆盖 suite 选择"),
    label: str = typer.Option("", help="批次标签后缀（如 condense，用于区分 worker 侧配置）"),
) -> None:
    """串行跑一个评测批次，逐任务写 EvaluationResult。"""
    if agent not in AGENT_KIND:
        raise typer.BadParameter(f"未知 agent: {agent}（可选 self | mini-swe）")
    agent_kind = AGENT_KIND[agent]

    client = _client()
    fixture_ids = (
        [t.strip() for t in tasks.split(",") if t.strip()]
        if tasks else _suite_fixtures(client, suite)
    )

    suite_label = suite
    if no_recovery:
        suite_label += "+no-recovery"
    if feedback != "structured":
        suite_label += f"+feedback-{feedback}"
    if label:
        suite_label += f"+{label}"

    evaluation = client.post("/api/evaluations", json={
        "suite": suite_label,
        "agentKind": agent_kind,
        "faultInjection": None if fault_inject == "none" else fault_inject,
    }).json()
    evaluation_id = evaluation["id"]
    typer.echo(f"EvaluationRun {evaluation_id}: suite={suite_label} agent={agent_kind} "
               f"fault={fault_inject} 共 {len(fixture_ids)} 个任务")

    for index, fixture_id in enumerate(fixture_ids, 1):
        typer.echo(f"[{index}/{len(fixture_ids)}] {fixture_id} ...")
        created = client.post("/api/tasks", json={
            "fixtureId": fixture_id,
            "agentKind": agent_kind,
            "recoveryDisabled": no_recovery,
            "feedbackMode": feedback,
            **(SWEBENCH_BUDGET if fixture_id.startswith("swb-") else {}),
        }).json()
        run_id = created["runId"]

        if fault_inject == "kill-sandbox":
            _kill_sandbox_when_ready(client, run_id)

        row = _collect_result(client, fixture_id, run_id, fault_inject, agent_kind)
        client.post(f"/api/evaluations/{evaluation_id}/results", json=row)
        typer.echo(
            f"  -> resolved={row['resolved']} firstTry={row['firstTrySuccess']} "
            f"recovered={row['recovered']} tokens={row['tokens']} "
            f"cost=${row['costUsd']} wall={row['wallSeconds']}s"
        )

    client.post(f"/api/evaluations/{evaluation_id}/finish")
    typer.echo(f"批次完成：arp-eval report --id {evaluation_id}")


def _format_summary_row(evaluation: dict[str, Any]) -> str:
    summary = evaluation.get("summary") or {}
    if not summary:
        return "(无结果)"
    recovered = (
        f"{summary['recoveredRate'] * 100:.0f}%"
        if summary.get("recoveredRate") is not None else "-"
    )
    judge = (
        f"{summary['avgJudgeScore']:.2f}"
        if summary.get("avgJudgeScore") is not None else "-"
    )
    return (
        f"{summary['resolved']}/{summary['total']} 解决 "
        f"| 首试 {summary['firstTrySuccessRate'] * 100:.0f}% "
        f"| 恢复 {recovered} "
        f"| 越界 {summary['scopeViolations']} "
        f"| 均值 {summary['avgTokens']} tok / {summary['avgWallSeconds']}s "
        f"| 成本 ${summary['totalCostUsd']:.2f} "
        f"| Judge {judge}"
    )


@app.command()
def report(
    evaluation_id: str = typer.Option("", "--id", help="指定批次 id；缺省列出最近批次"),
    as_json: bool = typer.Option(False, "--json", help="输出原始 JSON"),
) -> None:
    """输出评测批次汇总表。"""
    client = _client()
    if evaluation_id:
        evaluation = client.get(f"/api/evaluations/{evaluation_id}").json()
        if as_json:
            typer.echo(json.dumps(evaluation, ensure_ascii=False, indent=2))
            return
        typer.echo(f"== {evaluation['suite']} | {evaluation['agentKind']} "
                   f"| fault={evaluation['faultInjection'] or 'none'} ==")
        typer.echo(_format_summary_row(evaluation))
        header = (f"{'fixture':<16} {'resolved':<9} {'firstTry':<9} {'recovered':<10} "
                  f"{'mode':<16} {'tokens':>8} {'cost':>8} {'wall':>6}")
        typer.echo(header)
        for row in evaluation["results"]:
            typer.echo(
                f"{row['fixtureId']:<16} {str(row['resolved']):<9} "
                f"{str(row['firstTrySuccess']):<9} {str(row['recovered']):<10} "
                f"{str(row['recoveryMode'] or '-'):<16} {row['tokens']:>8} "
                f"{float(row['costUsd']):>8.3f} {row['wallSeconds']:>5}s"
            )
        return

    evaluations = client.get("/api/evaluations").json()
    if as_json:
        typer.echo(json.dumps(evaluations, ensure_ascii=False, indent=2))
        return
    if not evaluations:
        typer.echo("暂无评测批次")
        return
    for evaluation in evaluations:
        fault = evaluation["faultInjection"] or "none"
        typer.echo(f"{evaluation['id']}  {evaluation['suite']:<28} "
                   f"{evaluation['agentKind']:<15} fault={fault:<13} "
                   f"{_format_summary_row(evaluation)}")


if __name__ == "__main__":
    app()
