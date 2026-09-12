# One Command Startup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 让任意用户通过统一 `.env`、`setup.sh`、`dev.sh` 在本机启动平台，并支持无 LLM Key 的 mock 演示。

**Architecture:** 根目录配置作为唯一入口；setup 负责依赖、基础设施、应用配置、迁移和 sandbox；dev 负责三个进程、日志、健康检查与清理；运行时通过 MOCK_MODE 绕过真实模型调用。

**Tech Stack:** Bash, Docker Compose, pnpm, uv, NestJS, Next.js, Python worker.

---

### Task 1: 统一环境配置

**Files:** `.env.example`, `apps/control-plane/.env.example`, `apps/agent-runtime/.env.example`, `apps/web/.env.example`

- [ ] 将根配置定义为数据库、Redis、端口、路径、LLM 和 `MOCK_MODE` 的唯一模板。
- [ ] 删除个人绝对路径，使用 `FIXTURE_REPO_PATH=../agent-fixture-repo`。
- [ ] 让各应用模板只保留可由脚本生成的必要变量。

### Task 2: 添加 setup.sh

**Files:** Create `scripts/setup.sh`

- [ ] 使用 `set -euo pipefail`，定位脚本根目录。
- [ ] 检查 docker、node、pnpm、python3、uv、jq、curl。
- [ ] 检查 Docker daemon 和 fixture repo。
- [ ] 从根 `.env` 生成各应用 `.env` 文件并解析绝对路径。
- [ ] 执行 `pnpm install`、`uv sync`、compose 启动、Prisma migration、sandbox build。
- [ ] 输出 mock 与真实 LLM 的下一步命令。

### Task 3: 添加 dev.sh 与 stop.sh

**Files:** Create `scripts/dev.sh`, `scripts/stop.sh`

- [ ] dev 检查 setup 标记和端口占用。
- [ ] 后台启动 control-plane、worker、web，写入 `.dev-logs` 和 PID 文件。
- [ ] 等待 `/api/health` 与前端端口可用后输出访问地址。
- [ ] trap 清理自身子进程；stop 支持通过 PID 文件停止全部服务。

### Task 4: 支持 mock 模式

**Files:** `apps/agent-runtime/src/arp_runtime/config.py`, LLM/agent 调用模块及必要测试

- [ ] 增加 `MOCK_MODE` 配置项，默认 true。
- [ ] mock 模式返回固定、可重复的 demo 模型结果，不访问外部 API。
- [ ] 保持真实模式行为不变。
- [ ] 增加配置解析和 mock 调用测试。

### Task 5: 更新文档与验证

**Files:** `README.md`, `docs/demo-script.md`

- [ ] 将快速开始改为 clone、cp、setup、dev 四步。
- [ ] 说明 mock 模式、真实 LLM 模式、停止服务、清理数据和常见错误。
- [ ] 运行 shellcheck（若可用）、脚本 dry-run、单元测试和服务健康检查。
