# 实验报告

实测日期：2026-08-03。三组实验的固化命令（在 `apps/agent-runtime` 下执行，串行一轮约 1.8 小时）：

```bash
uv run arp-eval run --suite fixture-12 --agent self                                          # 批次1 基线：自研 LangGraph
uv run arp-eval run --suite fixture-12 --agent mini-swe                                      # 批次2 对照：mini-SWE-agent
uv run arp-eval run --suite fixture-12 --agent self --fault-inject kill-sandbox              # 批次3 故障+恢复
uv run arp-eval run --suite fixture-12 --agent self --fault-inject kill-sandbox --no-recovery # 批次4 故障+禁恢复（消融）
uv run arp-eval run --suite fixture-12 --agent self --fault-inject kill-sandbox --feedback raw # 批次5 原始反馈（消融）
uv run arp-eval run --suite swebench --agent self                                             # 批次6 SWE-bench 子集：自研
uv run arp-eval run --suite swebench --agent mini-swe                                         # 批次7 SWE-bench 子集：mini-SWE
uv run arp-eval report                                                                        # 汇总
```

实验设置：

- 任务集：`agent-fixture-repo` 12 个金标 fixture（6 个 Python + 6 个 TypeScript，
  覆盖逻辑 bug / API 适配 / 依赖迁移 / 特性实现 / 测试修复 / 陷阱任务）；
  实验四另用 SWE-bench Lite 12 实例子集（接入设计见 docs/architecture.md §5）；
- Agent 模型 `gpt-5.5`，Judge 模型 `claude-opus-4-6`（独立上下文，按 acceptance_criteria 逐条 0–5 分）；
- 预算：200k tokens / 900s / 30 轮 per run；
- 成本为按公开定价近似的估算值，用于批次间相对比较；
- 故障注入：首个 CHECKPOINT_SAVED 后 `docker rm -f` 沙箱容器。

数据勘误：批次 1 的 `ts-api-001` 首轮因宿主机（macOS）进入空闲睡眠 15 分钟导致
worker 全线程冻结、租约误判过期而失败（`pmset -g log` 可复核睡眠时刻与 run 冻结
时刻吻合）。属环境故障而非 Agent 能力问题，已用相同配置单独重跑并替换该行
（重跑结果：一次通过，14,151 tokens / 41s）。后续批次已用 `caffeinate` 防睡眠。

## 实验一：双 Agent 对比（批次 1 vs 2，无故障注入）

| 指标 | 自研 LangGraph | mini-SWE-agent |
| --- | --- | --- |
| 解决率 | 12/12 (100%) | 12/12 (100%) |
| 首试成功率 | 100% | 100% |
| 越界改动数 | 0 | 0 |
| 均值 tokens | 17,552 | 10,605 |
| 均值耗时 (s) | 46 | 30 |
| 总成本 (USD) | $0.40 | $0.24 |
| Judge 均分 | 4.68 | 4.68 |

结论：在 12 个金标任务上两个 Agent 解决率打平、补丁质量（Judge 分）一致；
mini-SWE 的纯 bash 循环比自研的结构化工具集**省约 40% tokens**（无 read_file
全文回读、无结构化工具 schema 开销）。自研 Agent 换来的是 checkpoint 级可恢复性
与结构化 TOOL_CALL 事件（见实验二），这是"可靠性税"的直观定价。

## 实验二：恢复机制消融（批次 3 vs 4，同为 kill-sandbox 注入）

| 指标 | 开恢复（RESUME） | 禁恢复（--no-recovery，全 ABORT） |
| --- | --- | --- |
| 解决率 | **12/12 (100%)** | **0/12 (0%)** |
| 恢复成功率 | 100% | —（注入即终止） |
| 均值 tokens | 21,075 | 9,682（终止前已花费） |
| 总成本 (USD) | $0.45 | $0.30（全部打水漂） |
| Judge 均分 | 4.68 | —（无产出） |

结论：同样的沙箱强杀故障，恢复机制把解决率从 **0% 拉回 100%**，且与无故障基线
（$0.40）相比恢复只增加约 12% 成本（$0.45）——远低于整单重跑的代价；对照组花掉
的 $0.30 则全部沉没。恢复链路为 SANDBOX_CRASHED 秒级判死 → Policy RESUME →
LangGraph checkpoint 续跑 + completedToolCalls 幂等缓存（TOOL_CALL 事件带
`cached=true` 可在时间线上直接看到）。

注：恢复后 run 的 `wallSeconds` 只统计最后一个 attempt 的执行时间（前一 attempt
的时间在崩溃时丢失），因此批次 3 的均值耗时（13s）偏低，横向比较请以 tokens/成本为准。

## 实验三：反馈模式消融（批次 3 structured vs 批次 5 raw，同为 kill-sandbox 注入）

| 指标 | 结构化反馈 | 原始输出反馈（--feedback raw） |
| --- | --- | --- |
| 解决率 | 12/12 (100%) | 12/12 (100%) |
| 恢复成功率 | 100% | 100% |
| 均值 tokens | 21,075 | 26,128 |
| 总成本 (USD) | $0.45 | $0.59 |

