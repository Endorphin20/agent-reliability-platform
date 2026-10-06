"""packages/shared/src/run-command.ts 的 Pydantic 镜像。"""

from pydantic import BaseModel, ConfigDict, Field
from typing import Literal
from arp_runtime.schemas.task_snapshot import TaskSnapshot

from arp_runtime.schemas.enums import AgentKind, RunCommandType


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid")


class TaskSpec(_Model):
    fixtureId: str | None = None
    description: str
    workdir: str
    allowedPaths: list[str]
    staticCheck: list[str]
    failToPass: list[str]
    passToPass: list[str]
    # LLM Judge 逐条打分依据（zod 侧必填；此处给默认值兼容存量 outbox 消息）
    acceptanceCriteria: list[str] = Field(default_factory=list)
    # SWE-bench 类任务的基准自带测试补丁：Agent 不可见，仅 Verifier 使用
    testPatch: str | None = None


class Budget(_Model):
    tokens: int = Field(ge=1)
    seconds: int = Field(ge=1)
    turns: int = Field(ge=1)
    remainingTokens: int = Field(ge=0)
    remainingSeconds: int = Field(ge=0)


class RepoRef(_Model):
    path: str
    baseCommit: str


class RunCommand(_Model):
    schemaVersion: Literal[2] | None = None
    snapshot: TaskSnapshot | None = None
    commandId: str = Field(min_length=1)
    type: RunCommandType
    runId: str = Field(min_length=1)
    attemptNo: int = Field(ge=1)
    agentKind: AgentKind
    repo: RepoRef
    taskSpec: TaskSpec
    budget: Budget
    checkpointId: str | None = None


def run_command_id(run_id: str, command_type: str, attempt_no: int) -> str:
    return f"cmd:{run_id}:{command_type}:{attempt_no}"
