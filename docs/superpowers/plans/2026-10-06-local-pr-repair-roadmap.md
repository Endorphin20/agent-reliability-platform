# ARP 本地自托管 PR 修复开发计划

> **For agentic workers:** 使用 executing-plans 按阶段执行；只有用户明确选择委派时才使用 subagent-driven-development。本文件是跨子系统开发路线图，不是本轮实施授权。每个任务以复现验收场景、最小实现、验证、独立提交为执行顺序。

**审查版本：** 2026-10-06 v2。已修正运行控制缺失、CI 合并上下文、镜像标识、迁移兼容、队列可靠性、预算承诺和阶段门禁；审查结论见第 9 节。本文件定义工作包与验收边界；各工作包动工前需把其第一项失败场景落成测试，不应把整份路线图当成一次性编码任务。

**Goal:** 用户一次接入仓库后，可以从失败 PR 创建固定版本、固定测试契约、预算受控的后台修复任务，审查并批准后交付修复 PR。

**Architecture:** 保留 NestJS 控制面、Python Worker、Docker 沙箱、PostgreSQL、Redis Streams 和 Next.js 前端。把 fixture 驱动任务扩展为仓库配置与不可变任务快照驱动；新增环境准备、失败复现、任务预算账本和独立交付作业。现有 fixture 继续作为回归与评测入口。

**Tech Stack:** TypeScript / NestJS / Prisma / Next.js、Python / LangGraph / pytest、Docker、PostgreSQL、Redis、GitHub REST API。

---

## 1. 范围、默认决策与完成定义

### 第一版必须完成

- 本地单用户自托管；用户自己的模型凭据和 GitHub 授权。
- 仓库配置保存与复用，PR 导入与确认，固定提交 SHA。
- 环境版本记录、缓存复用、独立执行工作区，环境失败单独报告。
- 平台执行修复前复现和修复后验证，验收契约不可由 Agent 修改。
- 后台队列、跨重试预算、恢复规则、日志和候选补丁留存。
- 持久事件、SSE、重新打开恢复进度、站内通知。
- 人工审查后批准推送，分支变更检查，幂等创建 PR，交付单独重试。

### 建议采用的第一版边界

以下是计划默认值，不代表用户已逐项确认；实施时允许调整，不影响本次计划交付。

- 首个支持模板：固定 Python 版本、pytest、带精确版本与哈希的 requirements 锁定文件、无外部数据库等服务的仓库；仅允许公开依赖源和 wheel 安装。仓库自身以源码方式测试，不隐式执行其构建后端。源码依赖、私有依赖源、未锁定依赖明确标为不支持，可改用用户已准备的镜像。具体 Python 版本及平台架构在 T00 用真实仓库验证后固定。Node 模板在首个闭环稳定后扩展。
- GitHub.com、同仓库 PR 优先；fork PR 和第三方 CI 显式返回不支持原因。首版自动读取 GitHub Actions，其他失败证据支持手工补充。
- 用户可以提供自己的镜像；首次使用时解析并冻结本地 image ID，远程镜像另存 registry digest。平台同时提供一种可构建的环境模板。不自动执行仓库中任意安装脚本；仓库接入时展示并确认平台实际执行的准备命令。
- 首版禁止 Agent 修改依赖声明、锁文件、环境配置及验收执行配置；需要修改时暂停，由用户创建新配置版本并重新准备、确认。
- 默认创建新的修复分支，修复 PR 指向原 PR 的源分支；确认页面显示完整交付方向。原 PR 分支追加提交不在首版默认流程中。
- 首版使用限定仓库的 fine-grained PAT，读写凭据分开引用；不要求先做 GitHub App 安装流。
- 执行时间预算包括环境准备、复现、Agent、验证、Judge、自动恢复和退避；排队、人工等待、交付耗时单列。另设从确认开始的任务期限，防止任务长期悬挂。
- Token 预算覆盖 Agent、上下文压缩和 Judge。通过控制面做原子预留/结算，模型调用仍由沙箱外的 Worker 统一包装器执行，不新增独立模型代理服务。模型端点必须提供可靠的用量和输出上限语义；无法确定输入 Token 上界时拒绝严格预算模式，不能把近似估算当硬上限。
- 未配置回归测试必须在确认摘要中明确提示并由用户接受，不能把空命令列表呈现为“回归通过”。
- 第一版可选择静态检查失败或 pytest 测试失败作为修复目标；日志缺失时允许用户提供原失败证据和命令。日志导入成功不等于失败已复现。

### 后续阶段

云端账号、托管沙箱、多用户隔离、计费、邮件通知、任意仓库零配置适配、自动追加原分支提交均不进入本轮交付。自动创建草稿 PR 是可选增量，不阻塞第一版。

### 可选技术路径与选择

1. 在 fixture YAML 外面增加 PR 导入脚本：原型最快，但仓库配置、版本固定和权限继续耦合，不作为产品主路径。
2. 保留执行引擎，增加仓库配置、任务快照、环境版本和交付作业：推荐，能逐步迁移并保留现有评测能力。
3. 重写为云端多租户系统：超出第一阶段范围，投入与目标不匹配。

## 2. 当前基线与实施保护

2026-10-06 核对当前工作区：

- 任务入口要求 fixtureId；Project 存在，但使用默认项目。
- Run.baseCommit 没有强制解析为 SHA，恢复命令重新读取 fixture 配置。
- 沙箱有独立容器与本地副本，镜像仍为全局配置。
- runner 先运行 Agent 再验证，没有强制前置复现阶段。
- 已有队列、租约、checkpoint、Policy、SSE 和审批交付。
- 异常消耗、全流程计时和重启预算继承有缺口；Policy 返回的退避需要落实到调度。
- GitHub 出站仍从全局 fixture 路径取代码，使用 force push。
- web 没有 test 脚本，不能把 pnpm -r test 当作前端行为已验证的证据。
- 当前 Worker 收到 CANCEL_RUN 仅 ACK；重复 claim 返回既有 attempt 后仍可能继续执行，checkpoint 上报也缺少持有者 fencing 校验。
- OutboxPublisher 当前忽略 topic，固定发往 run-commands；TraceEventIngestor 只读取新消息，没有 pending 接管；生命周期合成事件存在事务提交前广播路径。

