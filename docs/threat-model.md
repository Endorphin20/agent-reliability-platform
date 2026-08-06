# Threat Model（一页纸）

对象：平台在「不可信代码仓库 + 不可信模型输出」下自动修改代码并（未来）创建 PR。
本文列出信任边界、主要威胁、已有缓解与已知缺口——**缺口按诚实原则保留，
不假装已经生产级**。

## 信任边界

```
不可信: 仓库内容(含恶意注释/代码) | 模型输出(工具调用/补丁) | 被执行的测试
半可信: LLM API 端点(第三方服务)
可信:   control-plane / worker / verifier / 宿主 Docker daemon
```

核心原则：**沙箱是安全边界，guard 是纵深防御**。任何依赖「模型听话」的控制
都不算控制。

## 威胁 × 缓解 × 缺口

| # | 威胁 | 已有缓解 | 已知缺口 / 下一步 |
| --- | --- | --- | --- |
| T1 | **Prompt injection**：仓库内恶意注释诱导 Agent 执行危险命令或改越权文件 | 命令白名单 + denylist + shell 注入元字符拦截；V2 范围检查（allowedPaths 之外的 diff 直接拒）；V6 测试防篡改（先于测试执行短路）；人工审批门禁 | 注入本身无检测（Agent 读到什么就信什么）；下一步：工具结果进上下文前做注入模式扫描 + 长度配额 |
| T2 | **沙箱逃逸 / 资源滥用**：恶意测试代码攻击宿主 | `--read-only` rootfs、`network none`、CPU/内存/pids 限额、不挂载 docker.sock / 宿主 HOME / 平台源码、仅挂载工作副本、容器带 `arp.run_id` label 支持孤儿清扫 | 仍是共享内核的容器隔离；生产应换 gVisor/Firecracker；未启用 seccomp 自定义 profile |
| T3 | **补丁后门**：修复顺带植入恶意逻辑 | V1-V6 门禁（范围/静态/定向/回归/防篡改）+ LLM Judge 语义审查 + 人工审批必经 | Judge 可被高质量后门骗过；无 SAST/依赖扫描；下一步：diff 里的网络/进程/编码类 API 调用加规则告警 |
| T4 | **测试作弊**：改测试让门禁通过 | V6 防篡改（tests/**、*.test.* 相对 base 零变更，先于测试短路）；swebench 的 test_patch 对 Agent 不可见，Verifier 验证时才应用、跑完即回滚 | 语义级作弊（不改测试文件但 mock 掉被测逻辑）依赖 Judge 与人工 |
| T5 | **Secrets 泄漏**：API key 进事件流/日志/仓库 | `.env` gitignore；沙箱内无任何平台凭据（环境只有 HOME）；事件 payload 只存摘要与截断输出 | 无系统性 secret 扫描；下一步：事件落库前过 secret 正则清洗器 |
| T6 | **环境变量注入**（本次 guard 放宽引入，见 failure-analysis RC1）：`PATH=/evil`、`LD_PRELOAD=...` 前缀合法化 | denylist 对全串扫描（含变量值）；执行发生在沙箱内——改 PATH 最多劫持沙箱内进程，出不了 T2 的边界 | 有意接受的权衡：guard 过紧的代价已被量化（4 个任务烧满预算绕路，绕路命令更难审计）；可选收紧：环境变量名单化（PYTHONPATH/DJANGO_SETTINGS_MODULE 等） |
| T7 | **预算滥用**：死循环烧钱 | 三级预算（tokens/seconds/turns）硬停 + 卡死检测（连续 3 轮相同工具调用）+ 命令超时强杀（GNU timeout --signal=KILL） | 单任务预算是静态配置，无全局（跨任务）配额与告警 |

## 面试一句话版

> 沙箱四件套（read-only / no-network / 资源限额 / 最小挂载）是边界，guard
> 白名单是纵深，V1-V6 + 人工审批是出口管控；我们还用失败分析量化过「治理
> 过紧」的反面代价——安全控制的可用性本身也是安全属性，因为被逼出来的
> 绕路行为更难审计。
