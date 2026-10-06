"""Control Plane 内部 API 客户端：认领 / 续租 / 完结上报。"""

from typing import Any
import hashlib
import hmac
import os
from pathlib import Path

import httpx

from arp_runtime.config import get_settings


class ControlPlaneClient:
    def __init__(self) -> None:
        settings = get_settings()
        token_path = Path(os.environ.get("ARP_DATA_DIR", str(Path.home() / ".arp"))) / "access-token"
        access = token_path.read_text().strip() if token_path.exists() else ""
        token = os.environ.get("ARP_WORKER_TOKEN") or hmac.new(access.encode(), b"arp-worker", hashlib.sha256).hexdigest()
        self._client = httpx.Client(base_url=settings.control_plane_url, timeout=10.0,
            headers={"Authorization": f"Bearer {token}"})
        self._leases: dict[str, str] = {}

    def claim_attempt(self, run_id: str, attempt_no: int, worker_id: str) -> dict[str, Any]:
        response = self._client.post(
            "/internal/attempts/claim",
            json={"runId": run_id, "attemptNo": attempt_no, "workerId": worker_id},
        )
        response.raise_for_status()
        result = response.json()
        if result.get("leaseToken"):
            self._leases[result["attemptId"]] = result["leaseToken"]
        return result

    def headers(self, attempt_id: str) -> dict[str, str]:
        return {"x-arp-lease": self._leases.get(attempt_id, "")}

    def heartbeat(self, attempt_id: str) -> None:
        response = self._client.post(f"/internal/attempts/{attempt_id}/heartbeat", headers=self.headers(attempt_id))
        response.raise_for_status()

    def complete_attempt(self, attempt_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        response = self._client.post(f"/internal/attempts/{attempt_id}/complete", json=payload, headers=self.headers(attempt_id))
        response.raise_for_status()
        return response.json()

    def save_checkpoint(self, run_id: str, payload: dict[str, Any]) -> str:
        response = self._client.post(f"/internal/runs/{run_id}/checkpoints", json=payload, headers=self.headers(payload["attemptId"]))
        response.raise_for_status()
        return response.json()["checkpointId"]

    def get_checkpoint(self, checkpoint_id: str) -> dict[str, Any]:
        response = self._client.get(f"/internal/checkpoints/{checkpoint_id}")
        response.raise_for_status()
        return response.json()


    def phase(self, attempt_id: str, phase: str, detail: dict | None = None):
        r = self._client.post(f"/internal/attempts/{attempt_id}/phase", headers=self.headers(attempt_id),
            json={"phase": phase, **({"detail": detail} if detail is not None else {})})
        r.raise_for_status()
        return r.json()

    def pause(self, attempt_id: str, reason: str, patch: str = ""):
        r = self._client.post(f"/internal/attempts/{attempt_id}/pause", headers=self.headers(attempt_id), json={"reason": reason, "patch": patch})
        r.raise_for_status()
        return r.json()

    def environment(self, attempt_id: str, fingerprint: str, image_id: str, log: str):
        r = self._client.post(f"/internal/attempts/{attempt_id}/environment", headers=self.headers(attempt_id),
            json={"fingerprint": fingerprint, "imageId": image_id, "log": log})
        r.raise_for_status()
        return r.json()

    def budget_reserve(self, run_id: str, attempt_id: str, request_id: str, reserved: int):
        r = self._client.post(f"/internal/runs/{run_id}/budget/reserve", headers=self.headers(attempt_id),
            json={"attemptId": attempt_id, "id": request_id, "reserved": reserved})
        r.raise_for_status()
        return r.json()

    def budget_settle(self, run_id: str, request_id: str, used: int | None):
        r = self._client.post(f"/internal/runs/{run_id}/budget/settle", json={"id": request_id, "used": used})
        r.raise_for_status()
        return r.json()

    def close(self) -> None:
        self._client.close()