当前存在未提交的运行生命周期、前端布局、SSE 和部署相关改动。实施前重新检查 git diff，保留这些改动，不覆盖、不混入不相关提交。涉及 web 时先读取 apps/web/AGENTS.md 及本地 Next.js 对应版本文档。数据库变更使用新增迁移，不直接改生成的 Prisma 文件。

## 3. 关键数据边界

以下名称为拟新增或扩展的逻辑对象；具体 Prisma 字段在 P0 契约任务中固定。

- **Project / RepositoryConfigVersion**：仓库 URL、本地受管副本、默认分支；配置版本保存运行时、构建方式、检查命令、允许路径、保护路径、凭据引用和交付默认值。凭据值不在配置 JSON 中。
- **TaskDraft**：导入结果及用户可编辑的验收草案，包含源仓库、源分支、PR head SHA、base SHA、CI 实际执行 SHA、检查与日志引用、有效期。
- **TaskSnapshot**：确认后冻结 Agent、仓库配置版本、准确执行 SHA、CI 上下文、测试契约、范围、预算和交付方向。PR 修复首版 executionSha 固定为 PR head SHA，手工/fixture 任务使用用户确认的 SHA，patchBaseSha 与之相同；CI 的合并 SHA 仅作为证据，不直接用于生成交付补丁。Task 的所有重试读取该快照；更改验收需创建后继任务并关联原任务。
- **EnvironmentVersion**：环境指纹、构建输入摘要、状态、本地 image ID、可选 registry digest、平台架构、构建日志和时间。本地构建不要求有 RepoDigests，也不要求新增镜像仓库。Run 记录实际使用的版本；不依赖 latest 标签保证可复现。
- **BaselineReport / VerificationReport**：阶段、命令、退出码、测试标识、错误签名、输出工件和契约摘要。基线和最终结果可对比。
- **BudgetLedger**：按 taskId 聚合，分别记录 settled、reserved、unknown 用量，以模型调用/执行区间唯一键幂等入账；Attempt 重建不能清零。已结算消耗单调不减，预留结算可释放未用额度，不能把释放预留误判为消耗回退。
- **AttemptLease**：现有 Attempt 扩展 owner、generation、expiresAt，claim 返回 fencing token；过期执行者不能更新权威 checkpoint、报告或任务状态。
- **DeliveryJob**：绑定已审批 patch digest、执行 SHA、目标分支及预期 SHA、修复分支、阶段、重试次数和 PR URL。
- **Notification**：完成、失败、需要人工处理三类站内事件，持久化并支持已读状态。

流程阶段采用独立 phase 字段表达，避免把所有步骤都扩充成 Task 终态：

确认 → 排队 → 环境准备 → 失败复现 → 修复 → 验证 → 待审批 → 交付 → PR 已创建。

分支：环境失败、无法复现、证据不一致、预算耗尽、分支变化进入明确的失败或人工处理状态；交付失败不能回到 Agent 修复阶段。PR 已创建不等于 GitHub CI 通过或 PR 已合并。

### 运行控制与模型拆分规则

- Task.status 增加 NEEDS_ATTENTION；Run 保持 INTERRUPTED，并存 attentionReason。phase 属于当前 Run，交付阶段来自 DeliveryJob，前端组合显示；不靠日志文本推断状态。
- `resume` 只在快照不变、前置条件满足、预算和尝试次数均有余额时继续；`cancel` 使执行停止且禁止新模型调用/交付；验收或环境输入变化走 `revise` 创建后继任务。预算不足不提供能清零消耗的“重试”入口。
- 每个修复 Task 只选一个 Agent/一条主执行链。现有双 Agent 对比继续创建两个 Task，分别计预算，不能误用一个任务预算运行两个互不感知的 Run。
- BaselineReport / VerificationReport 优先复用现有 VerificationResult 和 Artifact，通过 stage 与 contractDigest 区分；Notification 可按持久事件生成。不要仅因本节列出逻辑对象就全部新建数据表。
- TaskSnapshot 固定环境输入摘要；构建完成后以 compare-and-set 首次绑定 EnvironmentVersion 与 image ID，后续 attempt 不允许重新构建后静默替换。镜像丢失时暂停，导入相同 ID 可恢复，否则新建任务重新确认。

## 4. 阶段与任务清单

### P0：建立任务快照与版本契约

目标：先解决版本漂移和配置漂移，作为所有后续阶段的基础。

#### T00 — 支持矩阵与最小风险验证

新增：`docs/acceptance/local-pr-preflight.md`、`apps/agent-runtime/tests/test_local_pr_preflight.py`。

- [ ] 选择一个获授权的代表性同仓库 Python PR，记录 head SHA、base SHA、Actions run/job/check ID、实际 checkout SHA 与失败命令；只读检查不触发 GitHub 写入。
- [ ] 在固定 Python/架构的临时 Docker 环境运行该 SHA 的原检查，记录依赖安装方式、可重复失败证据和耗时。无法访问真实样本时用本地合成 PR 历史验证技术路径，并把真实样本门禁标为未完成，不能据此承诺支持矩阵。
- [ ] 验证所选模型端点的 usage 字段、最大输出设置、超时和隐藏重试行为，记录严格预算是否可支持。
- [ ] 用证据固定第一版支持矩阵；记录非目标技术栈、未知 CI checkout 上下文和不兼容模型的用户提示。

验收：至少一个真实代表性 PR 在约定环境可复现，模型预算约束有可验证依据；这项结果决定 T04、T05、T08 的细化和估算，避免先建通用框架后发现样本不适配。

#### T01 — 数据模型与双端契约

涉及现有文件：
- `apps/control-plane/prisma/schema.prisma`
- `packages/shared/src/run-command.ts`、`packages/shared/src/enums.ts`
- `apps/agent-runtime/src/arp_runtime/schemas/run_command.py`、`schemas/enums.py`
- `apps/control-plane/src/state-machine/state-machine.ts`

