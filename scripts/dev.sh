#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
[ -f .setup-complete ] || { echo '请先运行 ./scripts/setup.sh' >&2; exit 1; }
mkdir -p .dev-logs .dev-pids
for p in 3000 3801; do (curl -s "http://localhost:$p" >/dev/null 2>&1) && { echo "端口 $p 已被占用" >&2; exit 1; } || true; done
cleanup(){ ./scripts/stop.sh >/dev/null 2>&1 || true; }; trap cleanup INT TERM EXIT
(cd apps/control-plane && pnpm start:dev >"$ROOT/.dev-logs/control-plane.log" 2>&1 & echo $! >"$ROOT/.dev-pids/control-plane.pid")
(cd apps/agent-runtime && uv run python -m arp_runtime.worker >"$ROOT/.dev-logs/worker.log" 2>&1 & echo $! >"$ROOT/.dev-pids/worker.pid")
(cd apps/web && pnpm dev >"$ROOT/.dev-logs/web.log" 2>&1 & echo $! >"$ROOT/.dev-pids/web.pid")
for i in {1..60}; do curl -sf http://localhost:3801/api/health >/dev/null 2>&1 && break; sleep 1; done
curl -sf http://localhost:3801/api/health >/dev/null || { echo 'control-plane 启动失败，查看 .dev-logs' >&2; exit 1; }
echo '平台已启动: http://localhost:3000'; wait
