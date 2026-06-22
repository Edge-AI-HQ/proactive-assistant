"""DB-integration tests for the Phase 2 budget reconcile job. Real Postgres
(TEST_DATABASE_URL) + mocked LiteLLM. Verifies allowance-first then FIFO-grant
attribution, window close/reopen, and the auto-reset safety net.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from unittest.mock import AsyncMock

import pytest
from pinai_api.domains.billing import budget_reconcile
from pinai_api.domains.billing.payments import budget_periods as periods_repo
from pinai_api.domains.billing.payments import checkout as checkout_mod
from pinai_api.domains.billing.payments import credit_grants as grants_repo
from pinai_api.platform.litellm import client as litellm_client
from pinai_db.rls import service_tx

pytestmark = pytest.mark.asyncio


@pytest.fixture(autouse=True)
def _noop_litellm_reset_timestamp_sync(monkeypatch):
    async def _noop(*_args, **_kwargs):
        return None

    monkeypatch.setattr(checkout_mod, "_sync_litellm_budget_reset_at", _noop)


async def _set_key(conn, user_id: int, key: str = "sk-test") -> None:
    await conn.execute("UPDATE users SET litellm_virtual_key = %s WHERE id = %s", (key, user_id))


async def _claimed_due_window(
    pool,
    user_id: int,
    *,
    allowance: int,
    max_at_open: int,
    opening_litellm_spend: Decimal | int = 0,
    last_seen_reset_at: datetime | None = None,
) -> object:
    """Open a past-due window for user_id, flip it to 'reconciling' (as the
    claimer would), and return the BudgetPeriod."""
    now = datetime.now(UTC)
    async with service_tx(pool) as conn:
        await _set_key(conn, user_id)
        pid = await periods_repo.open_period(
            conn,
            user_id=user_id,
            supabase_user_id=str(uuid.uuid4()),
            plan_code="free",
            allowance_cents=allowance,
            period_start=now - timedelta(days=31),
            period_end=now - timedelta(minutes=1),
            opening_litellm_spend=opening_litellm_spend,
            last_seen_reset_at=last_seen_reset_at,
            max_budget_cents_at_open=max_at_open,
        )
        await conn.execute("UPDATE pai_budget_periods SET state='reconciling' WHERE id=%s", (pid,))
        period = await periods_repo.get_open_period(conn, user_id)
    return period


async def _consumption(pool, period_id: str) -> dict[str, int]:
    async with service_tx(pool) as conn:
        cur = await conn.execute(
            "SELECT bucket, SUM(cents) AS c FROM pai_credit_consumption_events "
            "WHERE budget_period_id = %s GROUP BY bucket",
            (period_id,),
        )
        rows = await cur.fetchall()
    return {r["bucket"]: int(r["c"]) for r in rows}


async def test_reconcile_allowance_then_fifo_grant_overflow(pool, user_ids, monkeypatch):
    user_a, _ = user_ids
    # SpendLogs report $150 actual spend this window.
    monkeypatch.setattr(litellm_client, "sum_spend_for_key_window", _amock(150.0))
    update = _amock(None)
    monkeypatch.setattr(litellm_client, "update_key", update)

    # allowance 10000c ($100), one active grant 5000c ($50).
    async with service_tx(pool) as conn:
        await grants_repo.insert_topup_grant(
            conn,
            user_id=user_a,
            supabase_user_id=str(uuid.uuid4()),
            grant_cents=5000,
            expires_at=datetime.now(UTC) + timedelta(days=365),
            stripe_payment_intent_id=f"pi_{uuid.uuid4().hex[:12]}",
        )
    period = await _claimed_due_window(pool, user_a, allowance=10000, max_at_open=15000)

    await budget_reconcile._reconcile_one(pool, period)

    # $150 = $100 allowance + $50 grant overflow.
    buckets = await _consumption(pool, period.id)
    assert buckets.get("allowance") == 10000
    assert buckets.get("grant") == 5000

    async with service_tx(pool) as conn:
        remaining = await grants_repo.sum_active_remaining_cents(conn, user_a)
        old = await conn.execute(
            "SELECT state, allowance_consumed_cents FROM pai_budget_periods WHERE id=%s",
            (period.id,),
        )
        old_row = await (old).fetchone()
        new_open = await periods_repo.get_open_period(conn, user_a)
    assert remaining == 0  # grant exhausted
    assert old_row["state"] == "reconciled"
    assert old_row["allowance_consumed_cents"] == 10000
    # next window opened on free, fresh, reset applied (update_key succeeded)
    assert new_open is not None and new_open.state == "open"
    assert new_open.allowance_cents == 100000  # free plan test budget
    assert new_open.reset_applied is True
    _, kw = update.call_args
    assert kw["reset_spend"] is True


async def test_reconcile_low_usage_keeps_credits(pool, user_ids, monkeypatch):
    """Steady-state regression: a user with credits and near-zero real usage
    keeps every credit. Pre-fix, LiteLLM's monthly auto-reset advanced
    budget_reset_at past the window's recorded anchor every cycle, tripping a
    "reset raced" safety net that charged the full ceiling (allowance + all
    credits) and drained the grant regardless of usage. SpendLogs reports the
    true spend, so a quiet window touches no credits.
    """
    user_a, _ = user_ids
    # Actual window spend from SpendLogs: $0.50 — far under the allowance.
    monkeypatch.setattr(litellm_client, "sum_spend_for_key_window", _amock(0.5))
    monkeypatch.setattr(litellm_client, "update_key", _amock(None))

    async with service_tx(pool) as conn:
        await grants_repo.insert_topup_grant(
            conn,
            user_id=user_a,
            supabase_user_id=str(uuid.uuid4()),
            grant_cents=5000,  # $50 purchased credits
            expires_at=datetime.now(UTC) + timedelta(days=365),
            stripe_payment_intent_id=f"pi_{uuid.uuid4().hex[:12]}",
        )
    # last_seen_reset_at far in the past — the exact state that tripped the old
    # safety net. allowance 100000c ($1000), ceiling-at-open 105000c.
    period = await _claimed_due_window(
        pool,
        user_a,
        allowance=100000,
        max_at_open=105000,
        last_seen_reset_at=datetime.now(UTC) - timedelta(days=31),
    )
    await budget_reconcile._reconcile_one(pool, period)

    buckets = await _consumption(pool, period.id)
    async with service_tx(pool) as conn:
        remaining = await grants_repo.sum_active_remaining_cents(conn, user_a)
    assert buckets.get("allowance") == 50  # $0.50 = 50c, all within allowance
    assert "grant" not in buckets  # credits untouched
    assert remaining == 5000  # full $50 preserved


async def test_reconcile_counts_upgrade_carried_spend_before_grant_overflow(
    pool, user_ids, monkeypatch
):
    user_a, _ = user_ids
    # Immediate upgrade preserves LiteLLM spend. A user who had already spent
    # $60 before the upgrade and spends another $70 in the upgraded window has
    # used $130 against the new $100 allowance, so $30 must come from top-up
    # credits.
    monkeypatch.setattr(litellm_client, "sum_spend_for_key_window", _amock(70.0))
    monkeypatch.setattr(litellm_client, "update_key", _amock(None))

    async with service_tx(pool) as conn:
        await grants_repo.insert_topup_grant(
            conn,
            user_id=user_a,
            supabase_user_id=str(uuid.uuid4()),
            grant_cents=5000,
            expires_at=datetime.now(UTC) + timedelta(days=365),
            stripe_payment_intent_id=f"pi_{uuid.uuid4().hex[:12]}",
        )
    period = await _claimed_due_window(
        pool,
        user_a,
        allowance=10000,
        max_at_open=15000,
        opening_litellm_spend=Decimal("60.00"),
    )

    await budget_reconcile._reconcile_one(pool, period)

    buckets = await _consumption(pool, period.id)
    async with service_tx(pool) as conn:
        remaining = await grants_repo.sum_active_remaining_cents(conn, user_a)
    assert buckets.get("allowance") == 10000
    assert buckets.get("grant") == 3000
    assert remaining == 2000


async def test_expire_credit_grants_forfeits_remainder_and_floors(pool, user_ids, monkeypatch):
    user_a, _ = user_ids
    monkeypatch.setattr(
        litellm_client, "get_key_info", _amock({"spend": 12.34, "budget_reset_at": None})
    )
    recompute = _amock(True)
    monkeypatch.setattr(checkout_mod, "recompute_litellm_budget", recompute)

    now = datetime.now(UTC)
    async with service_tx(pool) as conn:
        await _set_key(conn, user_a)
        # active grant past expiry: 5000c granted, 1000c used → 4000c forfeited.
        expired_gid = await grants_repo.insert_topup_grant(
            conn,
            user_id=user_a,
            supabase_user_id=str(uuid.uuid4()),
            grant_cents=5000,
            expires_at=now - timedelta(days=1),
            stripe_payment_intent_id=f"pi_{uuid.uuid4().hex[:12]}",
        )
        await grants_repo.apply_consumption(conn, grant_id=expired_gid, cents=1000)
        await periods_repo.open_period(
            conn,
            user_id=user_a,
            supabase_user_id=str(uuid.uuid4()),
            plan_code="free",
            allowance_cents=100000,
            period_start=now,
            period_end=now + timedelta(days=30),
        )
        # active grant NOT expired → kept.
        await grants_repo.insert_topup_grant(
            conn,
            user_id=user_a,
            supabase_user_id=str(uuid.uuid4()),
            grant_cents=3000,
            expires_at=now + timedelta(days=30),
            stripe_payment_intent_id=f"pi_{uuid.uuid4().hex[:12]}",
        )

    await budget_reconcile._expire_credit_grants(pool)

    async with service_tx(pool) as conn:
        remaining = await grants_repo.sum_active_remaining_cents(conn, user_a)
        cur = await conn.execute(
            "SELECT status FROM pai_credit_grants WHERE id = %s", (expired_gid,)
        )
        status = (await cur.fetchone())["status"]
        cur = await conn.execute(
            "SELECT cents FROM pai_credit_consumption_events "
            "WHERE grant_id = %s AND bucket = 'expiry'",
            (expired_gid,),
        )
        audit = await cur.fetchone()

    assert status == "expired"
    assert remaining == 3000  # only the non-expired grant still counts
    assert audit is not None and int(audit["cents"]) == 4000  # forfeited 5000-1000
    recompute.assert_awaited_once()
    _, kw = recompute.await_args
    assert kw["floor_usd"] == 12.34  # ceiling floored at current spend


def _amock(return_value: object) -> AsyncMock:
    return AsyncMock(return_value=return_value)