新增文件：
- `packages/shared/src/task-snapshot.ts`
- `apps/control-plane/src/modules/task/task-snapshot.service.ts`
- `apps/control-plane/src/modules/task/task-snapshot.service.spec.ts`

- [ ] 添加失败契约用例：真实任务 SHA 非法、路径逃逸、负预算、不存在的配置版本、缺少测试契约均被拒绝；合法快照在 TS/Python 两端一致解析。已存在且被明确选择的旧配置版本允许复用，不能与快照固定语义冲突。
- [ ] 引入 schemaVersion 和 REAL/MOCK 执行模式。REAL fixture 的 ref 在创建时解析 SHA；内置 fake 是显式 MOCK，不要求真实 Git SHA，不能批准真实交付。真实用户仓库遇到 mock 模式必须阻止执行，不能输出脚本化成功结果。
- [ ] taskSpec 不再强制 fixtureId，改为可选来源元数据；更新 `apps/agent-runtime/src/arp_runtime/runner.py`、`worker.py`、`agents/llm.py` 对 fixture/gold patch 的分支，仅评测 MOCK 路径读取金标，真实仓库从快照运行。
- [ ] 迁移先新增可空字段，再为新任务强制快照；历史终态任务保留原始记录并标为 legacy，不用当前 ref 伪造历史 SHA。升级前暂停接收任务并排空旧 Worker；旧活跃任务无法可靠恢复快照时进入人工处理。控制面与 Worker 同批升级，未知 schemaVersion 拒绝消费且提示版本不兼容。
- [ ] 明确状态转换和暂停原因；任务终态不被重复上报回退。
- [ ] 更新 JSON Schema 和两端契约 fixture，运行契约测试及 Prisma 校验。
- [ ] 只在本阶段引入快照、阶段和必要引用；环境、预算、交付表由对应任务各自新增迁移。追加迁移兼容测试，覆盖旧终态记录读取、旧活跃任务处理和 MOCK/REAL 隔离。

验收：已有 fixture 可继续创建；新任务快照一经确认不可原地修改，配置更新不影响已创建任务。

#### T02 — 固定代码 SHA 与确认幂等

修改：`apps/control-plane/src/modules/run/run-lifecycle.service.ts`、`apps/agent-runtime/src/arp_runtime/sandbox/provider.py`。

新增：`apps/control-plane/src/modules/task/task-confirmation.service.ts`、同目录 `task-confirmation.service.spec.ts`；扩展 `apps/agent-runtime/tests/test_sandbox.py`。

- [ ] 添加“确认 A 后分支前移到 B，再执行和重试仍为 A”的测试。
- [ ] 在平台受信侧解析并获取完整 SHA，保存所需 Git 对象；任务派发和恢复只读快照。
- [ ] 检出后验证 HEAD 等于确认 SHA；缺少对象直接报错，禁止退回分支最新版本。
- [ ] 使用确认幂等键，在事务内创建 Task、Run、快照和 Outbox，重复确认只创建一个任务。
- [ ] Git fetch、日志下载等网络工作在事务外完成；确认事务比较草稿 revision、已解析 SHA、配置版本及请求摘要，同一幂等键不同请求返回冲突。以受管 Git ref 固定对象生命周期，直到关联任务与交付不再需要。

验收：版本漂移测试、重复确认测试、恢复命令快照一致性测试全部通过。

### P1：接入用户仓库并保存可复用配置

依赖：P0。

#### T03 — 仓库配置与凭据边界

新增：
- `apps/control-plane/src/modules/repository/repository.controller.ts`
- `apps/control-plane/src/modules/repository/repository.service.ts`
- `apps/control-plane/src/modules/repository/repository.service.spec.ts`
- `apps/control-plane/src/modules/credentials/credential-store.ts`
- `apps/control-plane/src/modules/credentials/credential-store.spec.ts`
- `apps/web/src/app/repositories/page.tsx`

修改：`apps/control-plane/src/app.module.ts`、`apps/control-plane/src/config/env.ts`、`apps/web/src/lib/api.ts`。

同时修改：`apps/control-plane/src/main.ts`、`apps/control-plane/src/modules/internal/internal.controller.ts`、`apps/agent-runtime/src/arp_runtime/control_plane.py`、`docker-compose.yml`。新增 `apps/control-plane/src/modules/auth/local-auth.guard.ts` 及对应测试。

- [ ] 测试仓库二次创建任务复用默认值、配置更新生成新版本、路径越界和含凭据 URL 被拒绝。
- [ ] 提供仓库新增、读取、配置版本更新、连接检查 API 和页面；明确本地副本位置。
- [ ] 凭据存于沙箱外的本地受保护文件，权限 0600；API 只返回凭据引用和脱敏状态。读授权检查和写授权检查分别执行。
- [ ] 在接收真实凭据前实现本地会话授权、同源/CSRF 检查和独立 Worker token；控制面、数据库、Redis 默认只绑定回环地址。沙箱无法访问凭据 API，内部 API 不能仅靠 URL 前缀视为可信。模型凭据同样纳入配置和脱敏范围。
- [ ] Git 获取由平台侧完成；向沙箱导出干净工作副本，不带原仓库认证配置、hooks 或平台凭据文件。
- [ ] 检查持久化任务请求、构建输入、模型上下文及事件工件中均无测试用 canary 凭据；保存凭据的受保护入口允许一次性接收明文但不回显、不写请求日志。Git 认证使用独立 helper/askpass，不把 Token 放入 argv、远程 URL 或 .git/config。

验收：同仓库第二个任务无需重填环境信息；只读授权不能交付，且凭据不进入模型或沙箱。

#### T04 — 环境构建、指纹和缓存

新增：
- `apps/control-plane/src/modules/environment/environment.service.ts`
- `apps/control-plane/src/modules/environment/environment.service.spec.ts`
- `apps/agent-runtime/src/arp_runtime/environment/builder.py`
- `apps/agent-runtime/tests/test_environment.py`
- `infra/sandbox/templates/python-pytest.Dockerfile`

修改：`apps/agent-runtime/src/arp_runtime/sandbox/provider.py`、`worker.py`、`runner.py`；共享命令契约和内部 API。

