from arp_runtime.verifier.baseline import classify_baseline


def test_same_test_failure_reproduced():
    assert classify_baseline(1, 'FAILED tests/test_bug.py::test_bug - AssertionError', ['tests/test_bug.py::test_bug']) == 'REPRODUCED'


def test_missing_dependency_is_environment_failure():
    assert classify_baseline(2, "ModuleNotFoundError: No module named 'pytest'", ['test_bug']) == 'ENVIRONMENT_ERROR'


def test_success_is_not_a_reproduced_failure():
    assert classify_baseline(0, '1 passed', ['test_bug']) == 'NOT_REPRODUCED'


def test_another_failure_does_not_match():
    assert classify_baseline(1, 'FAILED test_other', ['test_bug']) == 'EVIDENCE_MISMATCH'


def test_timeout_and_zero_tests_are_not_code_failures():
    assert classify_baseline(137, 'test_bug', ['test_bug']) == 'ENVIRONMENT_ERROR'
    assert classify_baseline(5, 'no tests ran', ['test_bug']) == 'ENVIRONMENT_ERROR'


def test_static_error_can_be_reproduced():
    assert classify_baseline(1, 'src/app.py:5: E999 SyntaxError', ['src/app.py:5: E999']) == 'REPRODUCED'
