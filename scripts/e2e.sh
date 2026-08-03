#!/usr/bin/env bash
# 端到端验收脚本（计划 §9）：基础设施 -> 全量测试 -> 主链路 -> 三种故障注入恢复
# -> smoke 评测 -> 容器清理断言。一次执行：bash scripts/e2e.sh
#
# 约定：
# - 脚本自己后台拉起 control-plane 与 worker，日志/pid 落 .e2e-logs/，退出 trap 清理；
# - 要求 3801 端口空闲（先停掉手动起的 dev 服务，避免双 worker 抢占 attempt）；
# - 人工观察步骤（前端时间线、演示话术）见 docs/demo-script.md，不在本脚本；
# - 评测环节只跑 smoke suite 控制时长，完整 fixture-12 命令固化在 docs/experiment-report.md。
set -euo pipefail

for cmd in jq docker pnpm uv curl; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "missing prerequisite: $cmd" >&2; exit 1; }
done

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
API="http://localhost:3801"
LOG_DIR="$ROOT/.e2e-logs"
mkdir -p "$LOG_DIR"

if curl -sf "$API/api/health" >/dev/null 2>&1; then
  echo "ERROR: $API 已有服务在运行。请先停掉手动启动的 control-plane/worker 再跑 e2e" >&2
  echo "（脚本需要独占 worker 生命周期来演示 kill-worker 恢复）" >&2
  exit 1
fi

cleanup() {
  stop_worker
  [ -f "$LOG_DIR/cp.pid" ] && kill "$(cat "$LOG_DIR/cp.pid")" 2>/dev/null || true
}
trap cleanup EXIT

jqr() { curl -sf "$1" | jq -r "$2"; }

wait_eq() { # wait_eq <url> <jq_expr> <expected> <timeout_s>
  local t=0
  until [ "$(jqr "$1" "$2" 2>/dev/null || echo __unready__)" = "$3" ]; do
    sleep 5; t=$((t + 5))
    if [ "$t" -ge "$4" ]; then echo "TIMEOUT: $1 $2 != $3" >&2; exit 1; fi
  done
}

create_task() { # create_task <fixtureId> <agentKind>；输出 "taskId runId"
  curl -sf -X POST "$API/api/tasks" -H 'Content-Type: application/json' \
    -d "{\"fixtureId\":\"$1\",\"agentKind\":\"$2\"}" | jq -r '"\(.taskId) \(.runId)"'
}

start_worker() { # start_worker [额外环境变量，如 FAULT_INJECT=model-429]
  (cd "$ROOT/apps/agent-runtime" && \
    env "$@" nohup uv run python -m arp_runtime.worker \
      >>"$LOG_DIR/worker.log" 2>&1 & echo $! >"$LOG_DIR/worker.pid")
  sleep 3
}

stop_worker() {
  # pid 文件记录的是 uv 包装进程；python 子进程会成为孤儿继续消费，必须 pkill 连根杀
  [ -f "$LOG_DIR/worker.pid" ] && kill -9 "$(cat "$LOG_DIR/worker.pid")" 2>/dev/null || true
  pkill -9 -f "python.? -m arp_runtime[.]worker" 2>/dev/null || true
  sleep 1
}

echo "== 1. 基础设施与迁移 =="
(cd "$ROOT" && docker compose up -d --wait)
pnpm -C "$ROOT/apps/control-plane" exec prisma migrate deploy
docker build -t arp-sandbox:latest "$ROOT/infra/sandbox"
# 清掉上次运行残留的队列命令，保证本次 e2e 从干净的流开始（消费组由 worker 启动时重建）
(cd "$ROOT" && docker compose exec -T redis redis-cli DEL run-commands >/dev/null) || true

echo "== 2. 起服务 =="
(cd "$ROOT/apps/control-plane" && nohup pnpm start:dev \
  >>"$LOG_DIR/control-plane.log" 2>&1 & echo $! >"$LOG_DIR/cp.pid")
wait_eq "$API/api/health" '.status' 'ok' 120
start_worker

echo "== 3. 全量测试 =="
(cd "$ROOT" && pnpm -r test)
(cd "$ROOT/apps/agent-runtime" && uv run python -m pytest -q)

echo "== 4. 主链路：创建 -> 修复 -> Verifier -> 审批 -> mock PR =="
read -r TASK_ID RUN_ID <<<"$(create_task ts-logic-001 SELF_LANGGRAPH)"
echo "task=$TASK_ID run=$RUN_ID"
wait_eq "$API/api/tasks/$TASK_ID" '.status' 'AWAITING_APPROVAL' 900
APPROVAL_ID="$(jqr "$API/api/tasks/$TASK_ID" '.approval.id')"
curl -sf -X POST "$API/api/approvals/$APPROVAL_ID/decide" \
  -H 'Content-Type: application/json' -d '{"decision":"APPROVED"}' >/dev/null
