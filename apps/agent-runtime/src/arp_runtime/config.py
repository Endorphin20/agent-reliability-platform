"""运行时配置：pydantic-settings 单例（与 python/ai-agent 的模式一致）。"""

from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

BASE_DIR = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=str(BASE_DIR / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    database_url: str = Field(
        default="postgresql://arp:arp@localhost:5432/arp", alias="DATABASE_URL"
    )
    redis_url: str = Field(default="redis://localhost:6379", alias="REDIS_URL")
    control_plane_url: str = Field(default="http://localhost:3001", alias="CONTROL_PLANE_URL")
    worker_id: str = Field(default="worker-1", alias="WORKER_ID")
    heartbeat_ms: int = Field(default=10000, alias="HEARTBEAT_MS")

    mock_mode: bool = Field(default=True, alias="MOCK_MODE")
    llm_provider: str = Field(default="openai", alias="LLM_PROVIDER")
    llm_model: str = Field(default="glm-4.6v", alias="LLM_MODEL")
    llm_api_key: str = Field(default="", alias="LLM_API_KEY")
    llm_base_url: str = Field(default="", alias="LLM_BASE_URL")
    judge_llm_model: str = Field(default="", alias="JUDGE_LLM_MODEL")
    judge_llm_api_key: str = Field(default="", alias="JUDGE_LLM_API_KEY")
    judge_llm_base_url: str = Field(default="", alias="JUDGE_LLM_BASE_URL")

    sandbox_image: str = Field(default="arp-sandbox:latest", alias="SANDBOX_IMAGE")
    sandbox_cpus: float = Field(default=2, alias="SANDBOX_CPUS")
    sandbox_memory: str = Field(default="2g", alias="SANDBOX_MEMORY")
    sandbox_timeout_s: int = Field(default=900, alias="SANDBOX_TIMEOUT_S")
    sandbox_network_mode: str = Field(default="none", alias="SANDBOX_NETWORK_MODE")

    fixture_repo_path: str = Field(default="~/Coding/agent-reliability/agent-fixture-repo", alias="FIXTURE_REPO_PATH")
    fault_inject: str = Field(default="", alias="FAULT_INJECT")

    # XAUTOCLAIM 接管：空闲超过该阈值的 pending 消息视为死 consumer 遗留
    # （应大于单条命令的正常处理时长上限；实际恢复由租约兜底，这里是快路径 + PEL 清理）
    reclaim_min_idle_ms: int = Field(default=60_000, alias="RECLAIM_MIN_IDLE_MS")
    reclaim_interval_s: int = Field(default=30, alias="RECLAIM_INTERVAL_S")

    # 上下文管理模式：fold=旧工具结果折叠为占位符（零成本）；
    # condense=用一次廉价模型调用压成摘要（花小钱保信息，实验八对比）
    context_mode: str = Field(default="fold", alias="CONTEXT_MODE")
    condenser_llm_model: str = Field(default="", alias="CONDENSER_LLM_MODEL")


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
