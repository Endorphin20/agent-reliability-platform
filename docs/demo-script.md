# 5 分钟演示脚本

目标：让观众在 5 分钟内看到"可观测 -> 可恢复 -> 可治理 -> 可评测"闭环，
高潮是**现场杀沙箱后 Agent 从 checkpoint 续跑**。

## 演示前置（提前 10 分钟准备好）

```bash
docker compose up -d --wait
# 演示 GitHub 真实闭环时带上出站配置（可选，不带则 PR 为 mock URL）：
# GITHUB_ENABLED=true GITHUB_TOKEN=$(gh auth token) \
# GITHUB_REPO=<owner>/agent-fixture-repo GITHUB_WEBHOOK_SECRET=dev-webhook-secret \
pnpm -C apps/control-plane start:dev                            # :3801
(cd apps/agent-runtime && uv run python -m arp_runtime.worker)  # worker
pnpm -C apps/web dev                                            # :3000
```

- 浏览器开两个标签：`http://localhost:3000/tasks` 与 `http://localhost:3000/evaluations`；
- 终端准备好杀沙箱命令（RUN_ID 现场替换）：

```bash
docker rm -f $(docker ps -q --filter "label=arp.run_id=<RUN_ID>")
```

- 评测对比页需要有历史批次数据（提前跑过 fixture-12 各批次）。

## 第 0–1 分钟：问题定义 + 建任务

话术：「Agent 修 bug 的 demo 很多，但生产上的问题是：跑挂了怎么办？改错地方怎么拦？
两个 Agent 谁更划算怎么量化？这个平台回答这三个问题。」

操作：任务列表页点**新建任务**，选 `py-logic-001`（会议时段重叠判定 bug）+
自研 LangGraph Agent，创建后点进运行时间线。

## 第 1–2.5 分钟：可观测（时间线实时增长）

指给观众看：

- 事件流实时增长：MODEL_CALL（模型、token、耗时、轮次）、TOOL_CALL（工具与参数）、
  CHECKPOINT_SAVED（恢复的起点）；
- 顶部三条预算条（tokens / 秒 / 轮次）随 BUDGET_UPDATE 前进；
- 每个事件可点开看完整 payload——「出问题不用翻日志，事件溯源直接定位」。

## 第 2.5–3.5 分钟：可恢复（现场杀沙箱，高潮）

等时间线出现**第一个 CHECKPOINT_SAVED** 后，切终端执行杀沙箱命令。

指给观众看时间线上依次出现：

1. `FAILURE_DETECTED (SANDBOX_CRASHED)`——秒级判死，不让模型对着死沙箱烧 token；
2. `RECOVERY_ACTION (Policy -> RESUME)`——决策表自动决定恢复而非重跑/放弃；
3. Attempt #2 分段出现，前几个 TOOL_CALL 带 `cached=true`——
   「中断前已完成的工具调用不重复执行，从断点继续，不是从零重跑」。

话术：「同样这套机制还覆盖 worker 进程被杀（租约过期判活）和模型 429（指数退避），
e2e 脚本里三种故障注入全自动验收。」

## 第 3.5–4.5 分钟：可治理（审批页）

任务变 AWAITING_APPROVAL 后点**待审批**进审批页：

- V1–V6 门禁卡片：范围合规（只许改 allowedPaths）、测试防篡改（改测试=作弊直接拦）；
- LLM Judge 逐条评分：独立的 claude-opus-4-6 按验收条款打 0–5 分，只参考不否决；
- diff 全文核对后点**批准并创建 PR**，任务变 PR_CREATED——`GITHUB_ENABLED=true`
  时是**真实 GitHub PR**（推 `agent-fix/<taskId>` 分支 + REST 建 PR），且平台会
  自动回写评论到来源 issue。

## 加分环节（时间富余时）：GitHub CI 闭环

GitHub 到不了 localhost，用签名投递模拟 webhook（与真实投递字节级一致）：

```bash
BODY='{"action":"created","comment":{"body":"/arp run py-test-001"},"issue":{"html_url":"https://github.com/<owner>/agent-fixture-repo/issues/<N>"}}'
SIG="sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac dev-webhook-secret | awk '{print $2}')"
curl -s -X POST http://localhost:3801/api/github/webhook \
  -H 'content-type: application/json' -H 'x-github-event: issue_comment' \
  -H "x-hub-signature-256: $SIG" -d "$BODY"
```

指给观众看：issue 评论 `/arp run` -> 任务自动出现在列表 -> 修复完成审批后
真实 PR 建成 -> **平台自动回到 issue 评论 PR 链接**。话术：「从 issue 到 PR
再到回流通知，闭环没有断点；错误签名会被 HMAC 验签直接 401。」

## 第 4.5–5 分钟：可评测（评测对比页）

切评测对比页，指三组结论（数字以 docs/experiment-report.md 实测为准）：

- **双 Agent 对比**：自研 LangGraph vs mini-SWE-agent，解决率/成本/token 横比；
- **恢复消融**：同样注入 kill-sandbox，开恢复 vs 关恢复（`--no-recovery`）的解决率差
  ——「恢复机制值多少个百分点，量化出来」；
- **恢复粒度分组**：checkpoint 恢复（自研）与 attempt 重启（mini-SWE）分组展示，
  不做不公平横比；
- **Agent 迭代故事**（口头，配 failure-analysis.md）：SWE-bench 子集自研 v1
  6/12 输给 mini-SWE 9/12 -> 事件流取证归因 -> v2 修复后 10/12 反超且成本降
  34%——「平台可插拔 + 事件溯源，让 Agent 迭代变成一天闭环的可复现实验」。

收尾话术：「一句话总结：把 Agent 从'能跑的 demo'变成'敢上 CI 的系统'——
每一步可回放、挂了能续、改错能拦、好坏能量化。」

## 备用与兜底

- 若现场模型响应慢：提前录制一段完整视频备份；
- 若杀沙箱时机没赶上（run 已结束）：直接讲解已有历史 run 的恢复轨迹分段；
- e2e 完整验收（含三种故障注入）：`bash scripts/e2e.sh`，退出码 0 即全链路通过。
