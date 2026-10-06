"""Capture complete text patches without promoting generated caches or symlinks."""
import subprocess
from pathlib import Path


def _git(root: Path, *args: str) -> bytes:
    return subprocess.run(['git', '-c', 'core.hooksPath=/dev/null', '-C', str(root), *args],
        check=True, capture_output=True, timeout=60).stdout


def capture_patch(root: Path, base_sha: str) -> str:
    actual = _git(root, 'rev-parse', 'HEAD').decode().strip()
    expected = _git(root, 'rev-parse', f'{base_sha}^{{commit}}').decode().strip()
    if actual != expected:
        raise ValueError('Working tree Git baseline changed')
    untracked = _git(root, 'ls-files', '--others', '--exclude-standard', '-z').decode().split('\0')
    for name in filter(None, untracked):
        path = Path(name)
        if any(part in ('__pycache__', '.pytest_cache', '.venv', 'node_modules') for part in path.parts) or path.suffix == '.pyc':
            continue
        target = root / path
        if target.is_symlink():
            raise ValueError('New symlink patches are not supported')
        if not target.resolve().is_relative_to(root.resolve()):
            raise ValueError('Patch path escapes repository')
        _git(root, 'add', '-N', '--', name)
    for name in filter(None, _git(root, 'diff', '--name-only', '-z', base_sha).decode().split('\0')):
        target = root / name
        if target.is_symlink():
            raise ValueError('Changed symlink patches are not supported')
    patch = _git(root, 'diff', '--no-ext-diff', '--no-textconv', base_sha).decode('utf-8')
    if 'GIT binary patch' in patch or '\nBinary files ' in patch or 'Subproject commit' in patch:
        raise ValueError('Binary and submodule patches are not supported')
    return patch
