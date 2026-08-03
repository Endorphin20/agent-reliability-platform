"""LLM Judge（T10）：对通过 V1-V6 门禁的补丁按验收条款逐条打分。

设计约束（计划 §T10）：
- 独立模型独立上下文：JUDGE_LLM_* 配置与修复 Agent 分离（跨模型家族，
  降低同族自评偏好），单轮调用、无历史；
- 输入 = acceptance_criteria + 最终 diff + V4/V5 测试输出摘要；
- 输出 = 逐条 0-5 分 JSON（score + rationale）；
- 不否决：Judge 只产出报告供审批页参考，失败/超时不影响 Run 结果。
"""

import json
import logging
import re
import time
from typing import Any

from arp_runtime.config import get_settings

logger = logging.getLogger("arp.judge")

JUDGE_SYSTEM = """你是一个严格的代码评审官。你会看到：修复任务的验收条款、Agent 产出的最终补丁（unified diff）、以及定向测试（V4）与回归测试（V5）的执行输出摘要。

请对每条验收条款独立打分（0-5 整数）：
- 5 = 补丁完全满足该条款，实现方式正确且干净
- 3 = 基本满足但有瑕疵（实现绕路、边界处理存疑）
- 0 = 未满足或无法从证据判断

只输出 JSON（不要 markdown 代码围栏），格式：
{"criteria": [{"criterion": "<原文>", "score": <0-5>, "rationale": "<一句话依据>"}], "overallComment": "<一两句总评>"}"""


def _strip_fences(text: str) -> str:
    """剥离 ```json ... ``` 围栏（Claude 系模型即使被告知不要也常会带上）。"""
    match = re.search(r"```(?:json)?\s*(.*?)```", text, re.DOTALL)
    return match.group(1).strip() if match else text.strip()


def _test_output_summary(verification: list[dict[str, Any]]) -> str:
    parts: list[str] = []
    for result in verification:
        if result.get("step") in ("V4", "V5"):
            detail = json.dumps(result.get("detail", {}), ensure_ascii=False)
            parts.append(f"[{result['step']} passed={result['passed']}] {detail[:3000]}")
    return "\n".join(parts) or "(无测试输出)"


def judge_run(
    acceptance_criteria: list[str],
    diff: str,
    verification: list[dict[str, Any]],
) -> dict[str, Any] | None:
    """返回 Judge 报告 dict；未配置 Judge 模型或调用失败返回 None（不否决）。"""
    settings = get_settings()
    if not settings.judge_llm_model or not settings.judge_llm_api_key:
        logger.info("未配置 JUDGE_LLM_MODEL，跳过 Judge")
        return None
    if not acceptance_criteria:
        logger.info("任务无 acceptance_criteria，跳过 Judge")
        return None

    user_prompt = (
        "## 验收条款\n"
        + "\n".join(f"{i + 1}. {c}" for i, c in enumerate(acceptance_criteria))
        + f"\n\n## 最终补丁\n```diff\n{diff[:20000]}\n```"
        + f"\n\n## 测试输出（V4 定向 / V5 回归）\n{_test_output_summary(verification)}"
    )

    start = time.monotonic()
    try:
        from openai import OpenAI

        client = OpenAI(
            api_key=settings.judge_llm_api_key,
            base_url=settings.judge_llm_base_url or None,
            timeout=120,
            max_retries=1,
        )
        response = client.chat.completions.create(
            model=settings.judge_llm_model,
            messages=[
                {"role": "system", "content": JUDGE_SYSTEM},
                {"role": "user", "content": user_prompt},
            ],
            temperature=0,
        )
        raw = response.choices[0].message.content or ""
        report = json.loads(_strip_fences(raw))
        criteria = report.get("criteria")
        if not isinstance(criteria, list):
            raise ValueError(f"Judge 输出缺少 criteria 数组: {raw[:500]}")
        for item in criteria:
            item["score"] = max(0, min(5, int(item.get("score", 0))))
        return {
            "model": settings.judge_llm_model,
            "criteria": criteria,
            "overallComment": str(report.get("overallComment", "")),
            "latencyMs": int((time.monotonic() - start) * 1000),
        }
    except Exception as exc:  # noqa: BLE001 Judge 不否决：任何失败只记录不影响 Run
        logger.warning("Judge 调用失败（不影响 Run 结果）: %s", exc)
        return None
