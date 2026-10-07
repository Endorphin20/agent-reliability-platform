from types import SimpleNamespace
from unittest.mock import Mock
import pytest
from arp_runtime.agents.budgeted_model import BudgetContext, budget_call, active_budget, UsageUnknown


def test_calls_reserve_before_invocation_and_settle_once():
    cp = Mock()
    token = active_budget.set(BudgetContext(cp, 'r', 'a', 100, 20))
    try:
        result = budget_call(lambda: SimpleNamespace(usage_metadata={'input_tokens': 3, 'output_tokens': 2}))
        assert result.usage_metadata['input_tokens'] == 3
        assert cp.budget_reserve.call_args.args[-1] == 120
        assert cp.budget_settle.call_args.args[-1] == 5
    finally:
        active_budget.reset(token)


def test_unknown_usage_stops_and_keeps_reservation():
    cp = Mock()
    token = active_budget.set(BudgetContext(cp, 'r', 'a', 100, 20))
    try:
        with pytest.raises(UsageUnknown):
            budget_call(lambda: SimpleNamespace(usage_metadata=None))
        assert cp.budget_settle.call_args.args[-1] is None
    finally:
        active_budget.reset(token)


def test_denied_reservation_makes_no_model_call():
    cp, invoke = Mock(), Mock()
    cp.budget_reserve.side_effect = RuntimeError('exhausted')
    token = active_budget.set(BudgetContext(cp, 'r', 'a', 100, 20))
    try:
        with pytest.raises(RuntimeError):
            budget_call(invoke)
        invoke.assert_not_called()
    finally:
        active_budget.reset(token)


def test_provider_failure_is_unknown_usage_even_for_optional_judge_or_condenser():
    cp = Mock()
    token = active_budget.set(BudgetContext(cp, 'r', 'a', 100, 20))
    try:
        def fail():
            raise ConnectionError('lost model response')
        with pytest.raises(UsageUnknown):
            budget_call(fail)
        assert cp.budget_settle.call_args.args[-1] is None
    finally:
        active_budget.reset(token)
