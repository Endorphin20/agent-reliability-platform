#!/usr/bin/env bash
# 双 worker 并发演示（T4）：
#   Phase A —— 2 个 worker 竞争消费 6 个并发任务：验证租约互斥（无双重认领）、
#              统计每个 worker 的认领数与批总耗时；
#   Phase B —— 杀掉持有任务的 worker：验证租约过期 → WORKER_LOST → 另一个
#              worker 接管恢复（RESUME）；
#   Phase C —— XAUTOCLAIM 清理死 worker 僵尸 PEL + SIGTERM 优雅停机
#              （跑完当前 attempt 再退出，不触发 WORKER_LOST）。
# 前置：control-plane + postgres + redis 已就绪；无其他 worker 在跑
#      （脚本自己起两个 LLM_PROVIDER=fake 的 worker，跑完自动清理）。
set -euo pipefail

API=${API:-http://localhost:3801}
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUNTIME="$ROOT/apps/agent-runtime"
PY="$RUNTIME/.venv/bin/python"
PSQL="docker exec agent-reliability-platform-postgres-1 psql -U arp -d arp -t -A"
REDIS="docker exec agent-reliability-platform-redis-1 redis-cli"
TASKS=(ts-logic-001 ts-logic-002 ts-feature-001 py-logic-001 py-feature-001 py-dep-001)

cleanup() {
  kill "${W1_PID:-0}" "${W2_PID:-0}" 2>/dev/null || true
}
trap cleanup EXIT

fail() { echo "FAIL: $1"; exit 1; }

pgrep -f arp_runtime.worker >/dev/null && fail "已有 worker 在运行，请先停掉（避免抢任务污染演示）"
curl -sf "$API/api/health" >/dev/null || fail "control-plane 不可达"

start_worker() { # $1=worker_id  -> 输出 pid
  # 重定向必须套在整个子 shell 上：否则子 shell 继承命令替换的管道 fd，
  # $( ) 会一直等 EOF 直到 worker 退出
  # RECLAIM_*: 演示用加速值（生产默认 60s/30s）
  (cd "$RUNTIME" && exec env WORKER_ID="$1" LLM_PROVIDER=fake \
    RECLAIM_MIN_IDLE_MS=15000 RECLAIM_INTERVAL_S=5 \
    "$PY" -m arp_runtime.worker) >"/tmp/$1.log" 2>&1 &
  echo $!
}

echo "== Phase A: 双 worker 并发消费 =="
W1_PID=$(start_worker demo-w1)
W2_PID=$(start_worker demo-w2)
sleep 4

RUN_IDS=()
START=$(date +%s)
for fixture in "${TASKS[@]}"; do
  resp=$(curl -sf -X POST "$API/api/tasks" -H 'Content-Type: application/json' \
    -d "{\"fixtureId\":\"$fixture\",\"agentKind\":\"SELF_LANGGRAPH\"}")
  RUN_IDS+=("$(echo "$resp" | jq -r .runId)")
done
echo "已并发创建 ${#TASKS[@]} 个任务"

IN=$(printf "'%s'," "${RUN_IDS[@]}"); IN=${IN%,}
for _ in $(seq 1 120); do
  remaining=$($PSQL -c "SELECT count(*) FROM \"Run\" WHERE id IN ($IN)
    AND status NOT IN ('SUCCEEDED','FAILED','CANCELLED')")
  [ "$remaining" = "0" ] && break
  sleep 3
done
[ "$remaining" = "0" ] || fail "任务未在超时内全部终态（剩 $remaining）"
ELAPSED=$(( $(date +%s) - START ))

echo "-- 每个 worker 的认领分布 --"
$PSQL -F' | ' -c "SELECT \"workerId\", count(*) FROM \"Attempt\"
  WHERE \"runId\" IN ($IN) GROUP BY 1 ORDER BY 1"
DOUBLE=$($PSQL -c "SELECT count(*) FROM (SELECT \"runId\", no FROM \"Attempt\"
  WHERE \"runId\" IN ($IN) GROUP BY \"runId\", no HAVING count(*) > 1) d")
[ "$DOUBLE" = "0" ] || fail "出现双重认领 $DOUBLE 处（租约互斥失效）"
SUCCEEDED=$($PSQL -c "SELECT count(*) FROM \"Run\" WHERE id IN ($IN) AND status='SUCCEEDED'")
echo "结果: $SUCCEEDED/${#TASKS[@]} SUCCEEDED，总耗时 ${ELAPSED}s，无双重认领"
[ "$SUCCEEDED" = "${#TASKS[@]}" ] || fail "有任务未成功"

echo
echo "== Phase B: 杀 worker 租约接管 =="
resp=$(curl -sf -X POST "$API/api/tasks" -H 'Content-Type: application/json' \
  -d '{"fixtureId":"ts-logic-001","agentKind":"SELF_LANGGRAPH"}')
RUN_B=$(echo "$resp" | jq -r .runId)

owner=""
for _ in $(seq 1 30); do
  owner=$($PSQL -c "SELECT \"workerId\" FROM \"Attempt\" WHERE \"runId\"='$RUN_B'
    AND no=1 AND \"workerId\" IS NOT NULL LIMIT 1")
  [ -n "$owner" ] && break
  sleep 1
done
[ -n "$owner" ] || fail "任务未被认领"
if [ "$owner" = "demo-w1" ]; then VICTIM=$W1_PID; SURVIVOR=demo-w2; SURVIVOR_PID=$W2_PID
else VICTIM=$W2_PID; SURVIVOR=demo-w1; SURVIVOR_PID=$W1_PID; fi
kill -9 "$VICTIM"
echo "已杀掉持有者 ${owner} (幸存者 ${SURVIVOR})，等待租约过期与接管..."

for _ in $(seq 1 60); do
  status=$($PSQL -c "SELECT status FROM \"Run\" WHERE id='$RUN_B'")
  [ "$status" = "SUCCEEDED" ] && break
  sleep 3
done
[ "$status" = "SUCCEEDED" ] || fail "run 未恢复成功（当前 $status）"

echo "-- 恢复链路取证 --"
$PSQL -F' | ' -c "SELECT no, \"workerId\", status FROM \"Attempt\"
  WHERE \"runId\"='$RUN_B' ORDER BY no"
$PSQL -F' | ' -c "SELECT \"failureCode\", action FROM \"PolicyDecision\"
  WHERE \"runId\"='$RUN_B'"
takeover=$($PSQL -c "SELECT count(*) FROM \"Attempt\" WHERE \"runId\"='$RUN_B'
  AND \"workerId\"='$SURVIVOR'")
[ "$takeover" -ge 1 ] || fail "接管的 attempt 不属于幸存 worker"
echo "结果: ${owner} 被杀后 ${SURVIVOR} 接管并跑到 SUCCEEDED (WORKER_LOST -> RESUME)"

echo
echo "== Phase C1: XAUTOCLAIM 清理死 worker 的僵尸 PEL =="
# kill -9 的 worker 已消费但没来得及 ACK 的消息留在 PEL；幸存者周期 XAUTOCLAIM
# 接管后按 commandId 幂等判重直接 ACK（不重跑），pending 应归零
pending=""
for _ in $(seq 1 30); do
  pending=$($REDIS XPENDING run-commands runtime | head -1)
  [ "$pending" = "0" ] && break
  sleep 2
done
[ "$pending" = "0" ] || fail "僵尸 PEL 未被清理（仍有 $pending 条 pending）"
grep -c "XAUTOCLAIM 接管" "/tmp/$SURVIVOR.log" >/dev/null \
  || fail "幸存者日志中没有 XAUTOCLAIM 接管记录"
echo "结果: ${SURVIVOR} XAUTOCLAIM 接管死 consumer 消息，幂等判重后 ACK，PEL 归零"

echo
echo "== Phase C2: SIGTERM 优雅停机（跑完当前 attempt 再退出） =="
resp=$(curl -sf -X POST "$API/api/tasks" -H 'Content-Type: application/json' \
  -d '{"fixtureId":"ts-logic-002","agentKind":"SELF_LANGGRAPH"}')
RUN_C=$(echo "$resp" | jq -r .runId)

for _ in $(seq 1 30); do
  claimed=$($PSQL -c "SELECT count(*) FROM \"Attempt\" WHERE \"runId\"='$RUN_C'
    AND \"workerId\"='$SURVIVOR'")
  [ "$claimed" = "1" ] && break
  sleep 1
done
[ "$claimed" = "1" ] || fail "任务未被幸存 worker 认领"
kill -TERM "$SURVIVOR_PID"
echo "已向 ${SURVIVOR} 发送 SIGTERM（任务执行中），等待其跑完当前 attempt..."

for _ in $(seq 1 60); do
  status=$($PSQL -c "SELECT status FROM \"Run\" WHERE id='$RUN_C'")
  [ "$status" = "SUCCEEDED" ] && break
  sleep 3
done
[ "$status" = "SUCCEEDED" ] || fail "优雅停机窗口内 run 未完成（当前 $status）"

for _ in $(seq 1 15); do
  kill -0 "$SURVIVOR_PID" 2>/dev/null || break
  sleep 1
done
kill -0 "$SURVIVOR_PID" 2>/dev/null && fail "worker 收到 SIGTERM 后未退出"
LOST=$($PSQL -c "SELECT count(*) FROM \"PolicyDecision\" WHERE \"runId\"='$RUN_C'
  AND \"failureCode\"='WORKER_LOST'")
[ "$LOST" = "0" ] || fail "优雅停机不应触发 WORKER_LOST（出现 $LOST 次）"
echo "结果: SIGTERM 后 ${SURVIVOR} 跑完当前 attempt（SUCCEEDED）才退出，零 WORKER_LOST"

echo
echo "== MULTI-WORKER DEMO PASSED (A: 并发互斥  B: 租约接管  C: 优雅停机+XAUTOCLAIM) =="