wait_eq "$API/api/tasks/$TASK_ID" '.status' 'PR_CREATED' 60
echo "PR URL: $(jqr "$API/api/tasks/$TASK_ID" '.approval.prUrl')"   # dev 为 mock URL

echo "== 5a. 故障注入：kill 沙箱（SANDBOX_CRASHED -> RESUME -> checkpoint 续跑） =="
read -r TASK_ID RUN_ID <<<"$(create_task ts-logic-001 SELF_LANGGRAPH)"
echo "task=$TASK_ID run=$RUN_ID"
wait_eq "$API/api/runs/$RUN_ID" '.status' 'RUNNING' 120
# 等第一个 checkpoint 出现再杀，确保恢复有起点
wait_eq "$API/api/runs/$RUN_ID/events?type=CHECKPOINT_SAVED" 'length >= 1 | tostring' 'true' 300
docker rm -f "$(docker ps -q --filter "label=arp.run_id=$RUN_ID" | head -1)"
wait_eq "$API/api/runs/$RUN_ID" '.status' 'SUCCEEDED' 900
RECOVERY="$(jqr "$API/api/runs/$RUN_ID/events?type=RECOVERY_ACTION" 'length')"
[ "$RECOVERY" -gt 0 ] || { echo "FAIL: kill-sandbox 后无 RECOVERY_ACTION 事件" >&2; exit 1; }
# cached 命中数仅供参考：取决于崩溃时该轮 tool_calls 的完成情况，非确定性
echo "recovery actions: $RECOVERY, cached tool calls: $(jqr \
  "$API/api/runs/$RUN_ID/events?type=TOOL_CALL" \
  '[.[] | select(.payload.cached == true)] | length')"

echo "== 5b. 故障注入：kill worker（LEASE_EXPIRED -> WORKER_LOST -> RESUME + 缓存命中） =="
stop_worker
start_worker FAULT_INJECT=kill-worker   # 首个含补丁的 checkpoint 后 os._exit(137)
read -r TASK_ID RUN_ID <<<"$(create_task ts-logic-001 SELF_LANGGRAPH)"
echo "task=$TASK_ID run=$RUN_ID"
# 不等 INTERRUPTED 状态（Policy 立即决策 RESUME，该状态只存在一瞬会被轮询漏掉），
# 等 append-only 的 RECOVERY_ACTION 事件（LEASE_TTL_MS=30s 判定 + 余量）
wait_eq "$API/api/runs/$RUN_ID/events?type=RECOVERY_ACTION" 'length >= 1 | tostring' 'true' 300
start_worker
wait_eq "$API/api/runs/$RUN_ID" '.status' 'SUCCEEDED' 900
# 确定性断言：apply_patch 已进 completedToolCalls 而 LangGraph 未持久化该节点，
# 恢复重放必命中幂等缓存（§4.5）
CACHED="$(jqr "$API/api/runs/$RUN_ID/events?type=TOOL_CALL" \
  '[.[] | select(.payload.cached == true)] | length')"
[ "$CACHED" -gt 0 ] || { echo "FAIL: kill-worker 恢复后无 cached 工具调用" >&2; exit 1; }
echo "cached tool calls: $CACHED"

echo "== 5c. 故障注入：模型 429（限流归一化 -> Policy 退避重试） =="
stop_worker
start_worker FAULT_INJECT=model-429   # LLM 客户端第 3 次调用抛一次 429
read -r TASK_ID RUN_ID <<<"$(create_task ts-logic-001 SELF_LANGGRAPH)"
echo "task=$TASK_ID run=$RUN_ID"
wait_eq "$API/api/runs/$RUN_ID" '.status' 'SUCCEEDED' 900
RECOVERY="$(jqr "$API/api/runs/$RUN_ID/events?type=RECOVERY_ACTION" 'length')"
[ "$RECOVERY" -gt 0 ] || { echo "FAIL: 429 后无 RECOVERY_ACTION 事件" >&2; exit 1; }
echo "recovery actions: $RECOVERY"
stop_worker
start_worker

echo "== 6. 评测 smoke（双 Agent 各跑 2 个 fixture） =="
(cd "$ROOT/apps/agent-runtime" && uv run arp-eval run --suite smoke --agent self)
(cd "$ROOT/apps/agent-runtime" && uv run arp-eval run --suite smoke --agent mini-swe)
(cd "$ROOT/apps/agent-runtime" && uv run arp-eval report)

echo "== 7. 清理断言：无残留沙箱容器 =="
LEFT="$(docker ps -a --filter label=arp.run_id --format '{{.ID}}')"
[ -z "$LEFT" ] || { echo "FAIL: 残留沙箱容器: $LEFT" >&2; exit 1; }

echo "E2E PASSED"
