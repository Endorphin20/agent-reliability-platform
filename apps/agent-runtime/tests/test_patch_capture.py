import subprocess
from pathlib import Path
import pytest
from arp_runtime.sandbox.patch import capture_patch


def git(root, *args):
    return subprocess.run(['git', '-C', str(root), *args], check=True, text=True, capture_output=True).stdout.strip()


@pytest.fixture
def repository(tmp_path):
    git(tmp_path, 'init')
    (tmp_path / 'old.py').write_text('value = 1\n')
    git(tmp_path, 'add', '.')
    git(tmp_path, '-c', 'user.name=Test', '-c', 'user.email=test@test', 'commit', '-m', 'base')
    return tmp_path, git(tmp_path, 'rev-parse', 'HEAD')


def test_capture_includes_untracked_source(repository):
    root, sha = repository
    (root / 'new.py').write_text('value = 2\n')
    assert 'new.py' in capture_patch(root, sha)


def test_capture_omits_generated_caches(repository):
    root, sha = repository
    (root / '__pycache__').mkdir()
    (root / '__pycache__/old.pyc').write_bytes(b'\0binary')
    assert '__pycache__' not in capture_patch(root, sha)


def test_capture_rejects_symlink_changes(repository):
    root, sha = repository
    (root / 'leak').symlink_to('/etc/passwd')
    with pytest.raises(ValueError, match='symlink'):
        capture_patch(root, sha)


def test_capture_rejects_changed_head(repository):
    root, sha = repository
    (root / 'old.py').write_text('value = 3\n')
    git(root, '-c', 'user.name=Test', '-c', 'user.email=test@test', 'commit', '-am', 'tamper')
    with pytest.raises(ValueError, match='baseline'):
        capture_patch(root, sha)