- [ ] 测试相同环境输入只构建一次、锁文件变化生成新版本、并发构建合并、失败构建不缓存为 READY。
- [ ] 指纹覆盖基础镜像 digest、运行时、平台架构、依赖声明及锁文件内容、构建配方和环境配置；涉及本地依赖时加入对应源码摘要。
- [ ] 构建阶段允许受控依赖下载，执行阶段默认断网；构建上下文不包含凭据和无关宿主文件。
- [ ] 持久化本地 image ID、可选 registry digest、构建日志和失败分类；每次 attempt 创建独立容器及工作区，仅复用不可变镜像/受管缓存。
- [ ] 构建作业使用租约和唯一环境指纹防重复，失败构建提供显式重试；缓存处于 READY 也必须确认镜像仍存在。构建超时/取消终止 builder 子进程，未完成镜像不发布；清理跳过仍被 Run 引用的环境和代码对象。
- [ ] 环境输入从任务 SHA 的受管只读副本提取，构建上下文使用最小白名单，不能直接把整个用户工作目录交给 Docker。复用共享构建时，各任务计算自己的等待时间，构建 CPU 用量不混入任务墙钟时间。
- [ ] 禁止 Agent 修改环境输入；发现变化进入人工处理，不用旧环境声称验证有效。

验收：相同环境复用、环境变化重建、失败原因独立可见，每个 Run 可追溯实际环境版本。记录依赖来源不可用时的明确失败原因。

### P2：导入失败 PR 与确认测试契约

依赖：T03；可在环境模块完成前使用固定镜像开发导入功能。

#### T05 — PR 与 GitHub Actions 证据导入

新增：
- `apps/control-plane/src/modules/github/pr-import.service.ts`
- `apps/control-plane/src/modules/github/pr-import.service.spec.ts`
- `apps/control-plane/src/modules/task/task-draft.controller.ts`
- `apps/control-plane/src/modules/task/task-draft.service.ts`

修改：`apps/control-plane/src/modules/github/github.service.ts`、`apps/control-plane/src/app.module.ts`。

- [ ] 用 GitHub API 固定响应测试同仓库 PR、分页检查、日志过期、权限不足、限流和重复导入。
- [ ] 获取 PR 描述、文件改动、源/目标分支及 SHA、失败检查和 Actions 日志；记录证据来源，清理凭据并限制体积。
- [ ] 分开保存 PR head SHA、CI 关联 SHA 与证据能确定的实际 checkout SHA，记录 workflow/job、矩阵参数、run attempt 和日志时间；GitHub run 的 head_sha 不能直接当作实际 checkout SHA。用户选择本次要修的失败检查与运行版本，不能混用不同提交或不同重跑的日志。
- [ ] 常见 merge-ref CI 也允许导入：默认仍在确认的 PR head SHA 执行指定检查，若相同失败在 head 复现即可修复，摘要注明这是 head 上的本地复现。只在合并上下文失败时进入 NEEDS_ATTENTION，明确标记首版不能修复该类合并专属失败，不泛化拒绝所有 merge-ref CI。
- [ ] 识别 pytest 的失败测试标识；识别不出时保留原始证据，允许用户填写命令。
- [ ] 外部日志和 PR 文本视为不可信内容，不能覆盖平台权限、测试契约和预算。

验收：输入 PR URL 得到可审查草稿；证据不足明确提示，不能把未知状态标为已识别失败。

#### T06 — 创建前确认页面

新增：`apps/web/src/app/tasks/new/page.tsx`。

修改：`apps/web/src/app/tasks/page.tsx`、`apps/web/src/lib/api.ts`、`apps/control-plane/src/modules/task/task.controller.ts`、T02 确认服务。

- [ ] 展示仓库、执行 SHA、CI SHA、环境配置版本、Agent、测试命令、验收标准、修改范围、预算、最大尝试次数和交付方向。
- [ ] 用户显式确认测试符合需求；Agent 无权修改草稿或确认接口。
- [ ] 确认时重新核对 PR 状态：源分支变化提示保留旧 SHA 或刷新草稿，禁止静默替换；配置变化同样处理。
- [ ] 确认后才排队；双击、请求重试不产生重复任务。
- [ ] 提供人工草稿 API，允许没有可下载日志时填写仓库、SHA、检查命令和原失败证据；与 PR 导入草稿使用同一确认契约。浏览器用例覆盖篡改摘要、过期草稿、重复提交和不支持技术栈。

验收：完整走通仓库接入 → PR 草稿 → 用户确认 → 固定快照排队；摘要缺少必要信息时不能提交。

### P3：前置复现、可靠预算与失败留存

依赖：P0、T04、T06 的确认契约；基线解析器可先使用手工构造的已确认快照开发，但端到端验收必须走实际确认接口。

#### T07 — 失败复现门禁与契约保护

新增：`apps/agent-runtime/src/arp_runtime/verifier/baseline.py`、`apps/agent-runtime/tests/test_baseline.py`。

修改：`runner.py`、`verifier/pipeline.py`、`tools/guard.py`、`tests/test_verifier.py`、控制面工件与事件契约。

- [ ] 添加 pytest 断言失败、静态检查失败、环境缺依赖、零测试收集、超时、原失败已通过、失败类型不一致和随机失败用例；为受支持工具定义解析器及失败证据匹配规则，不让 LLM 独自判断复现成功。
- [ ] Agent 调用前由平台执行原检查，保存命令、退出码、测试标识、输出和错误签名；只有匹配失败证据才进入修复。
- [ ] 无法复现或测试冲突进入人工处理；调整验收创建新快照和后继任务，重新复现。
- [ ] 保护测试、测试配置、锁文件及执行脚本；将最终候选补丁应用到干净验证工作区再验证，避免 Agent 工作区残留影响结论。
- [ ] 补丁生成使用平台保有的 Git 基线并包含新增、删除和重命名；不能仅靠 git diff 遗漏 untracked 文件，也不能信任 Agent 可改写的 .git 元数据。检查路径、软链接、子模块和二进制变更；首版不支持的补丁类型显式拒绝。
- [ ] 干净验证工作区固定同一 SHA、镜像 ID、测试契约；pytest 同时核对收集/执行的测试集合和 skip/xfail 变化，防止以零测试或新增跳过伪装通过。保留受信测试清单，不承诺识别任意恶意实现。
- [ ] 复现报告按 snapshotDigest 和 environmentVersionId 复用；恢复 Agent 工作区不能污染原始基线。受管评测的 test_patch 也在基线工作区应用，但不放入模型上下文。
- [ ] 保留修复前后报告及契约摘要；静态、定向、回归检查分别显示执行/失败/未配置状态。

