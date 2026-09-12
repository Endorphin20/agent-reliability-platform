#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
for c in docker node pnpm python3 uv jq curl; do command -v "$c" >/dev/null || { echo "缺少依赖: $c" >&2; exit 1; }; done
docker info >/dev/null 2>&1 || { echo 'Docker 未运行，请先启动 Docker Desktop' >&2; exit 1; }
[ -f .env ] || cp .env.example .env
set -a; source .env; set +a
FIXTURE_REPO_PATH="$(cd "$ROOT" && cd "${FIXTURE_REPO_PATH:-../agent-fixture-repo}" 2>/dev/null && pwd || true)"
[ -n "$FIXTURE_REPO_PATH" ] || { echo '找不到 agent-fixture-repo，请放在项目同级目录' >&2; exit 1; }
python3 - <<PY
from pathlib import Path
p=Path('.env'); s=p.read_text(); import re
s=re.sub(r'^FIXTURE_REPO_PATH=.*$', 'FIXTURE_REPO_PATH=$FIXTURE_REPO_PATH', s, flags=re.M); p.write_text(s)
for target in ['apps/control-plane/.env','apps/agent-runtime/.env']:
 Path(target).write_text(s)
Path('apps/web/.env.local').write_text('NEXT_PUBLIC_API_BASE='+re.search(r'^NEXT_PUBLIC_API_BASE=(.*)$',s,re.M).group(1)+'\n')
PY
pnpm install
docker compose up -d --wait
pnpm -C apps/control-plane exec prisma migrate deploy
docker build -t arp-sandbox:latest infra/sandbox
touch .setup-complete
echo 'Setup 完成。运行 ./scripts/dev.sh 启动平台。'
