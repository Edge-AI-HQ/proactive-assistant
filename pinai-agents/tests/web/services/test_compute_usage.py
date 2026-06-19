from __future__ import annotations

from decimal import Decimal

import pytest

from pinai_agents.web.services.provider_usage import (
    estimate_composio_tool_call_charge,
    estimate_compute_charge,
    estimate_tavily_charge,
)


def test_daytona_charge_is_duration_times_per_minute_rate():
    charge = estimate_compute_charge(provider="daytona", duration_seconds=60, source="daytona:exec")
    assert charge.provider == "daytona"
    assert charge.product == "daytona_sandbox"
    assert charge.quantity_seconds == Decimal("60")
    assert charge.cost_usd == Decimal("0.005")  # 1 min × $0.005


def test_browserbase_charge_is_duration_times_per_minute_rate():
    charge = estimate_compute_charge(
        provider="browserbase", duration_seconds=120, source="browser:open"
    )
    assert charge.provider == "browserbase"
    assert charge.product == "browserbase_session"
    assert charge.cost_usd == Decimal("0.008")  # 2 min × $0.004


def test_zero_duration_is_zero_cost():
    charge = estimate_compute_charge(provider="daytona", duration_seconds=0, source="x")
    assert charge.quantity_seconds == Decimal("0.000")
    assert charge.cost_usd == Decimal("0")


def test_unknown_provider_raises():
    with pytest.raises(KeyError):
        estimate_compute_charge(provider="nope", duration_seconds=10, source="x")


def test_tavily_charge_uses_api_credits():
    charge = estimate_tavily_charge(
        product="tavily_extract",
        api_credits=2,
        source="tavily:extract",
        metadata={"url_count": 6},
    )

    assert charge.provider == "tavily"
    assert charge.product == "tavily_extract"
    assert charge.units == "api_credits"
    assert charge.quantity_seconds == Decimal("2.000")
    assert charge.cost_usd == Decimal("0.016000")


def test_composio_tool_call_charge_uses_call_count():
    charge = estimate_composio_tool_call_charge(
        tool_calls=3,
        source="composio:agent_multi_execute",
        metadata={"slugs": ["A", "B", "C"]},
    )

    assert charge.provider == "composio"
    assert charge.product == "composio_tool_call"
    assert charge.units == "tool_calls"
    assert charge.quantity_seconds == Decimal("3.000")
    assert charge.cost_usd == Decimal("0.000897")