结论：两种反馈都能恢复成功（checkpoint 保留了完整对话状态，反馈只是补充信号），
但结构化反馈（失败分类 + 失败步骤 + 定位建议）比裸贴原始输出**省约 19% tokens /
24% 成本**——原始输出迫使模型自行重新解析失败上下文，多花一轮左右的往返。

## 实验四：SWE-bench Lite 12 实例子集（批次 6 vs 7，无故障注入）

任务集：django(≥4.2) 8 实例 + sympy(≥1.11) 4 实例，全部通过金标验证
（`scripts/swebench_validate.py`：修复前 FAIL_TO_PASS 必失败、官方 gold patch
后必通过）。基准 test_patch 对 Agent 不可见，由 Verifier 在跑测试前应用、
跑完回滚。预算放宽至 400k tokens / 2400s / 50 轮 per run。

| 指标 | 自研 LangGraph | mini-SWE-agent |
| --- | --- | --- |
| 解决率 | 6/12 (50%) | **9/12 (75%)** |
| 首试成功率 | 50% | 67%（16046 回炉反馈后二次修复成功） |
| 越界改动数 | 0 | 0 |
| 均值 tokens | 230,311 | 104,241 |
| 均值耗时 (s) | 189 | 126 |
| 总成本 (USD) | $4.52 | $2.43 |
| Judge 均分（resolved runs） | 4.94 | 4.85 |

结论与讨论：

1. **真实基准把两个 Agent 拉开了**。自建 fixture 上双方都是 12/12，
   SWE-bench 子集上 mini-SWE 75% vs 自研 50%——mini-SWE 的纯 bash 循环
   （grep/sed/自由探索）在 django 这类大仓库里定位代码明显更高效；自研
   Agent 的结构化工具集（read_file 全文回读 + 固定 search_code）在大仓库
   探索上开销大、容易烧满预算（6 个失败 run 中 5 个耗尽约 400k tokens）。
   这印证了实验一的推断："可靠性税"在简单任务上只体现为 tokens 差价，
   在难任务上会直接吃掉解决率。
2. **两边共同失败的实例**（15819 / 23191 / 24909）问题陈述都偏含糊或涉及
   跨模块行为，属于子集里的真难题；15814 / 15851 / 16873 为自研独败，
   16046 为 mini-SWE 靠验证失败反馈回炉救回——平台的结构化反馈链路对
   attempt-restart 型 Agent 同样有效。
3. **诚实口径**：本子集只有 12 个经过筛选的近期实例（纯 Python、零编译
   依赖、金标可复现），解决率**不可与官方 SWE-bench Lite 排行榜横比**
   （官方 300 实例含大量老版本环境与更难仓库）。子集的价值在于：
   (a) 证明平台的执行/验证/评测链路能承接外部真实基准；
   (b) 提供比自建 fixture 更有区分度的 A/B 对比信号。
4. 两批次越界改动均为 0：V6 测试防篡改 + test_patch 不可见的组合下，
   24 个 run 没有出现改测试或碰基准测试文件的作弊行为。

## 实验五：失败分析驱动的 Agent v2（批次 8，2026-08-06）

对实验四的 6 个自研失败 run 做轨迹取证（方法与完整证据见
`docs/failure-analysis.md`），把失败拆解为两个平台缺陷 + 一个模型上限：

- **RC1 治理层可用性缺陷**（4/6）：guard 前缀白名单拒绝了任务要求「原样执行」
  的 `PYTHONPATH=... python3 ...` 测试命令，Agent 被堵死后 57–77% 的轮次耗在
  绕路试错上（15851 甚至试图自己写缺失的测试文件，被 V6 正确拦截）；
- **RC2 上下文膨胀**（1/6 主因，放大所有失败）：`read_file` 全文回读数千行
  文件 + 消息历史零修剪，每轮模型调用固定背 37–48k tokens；
- 1/6 为模型/任务难度上限（mini-SWE 同样失败）。

v2 修复（平台不动核心架构，只改工具与 Agent 策略）：guard 支持前导环境变量
赋值且拒绝消息附带白名单、`read_file` 行窗口 + 行号输出、消息历史修剪（旧
工具结果折叠为占位摘要，checkpoint 不受影响）、失败工具调用进 TOOL_CALL
事件（带 error 字段）。同配置重跑：

| 指标 | 自研 v1（批次 6） | **自研 v2（批次 8）** | mini-SWE（批次 7） |
| --- | --- | --- | --- |
| 解决率 | 6/12 (50%) | **10/12 (83%)** | 9/12 (75%) |
| 解决 run 均值 tokens | 113k | **98k**（中位 55k） | 66k |
| 均值耗时 (s) | 189 | 185 | 126 |
| 总成本 (USD) | $4.52 | $2.97 | $2.43 |
| Judge 均分（resolved） | 4.94 | 4.87 | 4.85 |
| 治理拦截类失败 | 1 | **0** | 0 |

结论：

