"""Versioned immutable user-confirmed task input (shared with @arp/shared)."""
from typing import Annotated, Literal
from pydantic import BaseModel, ConfigDict, Field, AfterValidator


class StrictModel(BaseModel):
    model_config = ConfigDict(extra='forbid')


def relative(value: str) -> str:
    if value.startswith('/') or '\\' in value or '..' in value.split('/') or any(ord(c) < 32 for c in value):
        raise ValueError('Path must stay within repository')
    return value


RelativePath = Annotated[str, Field(min_length=1, max_length=512), AfterValidator(relative)]
Sha = Annotated[str, Field(pattern=r'^[0-9a-f]{40}$')]
Command = Annotated[str, Field(min_length=1, max_length=4096)]


class RepositoryConfig(StrictModel):
    runtime: Literal['python-pytest']
    defaultDelivery: Literal['patch', 'pull-request'] | None = None
    preparation: Literal['image', 'requirements']
    image: str = Field(min_length=1, max_length=512)
    dependencyFiles: list[RelativePath] = Field(default_factory=list)
    workdir: RelativePath = '.'
    allowedPaths: list[RelativePath] = Field(min_length=1)
    protectedPaths: list[RelativePath] = Field(default_factory=list)
    staticCheck: list[Command]
    failToPass: list[Command]
    passToPass: list[Command]
    acceptanceCriteria: list[Annotated[str, Field(min_length=1)]] = Field(min_length=1)


class Baseline(StrictModel):
    command: Command
    expected: list[Annotated[str, Field(min_length=1)]] = Field(min_length=1)


class TaskBudget(StrictModel):
    tokens: int = Field(gt=0, le=10000000)
    seconds: int = Field(gt=0, le=86400)
    turns: int = Field(gt=0, le=1000)
    maxAttempts: int = Field(gt=0, le=20)


class Delivery(StrictModel):
    kind: Literal['patch', 'pull-request']
    targetBranch: str = Field(min_length=1, max_length=255)
    expectedTargetSha: Sha


class Source(StrictModel):
    prUrl: str
    headSha: Sha
    baseSha: Sha
    ciSha: str | None
    evidence: str = Field(max_length=100000)


class TaskSnapshot(StrictModel):
    schemaVersion: Literal[2]
    mode: Literal['REAL']
    repositoryId: str = Field(min_length=1)
    parentTaskId: str | None = None
    configVersion: int = Field(gt=0)
    executionSha: Sha
    agentKind: Literal['SELF_LANGGRAPH', 'MINI_SWE']
    title: str = Field(min_length=1, max_length=300)
    description: str = Field(min_length=1, max_length=100000)
    config: RepositoryConfig
    baseline: Baseline
    budget: TaskBudget
    delivery: Delivery
    source: Source | None = None
