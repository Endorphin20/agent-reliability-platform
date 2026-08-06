"""packages/shared/src/trace-event.ts 的 Pydantic 镜像。

payload 按 type 收窄（discriminated union），序列化结果必须通过
shared/schemas/trace-event.json 的 JSON Schema 校验（契约测试保证）。
"""

from datetime import datetime, timezone
from typing import Annotated, Any, Literal, Union

from pydantic import BaseModel, ConfigDict, Field, field_serializer

from arp_runtime.schemas.enums import FailureCode, PolicyAction, VerifierStep


def trace_event_idempotency_key(run_id: str, attempt_no: int, attempt_sequence: int) -> str:
    return f"{run_id}:{attempt_no}:{attempt_sequence}"


class _Payload(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ModelCallPayload(_Payload):
    model: str
    promptTokens: int = Field(ge=0)
    completionTokens: int = Field(ge=0)
    latencyMs: int = Field(ge=0)
    turn: int = Field(ge=0)


class ToolCallPayload(_Payload):
    toolCallId: str
    tool: str
    args: dict[str, Any]
    resultDigest: str
    durationMs: int = Field(ge=0)
    cached: bool
    # 工具执行失败时的错误信息（guard 拒绝等）。失败调用同样是审计信息。
    error: str | None = None


class DiffStat(_Payload):
    additions: int = Field(ge=0)
    deletions: int = Field(ge=0)


class FileChangePayload(_Payload):
    path: str
    changeType: Literal["modify", "create", "delete"]
    diffStat: DiffStat


class CommandExecPayload(_Payload):
    command: str
    exitCode: int
    stdoutTail: str
    durationMs: int = Field(ge=0)


class StateTransitionPayload(_Payload):
    entity: Literal["task", "run", "attempt"]
    from_: str = Field(alias="from")
    to: str


class CheckpointSavedPayload(_Payload):
    checkpointId: str
    usedTokens: int = Field(ge=0)
    usedSeconds: int = Field(ge=0)


class FailureDetectedPayload(_Payload):
    failureCode: FailureCode
    message: str


class RecoveryActionPayload(_Payload):
    action: PolicyAction
    fromCheckpointId: str | None
    newAttemptNo: int = Field(ge=1)


class VerificationResultPayload(_Payload):
    step: VerifierStep
    passed: bool
    failureCode: FailureCode | None = None
    detail: dict[str, Any]


class ApprovalEventPayload(_Payload):
    status: Literal["PENDING", "APPROVED", "REJECTED"]
    reviewer: str | None
    prUrl: str | None


class BudgetUpdatePayload(_Payload):
    usedTokens: int = Field(ge=0)
    usedSeconds: int = Field(ge=0)
    usedTurns: int = Field(ge=0)


class _Envelope(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    runId: str = Field(min_length=1)
    attemptId: str = Field(min_length=1)
    attemptNo: int = Field(ge=1)
    attemptSequence: int = Field(ge=1)
    occurredAt: datetime
    idempotencyKey: str = Field(min_length=1)

    @field_serializer("occurredAt")
    def _serialize_occurred_at(self, value: datetime) -> str:
        # zod 的 z.iso.datetime() 只接受 Z 结尾（不接受 +00:00 偏移），序列化时统一成 Z
        return value.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class ModelCallEvent(_Envelope):
    type: Literal["MODEL_CALL"] = "MODEL_CALL"
    payload: ModelCallPayload


class ToolCallEvent(_Envelope):
    type: Literal["TOOL_CALL"] = "TOOL_CALL"
    payload: ToolCallPayload


class FileChangeEvent(_Envelope):
    type: Literal["FILE_CHANGE"] = "FILE_CHANGE"
    payload: FileChangePayload


class CommandExecEvent(_Envelope):
    type: Literal["COMMAND_EXEC"] = "COMMAND_EXEC"
    payload: CommandExecPayload


class StateTransitionEvent(_Envelope):
    type: Literal["STATE_TRANSITION"] = "STATE_TRANSITION"
    payload: StateTransitionPayload


class CheckpointSavedEvent(_Envelope):
    type: Literal["CHECKPOINT_SAVED"] = "CHECKPOINT_SAVED"
    payload: CheckpointSavedPayload


class FailureDetectedEvent(_Envelope):
    type: Literal["FAILURE_DETECTED"] = "FAILURE_DETECTED"
    payload: FailureDetectedPayload


class RecoveryActionEvent(_Envelope):
    type: Literal["RECOVERY_ACTION"] = "RECOVERY_ACTION"
    payload: RecoveryActionPayload


class VerificationResultEvent(_Envelope):
    type: Literal["VERIFICATION_RESULT"] = "VERIFICATION_RESULT"
    payload: VerificationResultPayload


class ApprovalEventEvent(_Envelope):
    type: Literal["APPROVAL_EVENT"] = "APPROVAL_EVENT"
    payload: ApprovalEventPayload


class BudgetUpdateEvent(_Envelope):
    type: Literal["BUDGET_UPDATE"] = "BUDGET_UPDATE"
    payload: BudgetUpdatePayload


TraceEvent = Annotated[
    Union[
        ModelCallEvent,
        ToolCallEvent,
        FileChangeEvent,
        CommandExecEvent,
        StateTransitionEvent,
        CheckpointSavedEvent,
        FailureDetectedEvent,
        RecoveryActionEvent,
        VerificationResultEvent,
        ApprovalEventEvent,
        BudgetUpdateEvent,
    ],
    Field(discriminator="type"),
]
