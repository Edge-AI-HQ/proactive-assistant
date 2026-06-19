"""Unit tests for checkout.recompute_litellm_budget (Phase 2 single budget
writer). Stripe/DB/LiteLLM all mocked — isolates the budget arithmetic +
no-op / error-handling semantics. Mirrors tests/web/payment/test_immediate_upgrade.py.
"""

from __future__ import annotations

from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from pinai_agents.web.litellm import client as litellm_client
from pinai_agents.web.payment import checkout as checkout_mod

pytestmark = pytest.mark.asyncio


def _plan(credits: int):
    return SimpleNamespace(plan_code="x", monthly_refresh_credits=credits)


@pytest.fixture
def harness(monkeypatch):
    """Default happy path: keyed user on 'pro' (9900cr allowance), open
    window with 0 consumed, 0 credits. Tests override pieces as needed."""
    now = datetime(2026, 6, 17, 12, 0, tzinfo=UTC)
    update = AsyncMock()
    sync_reset_at = AsyncMock()
    monkeypatch.setattr(litellm_client, "update_key", update)
    monkeypatch.setattr(checkout_mod, "_now_utc", lambda: now)
    monkeypatch.setattr(checkout_mod, "_virtual_key_for_user", AsyncMock(return_value="sk-test"))
    monkeypatch.setattr(checkout_mod, "_sync_litellm_budget_reset_at", sync_reset_at)
    monkeypatch.setattr(
        checkout_mod.subs_repo,
        "get_for_user",
        AsyncMock(return_value=SimpleNamespace(plan_code="pro")),
    )
    find_by_code = AsyncMock(return_value=_plan(9900))
    monkeypatch.setattr(checkout_mod.plans_repo, "find_by_code", find_by_code)
    monkeypatch.setattr(
        checkout_mod.periods_repo,
        "get_open_period",
        AsyncMock(
            return_value=SimpleNamespace(
                allowance_consumed_cents=0,
                period_end=datetime(2026, 7, 17, 12, 0, tzinfo=UTC),
            )
        ),
    )
    monkeypatch.setattr(
        checkout_mod.grants_repo,
        "sum_active_remaining_cents",
        AsyncMock(return_value=0),
    )
    return SimpleNamespace(
        update=update,
        sync_reset_at=sync_reset_at,
        find_by_code=find_by_code,
        monkeypatch=monkeypatch,
    )


async def test_recompute_is_allowance_plus_active_credits(harness):
    harness.monkeypatch.setattr(
        checkout_mod.grants_repo,
        "sum_active_remaining_cents",
        AsyncMock(return_value=5000),
    )
    await checkout_mod.recompute_litellm_budget(None, 42)

    _, kw = harness.update.call_args
    # (9900 allowance + 5000 credits) / 100 = $149.00
    assert kw["max_budget_usd"] == (9900 + 5000) / 100
    # LiteLLM's public budget_duration API aligns to calendar boundaries;
    # exact per-user reset timestamps are synced through the shared DB.
    assert "budget_duration" not in kw
    assert kw["reset_spend"] is False
    harness.sync_reset_at.assert_awaited_once()


async def test_recompute_subtracts_consumed_allowance(harness):
    harness.monkeypatch.setattr(
        checkout_mod.periods_repo,
        "get_open_period",
        AsyncMock(return_value=SimpleNamespace(allowance_consumed_cents=2000)),
    )
    await checkout_mod.recompute_litellm_budget(None, 42)

    _, kw = harness.update.call_args
    assert kw["max_budget_usd"] == (9900 - 2000) / 100  # $79.00


async def test_recompute_reset_spend_passthrough(harness):
    await checkout_mod.recompute_litellm_budget(None, 42, reset_spend=True)
    _, kw = harness.update.call_args
    assert kw["reset_spend"] is True


async def test_recompute_defaults_to_free_without_subscription(harness):
    harness.monkeypatch.setattr(
        checkout_mod.subs_repo, "get_for_user", AsyncMock(return_value=None)
    )
    harness.find_by_code.return_value = _plan(100000)  # free test budget
    await checkout_mod.recompute_litellm_budget(None, 42)

    # plan resolved as 'free' when no subscription row
    free_call = harness.find_by_code.await_args
    assert free_call.args[1] == "free"
    _, kw = harness.update.call_args
    assert kw["max_budget_usd"] == 100000 / 100  # $1000


async def test_recompute_noop_when_no_key(harness):
    harness.monkeypatch.setattr(checkout_mod, "_virtual_key_for_user", AsyncMock(return_value=None))
    await checkout_mod.recompute_litellm_budget(None, 42)
    harness.update.assert_not_awaited()
    harness.sync_reset_at.assert_not_awaited()


async def test_recompute_swallows_litellm_error(harness):
    harness.update.side_effect = litellm_client.LiteLLMError(500, "boom")
    # Must not raise — Stripe/DB already persisted; budget self-heals next time.
    await checkout_mod.recompute_litellm_budget(None, 42)
    harness.update.assert_awaited_once()
    harness.sync_reset_at.assert_not_awaited()


class _Cursor:
    def __init__(self):
        self.execute = AsyncMock()

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return None


class _Conn:
    def __init__(self):
        self.cur = _Cursor()

    def cursor(self):
        return self.cur


async def test_sync_litellm_budget_reset_at_pins_shared_litellm_table():
    conn = _Conn()
    period_end = datetime(2026, 7, 17, 12, 0, tzinfo=UTC)

    await checkout_mod._sync_litellm_budget_reset_at(
        conn,
        42,
        SimpleNamespace(period_end=period_end),
    )

    conn.cur.execute.assert_awaited_once()
    sql, params = conn.cur.execute.await_args.args
    assert 'litellm."LiteLLM_VerificationToken"' in sql
    assert "metadata->>'internal_user_id'" in sql
    assert params == (period_end, "42")


async def test_sync_litellm_budget_reset_at_noops_without_period_end():
    conn = _Conn()

    await checkout_mod._sync_litellm_budget_reset_at(conn, 42, None)

    conn.cur.execute.assert_not_awaited()