验收：不能复现时模型调用次数为零；Agent 改低断言、跳过测试、改测试执行配置均被阻止或验证拒绝。

#### T08 — 任务级预算与恢复调度

新增：`apps/control-plane/src/modules/run/budget.service.ts`、`apps/control-plane/src/modules/run/budget.service.spec.ts`；`apps/agent-runtime/src/arp_runtime/agents/budgeted_model.py`、`apps/agent-runtime/tests/test_budget.py`、`apps/agent-runtime/tests/test_run_control.py`。

修改：`run-lifecycle.service.ts`、`policy/policy-engine.ts`、`dispatch/outbox-publisher.ts`、`dispatch/lease-monitor.ts`、`agents/llm.py`、`agents/mini_swe.py`、`agents/self_agent/graph.py`、`agents/condenser.py`、`judge/scorer.py`、`worker.py`。

- [ ] 测试正常重试、从 checkpoint 恢复、从头重启、Worker 崩溃和重复上报都不降低累计消耗。
- [ ] 控制面对每次调用原子预留 `inputUpperBound + maxOutputTokens`，Worker 包装器执行并按 usage 结算。关闭 SDK 隐式重试，或使每个真实重试单独预留。usage 缺失/调用超时保留 unknown 预留并暂停，不能重发同一 requestId 造成不可计量的双重调用。
- [ ] 所有 Agent、压缩器和 Judge 共用同一账本；耗尽预算后拒绝下一次模型调用。
- [ ] Judge 保持辅助性质：确定剩余预算不足时标为 SKIPPED_BUDGET，已通过的确定性验证仍可进入人工审批；调用结果不确定按 unknown 规则暂停。前端区别“验证通过”与“Judge 已完成”。
- [ ] 持久记录执行阶段时间及任务期限；对运行中的命令和模型调用设置剩余预算超时，崩溃时间由租约与阶段记录结算。
- [ ] 实现有上限的延迟调度和最大尝试次数配置；429 退避真实生效，人工恢复不能重置预算。
- [ ] 新增持久化 `notBefore` 和 `expiresAt`，调度前校验剩余预算；环境准备、Agent 尝试和交付各有有限重试计数，不能用阶段切换规避任务总预算。预算轮次明确为 Agent 模型轮次，压缩/Judge 仍计 Token。
- [ ] 在 `apps/control-plane/src/modules/run/run.controller.ts` 提供 resume/cancel/revise；resume 幂等且校验暂停原因，revise 创建关联后继任务并展示旧任务已耗预算，不隐藏成本。用状态测试证明验收变化不在原任务中续跑。
- [ ] claim 返回持有者 fencing token，heartbeat/checkpoint/报告/预算预留校验 owner 与 generation；只有授权 claim 才执行，重复投递不能启动第二个 Agent。过期 Worker 的结果不得覆盖新 attempt，但其已经发出的模型调用仍按唯一调用 ID 结算以免漏账。
- [ ] 取消与心跳状态查询走独立控制路径，不能等待正在阻塞执行的 Redis 消费循环读到 CANCEL_RUN。取消/租约失效停止子进程与容器，禁止新模型调用，取消发生前已发出的调用仍结算；测试 Worker 失联后恢复不得继续写入。

验收：总预算约束覆盖两个 Agent、所有自动重试和异常路径；已用预算单调不减，恢复耗尽任务不再产生模型请求。

拆分提交顺序：T08a 租约与重复 claim → T08b 暂停/恢复/取消 → T08c Token 预留结算 → T08d 时间预算与延迟调度。每步都有独立故障测试；不能只实现预算字段即认为本任务完成。

#### T09 — 异常补丁与诊断工件

修改：`apps/agent-runtime/src/arp_runtime/runner.py`、`worker.py`、`control_plane.py`、`apps/control-plane/src/modules/run/run-lifecycle.service.ts`。

新增：`apps/agent-runtime/tests/test_failure_artifacts.py`。

- [ ] 在模型异常、超时、验证失败、取消前保存可取得的候选 diff、日志和失败原因，再销毁沙箱。
- [ ] Worker 硬崩溃时展示最近 checkpoint 的补丁和时间，明确标注可能不是最终工作区；无补丁明确说明。
- [ ] 工件上传幂等，截断日志标记截断位置；候选补丁不可因验证失败被误标为已批准。
- [ ] 工件优先写入现有数据库；控制面不可用时写入 Worker 的受管持久 spool 目录（不在一次性工作区内），tmp 文件加原子重命名。确认持久化到 DB 或 spool 后才清理可控异常工作区；两者均失败时保留工作区并报告存储故障，受磁盘水位限制停止接收新任务。恢复后幂等补交，不覆盖已验证候选。
- [ ] 修正孤儿清理判定，只清理租约已失效的容器；新 Worker 启动不能删除另一个活跃 Worker 的沙箱。

验收：可控异常保留最新候选补丁，硬崩溃保留最近持久化结果，最终失败可以定位到阶段与原因。

### P4：进度、通知与可恢复 GitHub 交付

#### T10 — 阶段展示与站内通知

依赖：T01、T07；对接 T08/T09 的失败分类。

新增：`apps/control-plane/src/modules/notification/notification.service.ts`、`notification.controller.ts`、`notification.service.spec.ts`；`apps/web/src/components/notification-center.tsx`。

修改：`events/sse.controller.ts`、`events/trace-event-ingestor.ts`、`apps/web/src/lib/use-run-events.ts`、`apps/web/src/app/runs/[runId]/page.tsx`、`apps/web/src/app/layout.tsx`。

