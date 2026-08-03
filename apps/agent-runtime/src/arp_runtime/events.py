"""TraceEvent 发射器：attempt 内单调分配 attemptSequence，XADD 到 trace-events。"""

import json
from datetime import datetime, timezone
from typing import Any

import redis

from arp_runtime.schemas.trace_event import trace_event_idempotency_key

TRACE_EVENTS_STREAM = "trace-events"


class EventEmitter:
    def __init__(
        self,
        client: redis.Redis,
        run_id: str,
        attempt_id: str,
        attempt_no: int,
        start_sequence: int = 0,
    ) -> None:
        self._client = client
        self._run_id = run_id
        self._attempt_id = attempt_id
        self._attempt_no = attempt_no
        self._sequence = start_sequence  # 恢复场景从 checkpoint 的序列继续

    @property
    def sequence(self) -> int:
        return self._sequence

    @property
    def attempt_no(self) -> int:
        return self._attempt_no

    def emit(self, event_type: str, payload: dict[str, Any]) -> int:
        self._sequence += 1
        event = {
            "runId": self._run_id,
            "attemptId": self._attempt_id,
            "attemptNo": self._attempt_no,
            "attemptSequence": self._sequence,
            "occurredAt": datetime.now(timezone.utc)
            .isoformat(timespec="milliseconds")
            .replace("+00:00", "Z"),
            "idempotencyKey": trace_event_idempotency_key(
                self._run_id, self._attempt_no, self._sequence
            ),
            "type": event_type,
            "payload": payload,
        }
        self._client.xadd(TRACE_EVENTS_STREAM, {"data": json.dumps(event, ensure_ascii=False)})
        return self._sequence