1. **解决率 50% → 83%，反超 mini-SWE**，且总成本降 34%。翻盘的 4 个任务
   （15814 / 15819 / 15851 / 16873→部分）正是 RC1/RC2 归因的任务——修复
   见效与归因吻合，不是撞运气；
2. 仍失败的 2 个（16873 / 23191）都是预算线附近的边缘难度任务：16873 在
   独立冒烟中曾以 314k 解决、批次内 389k 超限，23191 是 mini-SWE 也未解开
   的最难实例；
3. 方法论价值：**平台可插拔 + 事件溯源让「Agent 迭代」成为可复现实验**——
   同一平台、同一基准、同一预算，只换工具与提示词策略，一轮迭代拿到可对比
   数据。失败取证 → 归因 → 修复 → 验证的完整闭环约一个工作日。

## 实验六：双 worker 并发与租约接管（`scripts/multi-worker-demo.sh`）

两个 worker（fake 模型，确定性）竞争消费：

- **并发分配**：6 个并发任务被两个 worker 各认领 3 个，34 秒全部 SUCCEEDED，
  attempt 表零双重认领（Redis NX 命令锁 + 控制面原子 claim 的互斥生效）；
- **租约接管**：`kill -9` 持有任务的 worker 后，租约过期 → attempt 1 标记
  `LEASE_EXPIRED`，PolicyDecision 记录 `WORKER_LOST → RESUME`，幸存 worker
  认领 attempt 2 从 checkpoint 续跑至 SUCCEEDED。

说明：水平扩展依赖的互斥/租约/幂等机制得到实测验证；单机双 worker 不构成
吞吐压测，容量规划需另做。

## 实验七：重复性检验（fixture-12 × 自研 v2 × 3 轮，2026-08-06）

同配置连续 3 轮，检验单轮结论的稳定性（均值 ± 样本标准差）：

| 指标 | 第 1 轮 | 第 2 轮 | 第 3 轮 | 汇总 |
| --- | --- | --- | --- | --- |
| 解决率 | 12/12 | 12/12 | 12/12 | **100%，零方差** |
| 首试成功率 | 100% | 100% | 100% | 100%，零方差 |
| 均值 tokens | 19,438 | 24,122 | 19,468 | 21,009 ± 2,696（CV 13%） |
| 均值耗时 (s) | 64 | 60 | 57 | 60 ± 3.5 |
| 批次成本 (USD) | $0.39 | $0.47 | $0.38 | $0.41 ± 0.05 |
| Judge 均分 | 4.68 | 4.68 | 4.68 | 4.68，零方差 |
| 越界改动 | 0 | 0 | 0 | 0 |

结论：解决率、首试成功率、Judge 分在 3 轮间零方差——金标 fixture 上的
结论性指标是稳定的；token/成本存在约 13% 的模型采样波动，横向比较时
差距小于此量级的不应过度解读（实验一 v1 的 17.5k 与本轮 v2 的 21.0k
即属同一噪声带，v2 的行窗口收益在小仓库任务上被行号前缀等开销抵消，
其价值体现在大仓库基准上，见实验五）。SWE-bench 子集因单批成本约 $3、
边缘任务波动更大（16873 两次结果不同），未做 3 轮重复，是已知局限。

## 恢复粒度分组说明（IM-06）

`recoveryMode` 两档分组统计、不直接横比：

- `checkpoint`（SELF_LANGGRAPH）：LangGraph PostgresSaver 恢复对话状态 +
  completedToolCalls 幂等缓存，从断点续跑；
- `attempt-restart`（MINI_SWE）：上游无 checkpoint 概念，恢复即新 attempt 从零重跑。
  其"恢复成功率"语义是"重跑成功率"，与 checkpoint 恢复不可比。
  （本轮故障注入实验仅跑了 SELF_LANGGRAPH；MINI_SWE 的故障恢复走
  attempt-restart 路径，在 e2e 与单测中验证。）

## Judge 抽查结论（抽 3 个 run 人工核对）

1. **ts-trap-001（批次 1，陷阱任务）**：Judge 三条全 5 分，逐条核对 diff 属实——
   补丁只把 `computeInterest` 内的 `truncate2` 调用换成 `Math.round`，共享的
   `truncate2` 本体未动（这正是陷阱点），评语与 diff 完全一致。
2. **py-api-001（批次 3，故障恢复后产出）**：Judge 给"对外语义一致"条款打 4 分，
   指出 `set_preference` 未用 try/except 包裹 put、写入异常时的返回语义与 v1 有
   细微偏差——这是 V1–V6 测试矩阵覆盖不到的语义层瑕疵，说明 Judge 提供了
   Verifier 之外的增量信号，且不是无脑满分。
3. **ts-logic-001（批次 2，mini-SWE 产出）**：Judge 两条全 5 分，"两处 > 改为 >="
   与 diff 一致。

未发现 Judge 与 Verifier 结论冲突的案例（所有 resolved run 的 V1–V6 全绿且
Judge ≥ 4 分）；Judge 分布 4–5 分、均值 4.68，有区分度。
