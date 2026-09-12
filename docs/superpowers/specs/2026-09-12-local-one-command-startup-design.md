# 本地一键启动体验设计

## 目标

让新用户只需复制 `.env.example`、运行 `setup.sh` 和 `dev.sh`，即可在本机启动平台；路径、依赖和服务编排不依赖维护者个人电脑。面试演示支持无需真实 LLM Key 的 mock 模式。

## 方案

根目录 `.env.example` 作为唯一入口配置。`setup.sh` 检查依赖、生成各应用配置、启动 PostgreSQL/Redis、安装依赖、执行迁移并构建 sandbox 镜像。`dev.sh` 负责启动 control-plane、worker、web，统一日志和退出清理；`stop.sh` 停止应用进程但保留基础设施数据。

所有仓库路径由脚本按当前 checkout 位置解析。默认 `MOCK_MODE=true`，确保没有 API Key 时也能完成演示；设置 `MOCK_MODE=false` 后使用真实 OpenAI 兼容 LLM。

## 验证

脚本提供命令存在性、Docker 健康状态、端口冲突、服务健康接口检查；README 提供标准流程、真实模型配置、mock 模式、停止和排障说明。
