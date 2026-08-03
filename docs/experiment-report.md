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