- [ ] 持久化阶段开始/结束及暂停原因，事件重放和实时事件按 sequence 衔接。
- [ ] 所有合成事件先提交事务再广播；SSE 从 DB 分页补发。TraceEventIngestor 为 pending 增加接管重试，数据库暂时不可用不能 ACK 丢事件；实时广播丢失时以持久序号补齐，不能跳过缺失事件直接推进游标。
- [ ] PostgreSQL 作为任务和通知事实来源；Redis 开启卷和 AOF，同时启动时按状态、notBefore 和预算重投应执行但无有效租约的数据库作业，NEEDS_ATTENTION/取消/终态不得自动重启。不要仅靠 Redis 的短期 SET NX 锁判定命令已经执行完成。Redis 灾难性丢失时可恢复作业，但仅在 Redis 尚未落库的事件不承诺无损；最终阶段/报告必须通过持久 API 写入，页面标记已检测到的诊断日志缺口。
- [ ] 显示当前阶段、环境版本、预算、失败原因、候选补丁入口；人工处理有明确操作入口。
- [ ] 完成、失败、需人工处理生成去重通知；通知可标记已读，刷新后保留。
- [ ] 浏览器验证关闭页面、重新打开、断线重连、跨任务切换和服务重启后历史恢复。
- [ ] 在 `apps/web/package.json` 增加浏览器测试入口及 `@playwright/test` 开发依赖，新增 `apps/web/playwright.config.ts` 和 `apps/web/tests/local-pr-flow.spec.ts`；覆盖确认、暂停操作、恢复进度及审批交付失败重试。T10 对交付使用固定 API 响应，T11/T12 再接入真实后端测试，不能以 mock 通过替代交付验收。

验收：页面关闭不影响 Worker；重新打开不丢历史；状态变化只产生一条对应通知。

#### T11 — 独立交付作业与安全推送

依赖：T02、T03、T07、T09。

新增：`apps/control-plane/src/modules/github/delivery.service.ts`、`delivery.service.spec.ts`、`delivery-worker.ts`。

修改：`github/github.service.ts`、`approval/approval.service.ts`、`apps/web/src/app/runs/[runId]/review/page.tsx`。

- [ ] 审批绑定候选补丁 digest、执行 SHA、环境版本和验证报告；内容变化必须重新审批。
- [ ] 审批事务只创建 DeliveryJob 和 Outbox，后台执行交付；使用仓库对应代码副本和授权，不再使用全局 fixture 路径。
- [ ] 修改 `apps/control-plane/src/modules/dispatch/outbox-publisher.ts` 和 `apps/control-plane/src/redis/redis.service.ts`，按 topic 显式路由 run-commands 与 delivery-commands；未知 topic 拒绝发布。Delivery Worker 有自己的 claim/lease、有限重试、pending 接管和启动恢复，不将交付消息发给 Python Agent Worker。
- [ ] 推送前比较原 PR 源分支及修复分支的预期 SHA；新分支采用仅不存在时创建，已有分支采用明确预期 SHA 的 lease，禁止无条件 force push。
- [ ] 目标分支前移时暂停交付；再次检查并显示竞态结果。GitHub 目标分支在新分支推送期间仍可能变化，不能声称跨分支原子保证；检测后阻止自动创建 PR，要求用户重确认或重新验证。
- [ ] 检查 PR 仍开启、源仓库与分支仍匹配、未删除/重定向；发生目标代码变化时，只允许创建基于新 SHA 的后继任务并重新验证审批，不能仅点“忽略变化”沿用旧验证结果。仅凭据恢复、API 限流或网络失败可原样重试交付。
- [ ] 以 taskId 和已审批补丁版本确定交付标识；并发申请互斥，创建 PR 超时后先查询核对已有 PR，再决定重试。
- [ ] 测试推送成功但建 PR 失败、建 PR 成功但响应丢失、服务重启、已存在/已关闭 PR、新增文件补丁和权限撤销。
- [ ] 对开放/关闭/已合并 PR 都查询交付标识；已经关闭的同一交付不得静默再建一个 PR。构建提交一次并持久保存 commit SHA，重试复用同一提交，不因提交时间变化重建并 force push。
- [ ] 展示 GitHub 检查状态/链接；缺少触发工作流显示原因，合并始终由人决定。

验收：交付重试不启动 Agent；同一交付不会产生多个相同 PR；分支变动不覆盖用户提交；补丁永久保留在任务记录中直至用户主动清理。

拆分提交顺序：T11a 审批绑定与 DeliveryJob → T11b topic 路由/租约/恢复 → T11c 提交生成与分支检查 → T11d PR 查询、创建和异常对账。验收中“重试不修复”指同一交付快照；目标 SHA 变化创建新任务不属于交付重试。

### P5：安装体验与整体发布验收

依赖：全部必需任务。

#### T12 — 自托管安装与真实仓库验收

修改：`scripts/setup.sh`、`scripts/dev.sh`、`docker-compose.yml`、`.env.example`、`README.md`、`docs/architecture.md`、`docs/threat-model.md`。

新增：`scripts/e2e-local-pr.sh`、`docs/local-self-hosted.md`、`docs/acceptance/local-pr-repair.md`。

- [ ] 检查 Docker、运行时、端口、数据库迁移、模型连接和 GitHub 权限，区分 mock 演示和真实执行。
- [ ] 验收 T03 已实现的本地授权、同源保护、Worker token 和回环绑定，确保默认 Compose 端口及前端代理也遵守边界；不能把首次安全实现推迟到发布阶段。
- [ ] 文档说明支持矩阵、凭据位置、备份恢复、镜像缓存清理、依赖变更流程和失败处理。
- [ ] 在授权的专用测试仓库中运行完整 PR 修复闭环，保存脱敏报告；真实推送前取得该测试仓库的写操作授权。
- [ ] 回归现有 fixture、checkpoint 恢复、双 Agent 和评测入口；升级前数据库备份，并验证旧记录仍可查看。

验收：新用户按文档接入支持范围内仓库，连续创建两个任务；第二次复用配置和环境，第一任务可以交付真实修复 PR，第二任务覆盖失败恢复场景。

## 5. 验证命令与证据要求

