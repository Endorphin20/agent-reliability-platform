# arp-sandbox: 受控执行环境。刻意不安装 curl/wget/ssh/docker，网络默认由运行参数关闭。
# 测试工具链（tsc/pytest）直接烘进镜像：沙箱断网时任务无需在容器内装依赖，
# dep_config 类任务是例外（走 allowlist 网络，见计划 §8）。
FROM node:20-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends git python3.11 python3.11-venv python3-pip ca-certificates coreutils \
    && rm -rf /var/lib/apt/lists/* \
    && ln -sf /usr/bin/python3.11 /usr/local/bin/python3 \
    && ln -sf /usr/bin/python3.11 /usr/local/bin/python \
    && corepack enable && corepack prepare pnpm@latest --activate \
    && npm install -g typescript@5.6 \
    && python3 -m pip install --break-system-packages pytest==8.3.3 \
    # SWE-bench 子集（django/sympy 从源码跑测试）的最小运行依赖
    && python3 -m pip install --break-system-packages asgiref==3.8.1 sqlparse==0.5.3 mpmath==1.3.0

# uv 用于 dep_config 任务的依赖安装（allowlist 网络或缓存镜像）
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/

RUN useradd -m -u 10001 agent
USER agent
WORKDIR /workspace

CMD ["sleep", "infinity"]
