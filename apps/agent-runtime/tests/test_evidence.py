import json
from arp_runtime.evidence import save_evidence, flush_evidence


def test_local_patch_survives_failed_upload(tmp_path, monkeypatch):
    monkeypatch.setenv('ARP_DATA_DIR', str(tmp_path))
    save_evidence('attempt-1', 'candidate diff', {'status': 'FAILED'})
    path = tmp_path / 'evidence/attempt-1.json'
    assert json.loads(path.read_text())['patch'] == 'candidate diff'
    assert path.stat().st_mode & 0o777 == 0o600
    class Broken:
        def post(self, *args, **kwargs):
            raise ConnectionError('offline')
    from types import SimpleNamespace
    import pytest
    with pytest.raises(ConnectionError):
        flush_evidence(SimpleNamespace(_client=Broken()))
    assert path.exists()
