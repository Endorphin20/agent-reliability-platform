#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
pnpm -C packages/shared build
pnpm -C apps/control-plane build
apps/agent-runtime/.venv/bin/python scripts/local_pr_e2e.py
