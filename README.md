# Agent Reliability & Governance Platform

面向 CI/CD 场景的**可观测、可评测、可恢复**代码诊断与修复 Agent 平台。

一句话：把"Agent 修 bug"从黑盒脚本变成有事件溯源、有六步门禁、有 LLM 评审、
崩了能从 checkpoint 续跑、还能拿 12 个金标任务做 A/B 评测的工程系统。

> **未生产化声明**：本项目是可靠性工程能力的展示型实现。鉴权/多租户/水平扩展等
> 生产要素做了明确裁剪（详见 [docs/architecture.md](docs/architecture.md) 的边界一节）。
> 沙箱逃逸防护依赖 Docker 默认隔离，不承诺对抗恶意负载。

## 核心能力

| 能力 | 实现 |
| --- | --- |
| 可观测 | 15 类 TraceEvent 事件溯源（MODEL_CALL / TOOL_CALL / CHECKPOINT_SAVED / RECOVERY_ACTION…），Run 级严格递增 sequence，SSE 实时推送到前端时间线 |
| 可恢复 | 三种故障注入（kill 沙箱 / kill worker / 模型 429）全部自动恢复：租约心跳判活、Policy 决策表（RESUME/RETRY/ESCALATE/ABORT）、LangGraph PostgresSaver checkpoint 续跑、已完成工具调用幂等缓存（`cached=true`） |
| 可评测 | `arp-eval` CLI 对 12 个金标 fixture 跑批：自研 LangGraph Agent vs mini-SWE-agent 双 Agent 对比、故障注入 ± 恢复消融、结构化 vs 原始反馈消融；LLM Judge（独立模型 claude-opus-4-6）按验收条款逐条打分 |
| 可治理 | V1–V6 六步 Verifier 门禁（补丁形态/改动范围/静态检查/定向测试/回归测试/作弊检测）+ 人工审批后才建 PR |

## 架构总览

```
apps/web            Next.js 前端：任务列表 / 运行时间线 / 审批 diff / 评测对比
apps/control-plane  NestJS 控制面：任务生命周期、租约、Policy Engine、审批、SSE、评测 API
apps/agent-runtime  Python worker：双 Agent 适配器、Docker 沙箱、Verifier、LLM Judge、arp-eval
packages/shared     TS/Python 双端契约：zod schema + JSON Schema + 契约测试 fixture
infra/sandbox       arp-sandbox 镜像（node + python + uv，默认断网）
scripts/e2e.sh      端到端验收：主链路 + 三种故障恢复 + smoke 评测一次跑通
```

详细设计（mermaid 架构图 + 事件流 + 恢复时序）见 [docs/architecture.md](docs/architecture.md)。

## 环境矩阵

| 依赖 | 版本 | 用途 |
| --- | --- | --- |
| Node.js / pnpm | ≥ 20 / ≥ 11 | control-plane、web、shared |
| Python / uv | ≥ 3.12 | agent-runtime worker 与 arp-eval |
| Docker | ≥ 24 | postgres/redis（compose）+ 沙箱容器 |
| PostgreSQL | 16（容器） | 业务库 + LangGraph checkpoint |
| Redis | 7（容器） | run-commands 队列 + SSE pub/sub |
| LLM 端点 | OpenAI 兼容 | Agent 用 `gpt-5.5`，Judge 用 `claude-opus-4-6`（可换） |

## 快速开始

```bash
# 0) 依赖：docker、pnpm、uv、jq；克隆本仓库和同级的 agent-fixture-repo
docker compose up -d --wait

# 1) 安装 + 迁移
pnpm install
pnpm -C apps/control-plane exec prisma migrate deploy
docker build -t arp-sandbox:latest infra/sandbox

# 2) 配置 LLM（apps/agent-runtime/.env，参考 .env.example）
#    LLM_MODEL=gpt-5.5  JUDGE_LLM_MODEL=claude-opus-4-6  LLM_API_KEY=...

# 3) 起三个进程
pnpm -C apps/control-plane start:dev                       # 控制面 :3801
(cd apps/agent-runtime && uv run python -m arp_runtime.worker)  # worker
pnpm -C apps/web dev                                       # 前端 :3000

# 4) 创建一个修复任务（也可以在前端页面点"新建任务"）
curl -X POST localhost:3801/api/tasks -H 'Content-Type: application/json' \
  -d '{"fixtureId":"py-logic-001","agentKind":"SELF_LANGGRAPH"}'
```

打开 http://localhost:3000 看时间线实时增长；跑完进入审批页核对 diff + Judge 评分。

## 一键验收与评测

```bash
bash scripts/e2e.sh          # 端到端验收（主链路 + 3 种故障恢复 + smoke 评测），退出码 0 即通过

cd apps/agent-runtime        # 完整评测（三组实验，命令与结论见 docs/experiment-report.md）
uv run arp-eval run --suite fixture-12 --agent self
uv run arp-eval run --suite fixture-12 --agent mini-swe
uv run arp-eval run --suite fixture-12 --agent self --fault-inject kill-sandbox
uv run arp-eval run --suite fixture-12 --agent self --fault-inject kill-sandbox --no-recovery
uv run arp-eval run --suite fixture-12 --agent self --fault-inject kill-sandbox --feedback raw
uv run arp-eval report       # 汇总表
```

## 测试

```bash
pnpm -r test                                     # web / control-plane / shared（含双端契约测试）
(cd apps/agent-runtime && uv run python -m pytest)
```

## 文档

- [docs/architecture.md](docs/architecture.md) —— 架构图、事件流、恢复时序、裁剪边界
- [docs/experiment-report.md](docs/experiment-report.md) —— 三组实验数据 + Judge 抽查结论
- [docs/demo-script.md](docs/demo-script.md) —— 5 分钟演示脚本（含现场杀沙箱环节）