执行时使用项目实际依赖版本；下列是当前存在的测试入口，不表示本轮已经运行。

```bash
pnpm -C packages/shared gen:schemas
pnpm -C packages/shared build
pnpm -C packages/shared test
pnpm -C apps/control-plane exec prisma generate
pnpm -C apps/control-plane exec prisma validate
pnpm -C apps/control-plane exec jest --runInBand
uv run --directory apps/agent-runtime python -m pytest
pnpm -C apps/web exec tsc --noEmit
pnpm -C apps/web lint
pnpm -r build
```

以上步骤中生成命令会更新契约/客户端产物，需核对差异并遵循仓库追踪规则。数据库集成测试使用独立测试库，并先运行 `pnpm -C apps/control-plane exec prisma migrate deploy`；不得对用户业务库执行 reset。新增浏览器入口后运行 `pnpm -C apps/web exec playwright test`。迁移、Docker 和真实 GitHub 测试需要相应依赖/授权，不能因本地缺依赖把它们标记为通过。

每个任务先运行其新增失败用例，记录预期失败，再实现并运行对应测试。达到阶段门禁后执行相关集成测试；发布阶段运行 `bash scripts/e2e.sh` 和新增的 `bash scripts/e2e-local-pr.sh`。单测通过不能代替真实 Docker、GitHub 或浏览器验收。前端需浏览器流程验证，不以类型检查代替。

发布验收记录必须包含：

- [ ] A01 仓库第二次创建任务复用配置，无重复环境填写。
- [ ] A02 确认后源分支前移，执行/恢复 HEAD 仍为确认 SHA。
- [ ] A03 环境相同复用、变化新建；每次运行显示本地 image ID 和可用的 registry digest，镜像缺失暂停而非静默换版。
- [ ] A04 环境准备失败、代码测试失败、无法复现三种结果明确分离。
- [ ] A05 基线失败和修复后结果均可查看，契约与测试配置不能被 Agent 降低。
- [ ] A06 两个 Agent 在重试、崩溃和从头重启时均保持总预算；超限停止。
- [ ] A07 失败保留原因、日志和可用候选补丁；硬崩溃补丁注明持久化时间。
- [ ] A08 关闭页面后台继续，重开恢复事件，完成/失败/人工处理产生站内通知。
- [ ] A09 凭据 canary 不进入模型、构建上下文、任务沙箱和用户可见工件。
- [ ] A10 无写权限不能推送，目标分支变更暂停，未经审批不能创建正式修复 PR。
- [ ] A11 交付失败只重试交付，响应丢失和并发重试不重复创建 PR。
- [ ] A12 GitHub CI 结果可追踪，不执行自动合并。
- [ ] A13 全新本地安装可执行真实任务，mock 模式有明确标识，服务默认仅本机访问。
- [ ] A14 原 fixture、checkpoint 和评测入口兼容；两个 Worker 不互相清理活跃沙箱。
- [ ] A15 merge-ref CI 的失败能在 head 重现时可进入修复；只在 merge 上失败、实际 checkout 未知或证据不一致时明确暂停；静态检查失败也能创建任务。
- [ ] A16 暂停可恢复、验收变化创建后继任务、取消能停止执行；旧租约、重复 claim、预算已耗尽不能继续产生新调用或覆盖结果。
- [ ] A17 事件消费中途崩溃、DB 暂不可用、Redis 重启/数据丢失后任务可对账恢复，SSE 不展示回滚事务的虚假状态。
- [ ] A18 升级后 legacy 任务可读、旧活跃任务有明确处理，MOCK 结果不能进入真实交付；未知契约版本不被旧 Worker 错误执行。
- [ ] A19 同一预算调用重复结算、SDK 隐式重试、usage 缺失均被正确处理；不支持可靠上界的模型明确拒绝严格预算模式。
- [ ] A20 新增/删除/重命名补丁正确交付，零测试或新增 skip/xfail 不误报通过；同一内容摘要贯穿捕获、验证、审批和交付。

## 6. 需求追踪

- 原需求 1 产品定位与范围：范围章节、T00、T03、T12；证据 A09、A13、A18。
- 原需求 2 仓库接入与配置复用：T01、T03；证据 A01。
- 原需求 3 从失败 PR 创建任务：T02、T05、T06；证据 A02、A15 及确认页面验收。
- 原需求 4 环境准备与版本管理：T04；证据 A03、A04。
- 原需求 5 测试契约与失败复现：T06、T07；证据 A04、A05、A20。
- 原需求 6 后台执行、预算与失败处理：T08、T09；证据 A06、A07、A14、A16、A19。
- 原需求 7 进度展示与通知：T10；证据 A08、A17。
- 原需求 8 GitHub 授权与修复交付：T03、T11；证据 A09、A10、A11、A12、A20。

## 7. 建议实施顺序与里程碑

阶段编号表示功能分组；推荐单人执行顺序如下，运行控制提前到真实模型任务之前：

T00 → T01 → T02 → T03 → T04 → T05 → T06 → T08a/T08b → T07 → T08c/T08d → T09 → T10 → T11 → T12。

明确依赖：T04 依赖 T00/T02/T03；T05 依赖 T00/T03；T06 依赖 T02/T05；T07 依赖 T04/T06 的快照与测试契约；T08a/b 依赖 T01/T02/T03，T08c/d 依赖 T00 和 a/b；T09 依赖 T07/T08；T10 对接 T08/T09；T11 依赖 T03/T07/T08/T09 并复用 T10 的持久事件机制；T12 依赖全部。工作包之间不自动启用多 Agent 并行。

- **M0 范围可验证：T00。** 一个真实 PR 和选定模型具备可重复证据；不满足时调整支持矩阵，不继续承诺通用可用。
- **M1 可接入用户仓库：T01–T04。** 仓库配置可复用，任务固定 SHA，环境版本可追溯，本地授权已生效。只能运行环境准备/确定性检查或显式 mock；还没有真实模型试用入口。
- **M2 可内部试用：T05–T09。** PR 导入确认、复现、修复、验证、预算、运行控制和失败工件形成闭环。可人工下载补丁，不代表 GitHub 交付验收完成。此里程碑前不开放无人值守的真实模型任务。
- **M3 第一版可交付：T10–T12。** 站内进度通知、审批交付和真实仓库发布验收全部通过。

