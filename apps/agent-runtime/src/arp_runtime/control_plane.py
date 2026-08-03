"""Control Plane 内部 API 客户端：认领 / 续租 / 完结上报。"""

from typing import Any

import httpx

from arp_runtime.config import get_settings


class ControlPlaneClient:
    def __init__(self) -> None:
        settings = get_settings()
        self._client = httpx.Client(base_url=settings.control_plane_url, timeout=10.0)

    def claim_attempt(self, run_id: str, attempt_no: int, worker_id: str) -> dict[str, Any]:
        response = self._client.post(
            "/internal/attempts/claim",
            json={"runId": run_id, "attemptNo": attempt_no, "workerId": worker_id},
        )
        response.raise_for_status()
        return response.json()

    def heartbeat(self, attempt_id: str) -> None:
        response = self._client.post(f"/internal/attempts/{attempt_id}/heartbeat")
        response.raise_for_status()

    def complete_attempt(self, attempt_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        response = self._client.post(f"/internal/attempts/{attempt_id}/complete", json=payload)
        response.raise_for_status()
        return response.json()

    def save_checkpoint(self, run_id: str, payload: dict[str, Any]) -> str:
        response = self._client.post(f"/internal/runs/{run_id}/checkpoints", json=payload)
        response.raise_for_status()
        return response.json()["checkpointId"]

    def get_checkpoint(self, checkpoint_id: str) -> dict[str, Any]:
        response = self._client.get(f"/internal/checkpoints/{checkpoint_id}")
        response.raise_for_status()
        return response.json()

    def close(self) -> None:
        self._client.close()
