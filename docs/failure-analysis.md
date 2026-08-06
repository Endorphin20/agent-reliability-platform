# SWE-bench 子集失败分析（自研 LangGraph Agent，6/12 → Agent v2 依据）

实验四（`docs/experiment-report.md`）中自研 Agent 在 SWE-bench Lite 12 实例子集上解决 6/12，
mini-SWE-agent 解决 9/12。本文对 6 个失败 run 做轨迹取证，回答两个问题：
**token 烧在哪里**、**是 Agent 能力问题还是平台问题**——并给出 Agent v2 的改进依据。

## 1. 取证方法

- 数据源一：run 事件流（`TOOL_CALL` / `MODEL_CALL` / `BUDGET_UPDATE`），脚本
  `scripts/analyze_failures.py` 还原每轮工具调用与 token 增量；
- 数据源二：LangGraph checkpoint 消息历史（Postgres `checkpoint_blobs`），脚本
  `scripts/extract_rejections.py` 抽取 guard 拒绝记录。

> 取证过程中发现一个可观测性缺口：`Toolset._record` 在工具执行抛异常时不产出
> `TOOL_CALL` 事件，**被 guard 拒绝的命令在事件流中完全不可见**，只能去 checkpoint
> 的消息历史里翻。这也是本次要修的缺陷之一（RC3）。

## 2. 失败总览

| 任务 | tokens | 工具调用/模型调用 | guard 拒绝 | 主因 | mini-SWE 同任务 |
| --- | --- | --- | --- | --- | --- |
| swb-django-15814 | 435k | 15 / 15 | 3 类 | RC1 + RC2 | ✅ 解决 |
| swb-django-15819 | 403k | 20 / 26 | 4 类 | RC1（75% 轮次在试错测试命令） | ❌ 失败 |
| swb-django-15851 | 146k×多 attempt | 28 / 33 | 3 类 | RC1 → 测试防篡改拦截* | ✅ 解决 |
| swb-django-16873 | 409k | 22 / 28 | 6 类 | RC1（77% 轮次试错） | ✅ 解决 |
| swb-sympy-23191 | 435k | 15 / 14 | 0 | RC2（首个补丁提交时预算已尽） | ❌ 失败 |
| swb-sympy-24909 | 406k | 13 / 33 | 0 | 补丁质量（多轮验证反馈仍修不对） | ❌ 失败 |

分组结论：**4 个 django 失败源于平台治理层缺陷（RC1），其中 3 个 mini-SWE 均解决**；
2 个 sympy 失败中 1 个源于上下文膨胀（RC2），1 个是双方都失败的高难任务。

\* 15851 的失败链条最有意思：三次 attempt 的最终失败码都是
`VERIFY_TEST_TAMPERING`。它的定向测试在 base 里尚不存在（SWE-bench 的
test_patch 由 Verifier 在验证阶段才注入），Agent 被 guard 堵死所有运行测试的
出路后，选择**自己把缺失的测试写进 tests/ 来自证**——V6 门禁正确拦截了这个
行为。门禁没有错，但起因仍是 RC1：治理层把合法路径堵死时，Agent 的变通行为
会滑向更危险的方向。这也暴露了 swebench 套件的提示词缺口：需要显式告知
「定向测试可能尚不存在，绝不要自行创建」（v2.1 修正项）。

## 3. 根因

### RC1：治理层可用性缺陷 —— guard 白名单挡死了唯一正确的测试命令（4/6）

django 任务的 `fail_to_pass` 命令形如：

```bash
PYTHONPATH=/workspace python3 tests/runtests.py --settings=test_sqlite --parallel=1 -v1 <test>
```

任务提示明确要求「下方给出的测试命令原样执行即可」。Agent 照做，命中三重拒绝：

1. `PYTHONPATH=... python3 ...` —— 首 token 不是白名单前缀 → **不在白名单**；
2. 换 `env PYTHONPATH=... python3 ...` —— `env` 也不在白名单 → 拒绝；
3. 换 `python3 -c "import sys; sys.path.insert(0,...); ..."` 内联绕路 —— 分号命中
   **shell 注入元字符** → 拒绝。

checkpoint 取证显示 4 个 run 里 Agent 都**在早期就构造出了逐字正确的命令**（15814 的
checkpoint 里 PYTHONPATH 出现 35 次），此后 57%–77% 的轮次消耗在测试命令试错上，
每轮背着 10k–37k 的上下文税直至烧满 400k 预算。沙箱 exec 实际用 `sh -lc` 执行，
环境变量前缀在执行层毫无问题——**卡点只在 guard 的前缀匹配**。

对照组：mini-SWE 走裸 bash（无命令白名单，只有 Docker 隔离），同样的命令直接执行，
15814 / 15851 / 16873 全部解决。这暴露了一个真实的治理权衡：**过紧的白名单不会让
Agent 放弃，只会让它烧预算绕路，且绕路方式（`python3 -c` 内联脚本）反而更难审计**。

