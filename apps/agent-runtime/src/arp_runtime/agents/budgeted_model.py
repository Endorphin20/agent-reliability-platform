"""The host worker reserves calls; task sandboxes never receive model credentials."""
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Any, Callable
from uuid import uuid4


class UsageUnknown(RuntimeError):
    pass


@dataclass
class BudgetContext:
    cp: Any
    run_id: str
    attempt_id: str
    input_limit: int
    output_limit: int


call_timeout: ContextVar[float | None] = ContextVar('arp_call_timeout', default=None)

def request_options():
    value = call_timeout.get()
    return {'timeout': value} if value is not None else {}


active_budget: ContextVar[BudgetContext | None] = ContextVar('arp_budget', default=None)


def budget_call(invoke: Callable, usage: Callable | None = None):
    budget = active_budget.get()
    if budget is None:
        return invoke()
    if budget.input_limit <= 0 or budget.output_limit <= 0:
        raise UsageUnknown('Configure the provider-enforced context/output limits before strict-budget execution')
    request_id = str(uuid4())
    reservation = budget.cp.budget_reserve(budget.run_id, budget.attempt_id, request_id, budget.input_limit + budget.output_limit)
    if isinstance(reservation, dict):
        call_timeout.set(max(0.1, min(120, reservation.get('remainingSeconds', 120))))
    try:
        result = invoke()
        metadata = usage(result) if usage else getattr(result, 'usage_metadata', None)
        if not metadata or 'input_tokens' not in metadata or 'output_tokens' not in metadata:
            raise UsageUnknown('Model response did not provide usage; reservation retained')
        used = int(metadata['input_tokens']) + int(metadata['output_tokens'])
        if used < 0:
            raise UsageUnknown('Invalid model usage')
    except Exception as exc:
        try:
            budget.cp.budget_settle(budget.run_id, request_id, None)
        finally:
            call_timeout.set(None)
            raise UsageUnknown('Model call failed; usage reservation retained') from exc
    try:
        budget.cp.budget_settle(budget.run_id, request_id, used)
    except Exception as exc:
        raise UsageUnknown('Model usage could not be settled; reservation retained') from exc
    finally:
        call_timeout.set(None)
    if used > budget.input_limit + budget.output_limit:
        raise UsageUnknown('Provider exceeded declared token bounds; strict execution stopped')
    return result
