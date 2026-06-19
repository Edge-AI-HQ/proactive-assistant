from __future__ import annotations

from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from pinai_agents.web.db.repositories import provider_usage as provider_usage_mod
from pinai_agents.web.payment import checkout as checkout_mod
from pinai_agents.web.payment import routes as payment_routes

pytestmark = pytest.mark.asyncio


class _FakeTx:
    def __init__(self, conn):
        self._conn = conn

    async def __aenter__(self):
        return self._conn

    async def __aexit__(self, *args):
        return False


async def test_usage_uses_db_budget_period_not_litellm_calendar_reset(monkeypatch):
    period_start = datetime(2026, 6, 17, 12, 0, tzinfo=UTC)
    period_end = datetime(2026, 7, 17, 12, 0, tzinfo=UTC)
    captured = {}

    monkeypatch.setattr(payment_routes, "user_scoped_tx", lambda _pool, _uid: _FakeTx(object()))
    monkeypatch.setattr(checkout_mod, "_virtual_key_for_user", AsyncMock(return_value="sk-test"))
    monkeypatch.setattr(
        payment_routes.periods_repo,
        "get_open_period",
        AsyncMock(
            return_value=SimpleNamespace(
                period_start=period_start,
                period_end=period_end,
                allowance_cents=9900,
                allowance_consumed_cents=0,
                max_budget_cents_at_open=17400,
            )
        ),
    )
    monkeypatch.setattr(
        payment_routes.grants_repo,
        "sum_active_remaining_cents",
        AsyncMock(return_value=7500),
    )
    monkeypatch.setattr(
        payment_routes.litellm_client,
        "get_key_info",
        AsyncMock(
            return_value={
                "spend": 10.0,
                "max_budget": 99.0,
                "budget_reset_at": "2026-07-01T00:00:00Z",
                "budget_duration": "30d",
            }
        ),
    )

    class FakeProviderUsageRepository:
        def __init__(self, user_id, conn):
            self.user_id = user_id
            self.conn = conn

        async def sum_cost_usd(self, *, since):
            captured["since"] = since
            return 2.5

    monkeypatch.setattr(
        provider_usage_mod,
        "ProviderUsageRepository",
        FakeProviderUsageRepository,
    )

    result = await payment_routes.usage(
        user=SimpleNamespace(id=42),
        pool=None,
    )

    assert captured["since"] == period_start
    assert result["spendUsd"] == 12.5
    assert result["maxBudgetUsd"] == 99.0
    assert result["planAllowanceCredits"] == 9900
    assert result["topupCreditsAvailable"] == 7500
    assert result["budgetResetAt"] == period_end.isoformat()
    assert result["budgetDuration"] == "2592000s"


async def test_usage_returns_db_credits_when_litellm_key_info_is_unavailable(monkeypatch):
    period_start = datetime(2026, 6, 17, 12, 0, tzinfo=UTC)
    period_end = datetime(2026, 7, 17, 12, 0, tzinfo=UTC)

    monkeypatch.setattr(payment_routes, "user_scoped_tx", lambda _pool, _uid: _FakeTx(object()))
    monkeypatch.setattr(checkout_mod, "_virtual_key_for_user", AsyncMock(return_value="sk-test"))
    monkeypatch.setattr(
        payment_routes.periods_repo,
        "get_open_period",
        AsyncMock(
            return_value=SimpleNamespace(
                period_start=period_start,
                period_end=period_end,
                allowance_cents=10000,
                allowance_consumed_cents=0,
                max_budget_cents_at_open=17500,
            )
        ),
    )
    monkeypatch.setattr(
        payment_routes.grants_repo,
        "sum_active_remaining_cents",
        AsyncMock(return_value=7500),
    )
    monkeypatch.setattr(
        payment_routes.litellm_client,
        "get_key_info",
        AsyncMock(side_effect=payment_routes.litellm_client.LiteLLMError(500, "down")),
    )
    monkeypatch.setattr(
        provider_usage_mod.ProviderUsageRepository,
        "sum_cost_usd",
        AsyncMock(return_value=0.0),
    )

    result = await payment_routes.usage(
        user=SimpleNamespace(id=42),
        pool=None,
    )

    assert result["spendUsd"] == 0.0
    assert result["maxBudgetUsd"] == 175.0
    assert result["planAllowanceCredits"] == 10000
    assert result["topupCreditsAvailable"] == 7500
    assert result["budgetResetAt"] == period_end.isoformat()
