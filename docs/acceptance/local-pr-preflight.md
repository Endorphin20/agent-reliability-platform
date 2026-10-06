# 本地 PR 修复：运行与验收

2026-10-06。用户已明确同意暂不做真实 GitHub／真实模型端到端验收。以下本地结果不能替代生产端点的预算语义或真实 PR 验收。

## 首版支持范围

- 本机单用户，API + Worker 运行在同一受信主机，PostgreSQL/Redis 使用 Compose。
- Python / pytest，源码直接运行；已有本地镜像，或单一 requirements 哈希锁文件中的公开 wheel 依赖。需自行先克隆目标仓库；缺失的准确提交由平台使用读取凭据获取。
- 自带沙箱镜像的 Python/架构以 `docker image inspect arp-sandbox:latest` 和镜像内 Python 版本为准；Run 绑定实际 image ID，不把 latest 当版本。
- GitHub.com 的开放、同仓库 PR；不支持 fork、私有依赖、源码安装脚本、外部数据库服务、任意仓库零配置。
- Actions run 的 head SHA 不能证明 workflow checkout SHA。导入保留未知状态，用户核对日志；执行版本固定为确认的 PR head SHA。
- 默认人工审查补丁，或审批后创建指向原 PR 源分支的新修复 PR。不会自动合并；GitHub CI 由仓库 workflow 决定。

## 启动

1. 复制 `.env.example` 为 `.env`，按 `scripts/setup.sh` 安装依赖及创建沙箱镜像。已有安装升级前停止旧 Worker/API；备份数据库，再运行 `pnpm -C apps/control-plane exec prisma migrate deploy`。新增迁移保留历史终态，旧活跃任务转人工处理，需重新确认。
2. `docker compose up -d` 启动基础设施。新默认只监听 127.0.0.1，Redis 开启 AOF。API/Worker 读取相同 `ARP_DATA_DIR`，缺省 `~/.arp`。
3. 设置 `MOCK_MODE=false` 和自己的模型配置。必须设置真实服务保证的 `LLM_CONTEXT_TOKEN_LIMIT`、`LLM_MAX_OUTPUT_TOKENS`；未设置输入上界时拒绝 REAL 模型调用。预算必须容纳至少一次“输入上界 + 最大输出”的预留。
4. 运行 `./scripts/dev.sh`。打开 `/settings`，使用本机 `~/.arp/access-token` 登录；不要把这个文件或 `.env` 上传到仓库。
5. `/repositories` 保存仓库路径、环境、命令、允许/保护范围及默认交付方式。可分别保存读取和写入 PAT；界面不回显已保存密钥。GitHub fine-grained PAT 只选择所需仓库：读取 Contents/Actions/Checks/PR；交付另需 Contents 和 Pull requests 写入权限。连接检查不是 Token 全部 scope 的证明，交付仍检查 API 响应。
6. `/tasks/new` 导入 PR 或手工填写 SHA、失败命令和失败标识。核对摘要、验收范围、回归覆盖和预算，勾选测试确认后排队。修改环境需先在仓库页保存新配置版本。
7. 运行页查看 SHA、镜像、阶段、报告与补丁；可暂停、恢复、取消，或调整验收创建关联后继任务。审批页批准的正是已验证补丁摘要。交付失败仅重试交付，最多 5 次，源分支变化要求重新确认任务。

## 持久化与恢复

- PostgreSQL 保存不可变任务快照、Run/Attempt、预算预留/结算、工件、事件、审批、交付任务与通知。通知由 Task 状态事务内触发器写入，浏览器关闭不丢失通知。
- Redis Streams 负责执行派发；Outbox 保留原命令并修复超过 60 秒未认领的已发布消息，重复投递由数据库 claim 拦截。SSE 从已提交事件恢复，页面不会维持任务生命周期。
- 每次执行创建独立代码副本与断网容器；验证另建干净副本。`.git`、平台凭据及模型凭据不交给容器。依赖文件、测试和执行配置受保护。
- 同主机环境构建通过指纹文件锁合并，进程退出释放锁，成功才发布镜像；构建日志和状态在 `$ARP_DATA_DIR/environments`。等待计入任务时间，构建进程受预算和租约检查限制。
- 模型预留覆盖 Agent、压缩和 Judge；用量未知保留预留并暂停，不能用恢复清零。全流程耗时和退避累计；排队与人工等待不消耗执行秒数，任务另有 7 天期限。
- 候选补丁/报告先落 `$ARP_DATA_DIR/evidence` 的 0600 文件。上报中断后保留，Worker 后续补传为证据报告，不覆盖已审批补丁，也不回退任务状态。宿主机磁盘损坏仍需要用户自己的备份。
- 交付采用 PostgreSQL 持久队列轮询，而非新增 Redis 交付流；通过租约、确定性分支/提交、PR 标记和审批补丁摘要保证重试对账。创建 PR 超时后下次重试先查询已有 PR。
- 旧 fixture 入口仍供回归/评测，新建真实 fixture 固定 SHA 并冻结恢复命令；旧 GitHub force-push 交付入口禁用，真实交付必须使用仓库快照任务。

## 本地验证命令

```sh
pnpm -C packages/shared test
pnpm -C apps/control-plane exec jest --runInBand
apps/agent-runtime/.venv/bin/python -m pytest apps/agent-runtime/tests -q
pnpm -C apps/web exec playwright test
pnpm -C apps/web lint
pnpm -C apps/web build
pnpm -C apps/control-plane build
bash scripts/e2e-local-pr.sh
```

数据库集成测试仅使用 `arp_local_pr_test`：设置 `ARP_INTEGRATION_TESTS=true`、`NODE_OPTIONS=--experimental-vm-modules`、该库的 `DATABASE_URL` 后运行 `local-pr.integration.spec.ts`。不要指向用户业务数据库。

`e2e-local-pr.sh` 创建独立数据库与临时 Git 仓库，使用真实控制面、Worker、Redis、Docker 以及本地脚本 HTTP 模型，验证确认后分支前移、基线、修复、独立验证、预算及补丁审批；不会向 GitHub 写入。日志在 `.e2e-logs/local-pr.log`。数据库保留供排查，可按输出名称自行清理。

## 尚未作为外部验收结论的项目

真实 GitHub 分支/PR 写入、Actions 后续 CI、真实供应商 usage 上界、代表性真实仓库依赖构建和故障环境压力测试。当前不声称这些已通过。自动草稿 PR、原 PR 直接追加提交、云服务、多用户与计费仍为后续范围。

## 本轮实测记录

- Shared：16 项通过；Control Plane：110 项通过。
- 独立 PostgreSQL 集成：8 项通过（普通单元命令有意跳过，单独开启后执行）。
- Python Runtime：130 项通过，包含本机 Docker 沙箱测试。
- Playwright：2 项通过，覆盖明确确认门禁与仓库配置复用。
- Web lint、TypeScript 检查、Web 生产构建、Control Plane 构建、shell 语法及 `git diff --check` 通过。
- 本地 Docker 端到端通过；最近一次记录数据库为 `arp_local_pr_e2e_5cf947d3cb`，模型为脚本 HTTP 服务，GitHub 写入次数为 0。
- GitHub 交付模拟测试覆盖目标分支变化、审批补丁变化、创建 PR 后响应丢失及重试不重复推送/建 PR；不等同于真实 GitHub 端到端验收。