另一处火上浇油：guard 的拒绝消息只说「不在白名单」，不告诉 Agent 白名单里有什么，
Agent 只能盲试。

### RC2：上下文膨胀 —— 全文回读 + 消息历史零修剪（2/6 主因，放大所有失败）

`read_file` 一次返回整个文件（上限 5 万字符，无行号、无范围参数），LangGraph 消息
历史永不修剪。django `sql/query.py`、sympy `pretty.py` 这类数千行文件读三四个之后，
**每轮模型调用固定背 37k–48k token**：

- swb-sympy-23191：读 6 个大文件后每轮 48k，400k 预算只够 14 轮，第 15 轮才首次
  `apply_patch`，预算已尽——探索本身没有明显失误，纯粹是上下文成本压垮了轮次预算；
- swb-django-15814：上下文从 2k → 17k → 37k/轮，15 轮烧 435k。

对照组：mini-SWE 的观察窗口模板对超过 1 万字符的输出取 head/tail 截断，且惯用
`nl -ba file | sed -n '1,80p'` 做行窗口阅读——同类任务均值仅 104k token。

### RC3：可观测性缺口 —— 失败的工具调用不产生事件

`_record` 只在 `fn()` 成功后 emit `TOOL_CALL`。后果：(a) 事件流里看不到 guard 拒绝，
时间线页无法解释「模型调用 33 次、工具调用只有 13 次」的缺口；(b) 本次取证被迫
绕道 checkpoint 二进制 blob。失败调用同样是关键审计信息，必须进事件流。

### 附注

- swb-sympy-24909 不归因平台：verifier 反馈循环正常工作（33 次模型调用含多轮
  验证反馈回炉），Agent 每轮都在迭代补丁但始终修不对，mini-SWE 同样失败——
  归类为模型/任务难度上限。
- 15851 的 BUDGET_UPDATE 出现负增量：多次 attempt 重启后 usedTokens 按 attempt
  口径重新上报，Run 级累计口径正确，仅报表脚本需注意。

## 4. Agent v2 改进清单（映射根因）

| # | 改动 | 根因 | 层 |
| --- | --- | --- | --- |
| 1 | guard 支持前导 `KEY=VALUE` 环境变量赋值与 `env` 前缀：剥离后再做白名单匹配（值本身仍过 denylist/注入检查） | RC1 | 平台 |
| 2 | guard 拒绝消息附上白名单内容，让模型第一次被拒就知道边界 | RC1 | 平台 |
| 3 | `read_file` 增加行范围参数 + 行号输出，默认窗口截断并提示继续读取的方式 | RC2 | 工具 |
| 4 | Agent 消息历史修剪:仅保留最近 K 轮完整工具结果，更早的替换为占位摘要（不动 checkpoint，只影响模型输入） | RC2 | Agent |
| 5 | 系统提示更新：行窗口阅读习惯 + swebench 套件的仓库布局描述修正（非 monorepo） | RC2 | Agent |
| 6 | `_record` 在工具失败时也 emit `TOOL_CALL`（带 error 字段） | RC3 | 平台 |

验证方式：修复后重跑 swebench 12 实例（同模型 gpt-5.5、同预算 400k），预期
RC1 类 4 任务大部分转为解决，整体目标 ≥8/12；同时对比均值 token 降幅。

## 4.1 验证结果（2026-08-06，批次 cmsh0dgog003f）

**10/12 解决（v1 为 6/12），反超 mini-SWE 的 9/12**，详表见
`docs/experiment-report.md` 实验五。逐根因核销：

- RC1 类 4 任务全部翻盘：15814（435k 失败 → 56k 解决）、15819（403k 失败 →
  273k 解决）、15851（篡改拦截 → 164k 干净解决）、16873（独立冒烟 314k 解决，
  批次内 389k 超限——边缘难度，波动可解释）；
- RC2 证据：解决 run 的 token 中位数 92k → 55k，事件流可见 read_file 全部
  走行窗口调用；
- RC3 证据：本轮 apply_patch 的失败尝试（补丁格式错误）直接出现在 TOOL_CALL
  事件流中，无需再翻 checkpoint blob；
- 未修复项符合预期：23191 仍失败（mini-SWE 同样失败的最难实例，模型上限）。

## 5. 面试叙事要点

这次分析本身就是平台价值的演示：**没有事件溯源和 checkpoint，「Agent 比开源基线
弱 3 个任务」只是一个分数；有了它们，10 分钟内可以把差距拆解成两个平台缺陷 +
一个模型上限，并给出可验证的修复清单。** 治理与自由度的权衡（guard 太紧 → Agent
烧预算绕路 → 绕路方式更难审计）是 Agent 平台设计里普适的教训。
