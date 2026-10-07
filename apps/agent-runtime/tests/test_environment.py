from arp_runtime.environment.builder import environment_fingerprint


def test_environment_cache_key_ignores_application_source_but_tracks_dependencies():
    args = dict(image_id='sha256:base', architecture='arm64', dependencies={'requirements.lock': b'pytest==8.3.3'}, recipe='python-pytest-v1')
    original = environment_fingerprint(**args)
    assert environment_fingerprint(**args) == original
    assert environment_fingerprint(**{**args, 'dependencies': {'requirements.lock': b'pytest==8.3.4'}}) != original
    assert environment_fingerprint(**{**args, 'architecture': 'amd64'}) != original


def test_prebuilt_environment_resolves_tag_to_immutable_id():
    from types import SimpleNamespace
    from unittest.mock import Mock
    from arp_runtime.environment.builder import prepare_environment
    client = Mock()
    client.images.get.return_value = SimpleNamespace(id='sha256:' + 'a' * 64, attrs={'Architecture': 'arm64'})
    fingerprint, image, log = prepare_environment(client, '/unused', 'b' * 40,
        SimpleNamespace(image='mutable:tag', dependencyFiles=[], preparation='image'))
    assert len(fingerprint) == 64
    assert image == 'sha256:' + 'a' * 64
    assert log == 'Using prebuilt image'
    client.images.build.assert_not_called()
