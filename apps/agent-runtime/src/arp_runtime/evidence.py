"""Crash-safe local evidence spool. Late uploads never change task state."""
import json
import os
from pathlib import Path


def spool_directory() -> Path:
    path = Path(os.environ.get('ARP_DATA_DIR', str(Path.home() / '.arp'))) / 'evidence'
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    return path


def save_evidence(attempt_id: str, patch: str, report: dict) -> None:
    if not attempt_id.replace('-', '').replace('_', '').isalnum():
        raise ValueError('Invalid attempt ID')
    path = spool_directory() / f'{attempt_id}.json'
    temporary = path.with_suffix('.tmp')
    with temporary.open('w') as stream:
        os.chmod(temporary, 0o600)
        json.dump({'attemptId': attempt_id, 'patch': patch, 'report': report}, stream)
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(path)


def flush_evidence(cp) -> None:
    for path in spool_directory().glob('*.json'):
        payload = json.loads(path.read_text())
        response = cp._client.post(f"/internal/attempts/{payload['attemptId']}/evidence", json=payload)
        response.raise_for_status()
        path.unlink()
