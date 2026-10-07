from arp_runtime.verifier.test_contract import parse_cases, coverage_preserved


def test_skipping_or_removing_original_failure_does_not_satisfy_contract():
    before = {'suite::test_bug': 'failed', 'suite::test_other': 'passed'}
    assert coverage_preserved(before, {'suite::test_bug': 'passed', 'suite::test_other': 'passed'})
    assert not coverage_preserved(before, {'suite::test_bug': 'skipped', 'suite::test_other': 'passed'})
    assert not coverage_preserved(before, {'suite::test_other': 'passed'})
    assert not coverage_preserved(before, {})


def test_junit_failure_skip_and_parameterized_identity():
    cases = parse_cases('<testsuites><testsuite><testcase classname="s" name="test_a[1]"><failure/></testcase><testcase classname="s" name="test_b"><skipped/></testcase></testsuite></testsuites>')
    assert cases == {'s::test_a[1]': 'failed', 's::test_b': 'skipped'}
