import pytest
from pydantic import ValidationError
from arp_runtime.schemas.task_snapshot import TaskSnapshot


def snapshot():
    return dict(schemaVersion=2, mode='REAL', repositoryId='r', configVersion=1,
        executionSha='a' * 40, agentKind='SELF_LANGGRAPH', title='bug', description='fix',
        config=dict(runtime='python-pytest', preparation='image', image='image', dependencyFiles=[],
            workdir='.', allowedPaths=['src/**'], protectedPaths=['tests/**'], staticCheck=[],
            failToPass=['pytest'], passToPass=[], acceptanceCriteria=['fixed']),
        baseline=dict(command='pytest', expected=['test_bug']),
        budget=dict(tokens=1000, seconds=60, turns=10, maxAttempts=3),
        delivery=dict(kind='patch', targetBranch='feature', expectedTargetSha='a' * 40))


def test_snapshot_accepts_pinned_commit():
    assert TaskSnapshot.model_validate(snapshot()).executionSha == 'a' * 40


@pytest.mark.parametrize('sha', ['main', 'abc123', 'x' * 40])
def test_snapshot_rejects_mutable_code(sha):
    with pytest.raises(ValidationError):
        TaskSnapshot.model_validate({**snapshot(), 'executionSha': sha})


def test_snapshot_rejects_environment_path_escape():
    value = snapshot()
    value['config']['workdir'] = '../secret'
    with pytest.raises(ValidationError):
        TaskSnapshot.model_validate(value)
