#!/usr/bin/env python3
"""拉取失败 run 的轨迹并汇总：工具调用序列、token 增长、失败模式。

用法: python3 scripts/analyze_failures.py <runId> [<runId> ...]
"""
import json
import sys
import urllib.request

API = "http://localhost:3801"


def fetch(path: str):
    with urllib.request.urlopen(API + path) as resp:
        return json.load(resp)


def summarize_args(tool: str, args: dict) -> str:
    if tool == "read_file":
        return args.get("path", "?")
    if tool == "search_code":
        return f"pattern={args.get('pattern', '')!r} glob={args.get('glob', '')!r}"
    if tool == "run_command":
        return (args.get("command") or "")[:100]
    if tool == "apply_patch":
        # TOOL_CALL 事件只记录补丁摘要（补丁本体在 checkpoint 消息里）
        return f"patchDigest={args.get('patchDigest', '?')}"
    return json.dumps(args, ensure_ascii=False)[:100]


def analyze(run_id: str):
    tool_events = fetch(f"/api/runs/{run_id}/events?type=TOOL_CALL")
    budget_events = fetch(f"/api/runs/{run_id}/events?type=BUDGET_UPDATE")
    model_events = fetch(f"/api/runs/{run_id}/events?type=MODEL_CALL")

    print(f"\n{'=' * 80}\nRUN {run_id}")
    print(f"tool_calls={len(tool_events)} model_calls={len(model_events)}")

    # token 增长曲线：每轮增量
    prev = 0
    deltas = []
    for ev in budget_events:
        used = ev["payload"].get("usedTokens", 0)
        deltas.append(used - prev)
        prev = used
    print(f"total_tokens={prev}")
    print("token deltas per round:", deltas)

    # 工具调用序列
    print("\ntool sequence:")
    for i, ev in enumerate(tool_events):
        p = ev["payload"]
        tool = p.get("tool")
        delta = deltas[i] if i < len(deltas) else "?"
        print(f"  [{i + 1}] +{delta} tok  {tool}: {summarize_args(tool, p.get('args', {}))}")

    # 模型调用的输入 token（如果有）
    in_tokens = [e["payload"].get("inputTokens") for e in model_events if e["payload"].get("inputTokens")]
    if in_tokens:
        print(f"\nmodel input tokens: min={min(in_tokens)} max={max(in_tokens)} last={in_tokens[-1]}")


if __name__ == "__main__":
    for rid in sys.argv[1:]:
        analyze(rid)
