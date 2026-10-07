"""Deterministic failure-evidence gate; never delegate acceptance to the model."""
import re


def classify_baseline(exit_code: int, output: str, expected: list[str]) -> str:
    if exit_code == 0:
        return 'NOT_REPRODUCED'
    if exit_code in (5, 124, 126, 127, 137) or re.search(
        r'ModuleNotFoundError|command not found|No module named|no tests ran|collected 0 items|Permission denied', output,
    ):
        return 'ENVIRONMENT_ERROR'
    if expected and all(marker in output for marker in expected):
        return 'REPRODUCED'
    return 'EVIDENCE_MISMATCH'
