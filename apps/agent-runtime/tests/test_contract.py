"""双端契约测试（§4.10）。

真相源是 packages/shared 的 zod 定义（生成物 schemas/*.json 提交入库）。
本测试保证：
1. shared/fixtures 的共享样例能被 Pydantic 解析；
2. Pydantic 序列化结果能通过 shared/schemas 的 JSON Schema 校验（round-trip）；
3. Python 枚举与 shared/schemas/enums.json 的集合完全一致。
"""

import json
from pathlib import Path

import pytest
from jsonschema import Draft7Validator
from pydantic import TypeAdapter

from arp_runtime import schemas as s
from arp_runtime.schemas import RunCommand, TraceEvent, trace_event_idempotency_key

SHARED_DIR = Path(__file__).resolve().parents[3] / "packages" / "shared"
FIXTURES_DIR = SHARED_DIR / "fixtures"
SCHEMAS_DIR = SHARED_DIR / "schemas"

trace_event_adapter = TypeAdapter(TraceEvent)
run_command_adapter = TypeAdapter(RunCommand)


def load_json(path: Path):
    return json.loads(path.read_text())


@pytest.fixture(scope="module")
def trace_event_fixtures() -> list[dict]:
    return load_json(FIXTURES_DIR / "trace-events.json")


@pytest.fixture(scope="module")
def run_command_fixtures() -> list[dict]:
    return load_json(FIXTURES_DIR / "run-commands.json")


@pytest.fixture(scope="module")
def trace_event_validator() -> Draft7Validator:
    return Draft7Validator(load_json(SCHEMAS_DIR / "trace-event.json"))


@pytest.fixture(scope="module")
def run_command_validator() -> Draft7Validator:
    return Draft7Validator(load_json(SCHEMAS_DIR / "run-command.json"))


class TestTraceEventContract:
    def test_fixtures_parse_with_pydantic(self, trace_event_fixtures):
        for raw in trace_event_fixtures:
            event = trace_event_adapter.validate_python(raw)
            assert event.idempotencyKey == trace_event_idempotency_key(
                event.runId, event.attemptNo, event.attemptSequence
            )

    def test_fixtures_cover_all_event_types(self, trace_event_fixtures):
        covered = {raw["type"] for raw in trace_event_fixtures}
        expected = {member.value for member in s.TraceEventType}
        assert covered == expected

    def test_pydantic_roundtrip_passes_json_schema(
        self, trace_event_fixtures, trace_event_validator
    ):
        for raw in trace_event_fixtures:
            event = trace_event_adapter.validate_python(raw)
            dumped = trace_event_adapter.dump_python(
                event, mode="json", by_alias=True, exclude_unset=True
            )
            errors = list(trace_event_validator.iter_errors(dumped))
            assert not errors, f"{raw['type']}: {[e.message for e in errors]}"

    def test_mismatched_payload_rejected(self, trace_event_fixtures):
        bad = dict(trace_event_fixtures[0])
        assert bad["type"] == "MODEL_CALL"
        bad["type"] = "TOOL_CALL"
        with pytest.raises(Exception):
            trace_event_adapter.validate_python(bad)


class TestRunCommandContract:
    def test_fixtures_parse_with_pydantic(self, run_command_fixtures):
        for raw in run_command_fixtures:
            run_command_adapter.validate_python(raw)

    def test_resume_has_checkpoint(self, run_command_fixtures):
        commands = [run_command_adapter.validate_python(raw) for raw in run_command_fixtures]
        resume = next(c for c in commands if c.type == s.RunCommandType.RESUME_RUN)
        assert resume.checkpointId

    def test_pydantic_roundtrip_passes_json_schema(
        self, run_command_fixtures, run_command_validator
    ):
        for raw in run_command_fixtures:
            command = run_command_adapter.validate_python(raw)
            dumped = run_command_adapter.dump_python(
                command, mode="json", by_alias=True, exclude_unset=True
            )
            errors = list(run_command_validator.iter_errors(dumped))
            assert not errors, [e.message for e in errors]


class TestEnumParity:
    """Python 枚举与 shared enums.json 集合比对，任何一端增减值都会失败。"""

    PY_ENUMS = {
        "TaskSource": s.TaskSource,
        "TaskStatus": s.TaskStatus,
        "RunStatus": s.RunStatus,
        "AttemptStatus": s.AttemptStatus,
        "AgentKind": s.AgentKind,
        "TraceEventType": s.TraceEventType,
        "FailureCode": s.FailureCode,
        "PolicyAction": s.PolicyAction,
        "ApprovalStatus": s.ApprovalStatus,
        "OutboxStatus": s.OutboxStatus,
        "ArtifactKind": s.ArtifactKind,
        "RunCommandType": s.RunCommandType,
        "VerifierStep": s.VerifierStep,
    }

    def test_enum_sets_match_shared(self):
        shared_enums = load_json(SCHEMAS_DIR / "enums.json")
        assert set(shared_enums.keys()) == set(self.PY_ENUMS.keys())
        for name, values in shared_enums.items():
            py_values = {member.value for member in self.PY_ENUMS[name]}
            assert py_values == set(values), f"枚举 {name} 双端不一致"