此前 8–12 周是粗略量级估算，不是承诺排期。审查确认恢复控制、数据迁移、事件接管和浏览器自动化也是必需工作，不应隐含在“补齐”中。T00 建议先投入 2–3 个工作日获取证据；完成后按上述工作包分别估算开发、故障测试和联调时间，重新给出 M1/M2/M3 日期。T00 样本不能复现或预算上界不可证明时，当场记录限制并修订方案，不能以等待样本无限延长开发。

建议每个 T 任务单独提交/PR，T04、T08、T11 可按契约、后端、集成测试再拆。已有未提交改动先识别归属。每个阶段完成后更新本文件复选框并附实际测试命令及证据路径；没有证据时不勾选完成。

## 8. 可选增量与下一步

核心验收完成后，可按需求增加：Node 环境模板、验证后自动创建草稿 PR、GitHub App 授权、fork PR、依赖环境变更、原 PR 分支追加提交。自动草稿模式需在任务确认时单独授权，并复用 T11 的分支检查和幂等交付机制。

下一步开发从 **T00 支持矩阵与最小风险验证** 开始，再进入 T01/T02 的数据契约与固定 SHA。T00 只验证必要边界，不建设通用环境识别框架。

## 9. 本轮审查结论与修订依据

以下问题已经修改计划；并不表示对应系统功能已经实现。

1. **P1：暂停/取消缺少可执行链路。** `apps/agent-runtime/src/arp_runtime/worker.py` 对 CANCEL_RUN 仅 ACK，重复 claim 后仍进入执行；`apps/control-plane/src/modules/internal/internal.controller.ts` 的 checkpoint/heartbeat 缺少持有者标识。T08 增加控制 API、独立取消路径和 fencing，并提前作为真实模型试用门禁；对应 A16。
2. **P1：交付与事件恢复不能复用当前队列即宣称可靠。** `apps/control-plane/src/modules/dispatch/outbox-publisher.ts` 固定写 run-commands；`apps/control-plane/src/modules/events/trace-event-ingestor.ts` 没有 pending 接管；生命周期存在事务内广播。T10/T11 明确 topic 路由、提交后发布、事件补偿和数据库对账；对应 A11/A17。
3. **P1：CI SHA 语义及支持边界会阻塞常见 PR。** PR head 与临时合并提交不同，run 元数据不一定等于实际 checkout。T00/T05 区分来源证据，并让 head 上可复现的常见 merge-ref CI 进入流程；对应 A15。
4. **P1：严格 Token 预算原方案过度承诺。** 当前压缩模型有 SDK 重试，用量也可能缺失。T08 明确上界、真实调用预留、unknown 处理和 Judge 降级；保留 Worker 侧调用，避免无必要的独立代理；对应 A19。
5. **P1：凭据接入早于本地授权。** 原计划把 API 保护放在 T12，T03 已开始接收真实凭据。已提前到 T03，明确凭据写入入口例外和 Git argv 泄漏处理；对应 A09/A13。
6. **P2：不可变快照与旧版本拒绝、legacy/fake 兼容冲突。** T01 允许存在的旧配置版本，增加 schemaVersion、REAL/MOCK 区分和升级停机策略，不用当前 SHA 猜测历史；对应 A18。
7. **P2：本地镜像未必有 registry digest。** T04 固定本地 image ID，可选保存 registry digest；补充构建租约、缓存失效与镜像丢失行为，不额外要求 registry；对应 A03。
8. **P1：补丁和验证证据可能不对应。** 现有 diff 路径可能漏 untracked 文件，Agent 工作区元数据不宜作为权威基线。T07/T11 补充完整补丁、干净验证、测试集合核对及审批内容绑定；对应 A20。
9. **P2：首版承诺与里程碑过于宽泛。** 新增 T00 和明确支持矩阵，保留静态检查失败入口，补齐前端自动化命令、独立测试库、模型试用门禁和排期复估条件；第一版仍覆盖原八项需求。

本轮只审查并修改计划文档。实现复选框维持未完成；开发测试和真实外部验收在相应工作包中执行。

## 10. 实施记录（2026-10-06）

用户后续已授权开始构建整个第一阶段；真实 GitHub／模型端到端验收明确暂缓。本文前面的细分复选框保留作为逐项验收清单，不把尚未执行的真实样本门禁自动标为通过。

本轮已实现：仓库配置版本与默认交付、读取/写入凭据引用、本机会话授权、PR/Actions 导入、固定 SHA 草稿与幂等确认、关联后继任务、环境指纹/镜像绑定、独立修复与验证沙箱、基线复现、pytest 测试集合保护、跨尝试预算预留/结算、租约隔离与运行控制、Outbox 重投/事件补收、持久 SSE/通知、审批绑定补丁摘要，以及独立幂等 GitHub 交付作业。同步提供升级迁移、浏览器测试、数据库集成测试与本地 Docker 端到端脚本。

实现调整：

- 同主机环境构建使用指纹文件锁及本地持久状态/日志，Run/EnvironmentVersion 在数据库绑定；没有新增独立环境 Worker。
- 交付队列直接使用 PostgreSQL DeliveryJob 租约轮询，避免将 GitHub 出站绑定到 Agent 的 Redis 修复命令。
- 通知由数据库状态转换触发器写入；SSE 从已提交 PostgreSQL 事件轮询恢复，不依赖进程内广播正确性。
- 源代码获取使用用户已克隆的本地仓库，缺失准确 SHA 时仅获取该对象；不提供首版通用一键克隆/任意仓库自动安装。
- 旧 fixture 评测继续使用原接口；恢复复用初始命令。旧活跃任务升级后要求重新确认；真实 GitHub 交付统一要求新快照流程。

本地执行证据、支持限制、运行步骤和暂缓的外部验收见 `docs/acceptance/local-pr-preflight.md`。真实 GitHub 权限/写入/后续 CI 与真实模型的硬预算保证仍需外部验收，不纳入此次本地通过结论。
