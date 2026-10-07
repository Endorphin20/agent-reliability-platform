"""Capture pytest identities outside the agent workspace and compare acceptance coverage."""
import re
import xml.etree.ElementTree as ET
from uuid import uuid4


def parse_cases(xml: str) -> dict[str, str]:
    root = ET.fromstring(xml)
    cases = {}
    for case in root.iter('testcase'):
        identity = case.attrib.get('classname', '') + '::' + case.attrib['name']
        if identity in cases:
            raise ValueError('Duplicate pytest identity; cannot verify acceptance coverage')
        cases[identity] = ('skipped' if case.find('skipped') is not None else
                           'failed' if case.find('failure') is not None or case.find('error') is not None else 'passed')
    return cases


def coverage_preserved(before: dict[str, str], after: dict[str, str]) -> bool:
    required = {name for name, outcome in before.items() if outcome != 'skipped'}
    return bool(required) and all(after.get(name) == 'passed' for name in required)


def run_check(sandbox, command: str, cwd: str, timeout_s=None):
    if not re.search(r'(^|\s)pytest(\s|$)', command):
        return sandbox.exec(command, cwd=cwd, timeout_s=timeout_s), None
    report = f'/tmp/arp-check-{uuid4().hex}.xml'
    result = sandbox.exec(f'export PYTEST_ADDOPTS="${{PYTEST_ADDOPTS:-}} --junitxml={report}"; {command}', cwd=cwd, timeout_s=timeout_s)
    xml = sandbox.exec(f'cat {report}', cwd=cwd, timeout_s=10)
    if xml.exit_code != 0:
        return result, {}
    try:
        return result, parse_cases(xml.stdout)
    except (ET.ParseError, ValueError):
        return result, {}
