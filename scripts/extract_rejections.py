#!/usr/bin/env python3
"""从 LangGraph checkpoint 里抽取 guard 拒绝的命令（TOOL_CALL 事件里看不到）。

用法: uv run python scripts/extract_rejections.py <runId> [...]
"""
import re
import sys

import psycopg

DSN = "postgresql://arp:arp@localhost:55432/arp"
REJECT_RE = re.compile(r"命令被拒绝: ([^:]+): (.{0,160})")


def extract(run_id: str) -> None:
    with psycopg.connect(DSN) as conn:
        rows = conn.execute(
            "SELECT blob FROM checkpoint_blobs WHERE thread_id = %s", (run_id,)
        ).fetchall()
    seen: dict[str, str] = {}
    for (blob,) in rows:
        text = bytes(blob).decode("utf-8", errors="replace")
        for m in REJECT_RE.finditer(text):
            reason, cmd = m.group(1), m.group(2).split("\\n")[0].strip()
            seen.setdefault(cmd, reason)
    print(f"\n== RUN {run_id}: {len(seen)} 条互异被拒命令 ==")
    for cmd, reason in seen.items():
        print(f"  [{reason}] {cmd[:140]}")


if __name__ == "__main__":
    for rid in sys.argv[1:]:
        extract(rid)
