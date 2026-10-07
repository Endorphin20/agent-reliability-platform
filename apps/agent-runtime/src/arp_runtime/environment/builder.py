"""Immutable local image identities with content-addressed dependency builds."""
import hashlib
import io
import json
import tarfile
import fcntl
import os
import tempfile
import time
import subprocess
from pathlib import Path


def environment_fingerprint(image_id: str, architecture: str, dependencies: dict[str, bytes], recipe: str) -> str:
    payload = dict(image=image_id, architecture=architecture, recipe=recipe,
        dependencies={name: hashlib.sha256(value).hexdigest() for name, value in sorted(dependencies.items())})
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()


def prepare_environment(client, repo_path: str, sha: str, config, timeout_s: int = 600, check_lease=lambda: None):
    base = client.images.get(config.image)  # Missing images are an explicit preparation failure.
    dependencies = {}
    for name in config.dependencyFiles:
        dependencies[name] = subprocess.run(['git', '-C', repo_path, 'show', f'{sha}:{name}'],
            check=True, capture_output=True, timeout=30).stdout
    fingerprint = environment_fingerprint(base.id, base.attrs['Architecture'], dependencies,
        f'python-pytest-v1:{config.preparation}')
    if config.preparation == 'image':
        return fingerprint, base.id, 'Using prebuilt image'
    if len(dependencies) != 1:
        raise ValueError('requirements preparation requires exactly one hash-locked dependency file')
    tag = f'arp-env:{fingerprint}'
    try:
        image = client.images.get(tag)
        return fingerprint, image.id, 'Reused cached environment'
    except Exception as exc:
        from docker.errors import ImageNotFound
        if not isinstance(exc, ImageNotFound):
            raise
    # A minimal context: no repository secrets, arbitrary setup scripts or source tree.
    dockerfile = (f'FROM {base.id}\nUSER root\nCOPY requirements.lock /tmp/requirements.lock\n'
        'RUN python -m venv /opt/arp-env && /opt/arp-env/bin/pip install --only-binary=:all: --require-hashes -r /tmp/requirements.lock\n'
        'ENV PATH="/opt/arp-env/bin:$PATH"\nUSER 10001\n').encode()
    lock = next(iter(dependencies.values()))
    # Disallow alternate indexes, includes, direct URLs and local source paths.
    for line in lock.decode().splitlines():
        text = line.strip()
        if text and not text.startswith('#') and (text.startswith(('-r', '-e', '--index', '--extra', '--find', '--trusted')) or '://' in text or ' @ ' in text):
            raise ValueError('Only public, hash-locked wheel dependencies are supported')
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode='w') as archive:
        for name, data in [('Dockerfile', dockerfile), ('requirements.lock', lock)]:
            member = tarfile.TarInfo(name)
            member.size = len(data)
            archive.addfile(member, io.BytesIO(data))
    buffer.seek(0)
    # The local host is the scheduling boundary. flock merges concurrent workers and
    # is automatically released after crashes; only successful builds get a tag.
    state = Path(os.environ.get('ARP_DATA_DIR', str(Path.home() / '.arp'))) / 'environments'
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    deadline = time.monotonic() + min(timeout_s, 600)
    with (state / f'{fingerprint}.lock').open('a') as lockfile:
        while True:
            check_lease()
            if time.monotonic() >= deadline:
                raise TimeoutError('Environment preparation time budget exhausted')
            try:
                fcntl.flock(lockfile, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                time.sleep(0.2)
        try:
            image = client.images.get(tag)
            return fingerprint, image.id, 'Reused cached environment'
        except Exception as exc:
            from docker.errors import ImageNotFound
            if not isinstance(exc, ImageNotFound):
                raise
        status_path = state / f'{fingerprint}.json'
        status_path.write_text(json.dumps({'status': 'PREPARING', 'fingerprint': fingerprint}))
        with tempfile.TemporaryDirectory(prefix='arp-build-') as context:
            Path(context, 'Dockerfile').write_bytes(dockerfile)
            Path(context, 'requirements.lock').write_bytes(lock)
            with (state / f'{fingerprint}.log').open('w+') as output:
                process = subprocess.Popen(['docker', 'build', '--tag', tag, context], stdout=output, stderr=subprocess.STDOUT)
                try:
                    while process.poll() is None:
                        check_lease()
                        if time.monotonic() >= deadline:
                            raise TimeoutError('Environment preparation time budget exhausted')
                        time.sleep(0.2)
                    output.seek(0)
                    log = output.read()[-20000:]
                    if process.returncode:
                        raise RuntimeError('Environment dependency build failed: ' + log)
                    image = client.images.get(tag)
                    status_path.write_text(json.dumps({'status': 'READY', 'imageId': image.id, 'fingerprint': fingerprint}))
                    return fingerprint, image.id, log
                except BaseException:
                    process.terminate()
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait()
                    status_path.write_text(json.dumps({'status': 'FAILED', 'fingerprint': fingerprint}))
                    raise
