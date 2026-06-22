"""DB-integration tests for the Phase 2 credit repositories.

Run against the local docker-compose Postgres after `make migrate`
(TEST_DATABASE_URL set). Skipped automatically when it isn't (see
tests/conftest.py). Rows reference users(id) ON DELETE CASCADE, so the
user_ids fixture's teardown deletes everything we create here.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest
from pinai_api.domains.billing.payments import budget_periods as periods_repo
from pinai_api.domains.billing.payments import credit_consumption as consumption_repo
from pinai_api.domains.billing.payments import credit_grants as grants_repo
from pinai_db.rls import service_tx

pytestmark = pytest.mark.asyncio


def utcnow() -> datetime:
    return datetime.now(UTC)


def _pi() -> str:
    """A unique fake Stripe payment_intent id per grant."""
    return f"pi_test_{uuid.uuid4().hex[:16]}"


async def test_insert_topup_grant_is_idempotent_on_payment_intent(pool, user_ids):
    user_a, _ = user_ids
    pi = _pi()
    sub = str(uuid.uuid4())
    async with service_tx(pool) as conn:
        first = await grants_repo.insert_topup_grant(
            conn,
            user_id=user_a,
            supabase_user_id=sub,
            grant_cents=2000,
            expires_at=utcnow() + timedelta(days=365),
            stripe_payment_intent_id=pi,
        )
        # Same payment_intent again -> ON CONFLICT DO NOTHING -> None.
        again = await grants_repo.insert_topup_grant(
            conn,
            user_id=user_a,
            supabase_user_id=sub,
            grant_cents=2000,
            expires_at=utcnow() + timedelta(days=365),
            stripe_payment_intent_id=pi,
        )
    assert first is not None
    assert again is None


async def test_sum_active_remaining_excludes_expired_and_exhausted(pool, user_ids):
    user_a, _ = user_ids
    sub = str(uuid.uuid4())
    async with service_tx(pool) as conn:
        # active, un-expired -> counted (1000)
        await grants_repo.insert_topup_grant(
            conn,
            user_id=user_a,
            supabase_user_id=sub,
            grant_cents=1000,
            expires_at=utcnow() + timedelta(days=30),
            stripe_payment_intent_id=_pi(),
        )
        # expired -> excluded
        await grants_repo.insert_topup_grant(
            conn,
            user_id=user_a,
            supabase_user_id=sub,
            grant_cents=500,
            expires_at=utcnow() - timedelta(days=1),
            stripe_payment_intent_id=_pi(),
        )
        # active then fully drained -> 'exhausted' -> excluded
        drained = await grants_repo.insert_topup_grant(
            conn,
            user_id=user_a,
            supabase_user_id=sub,
            grant_cents=300,
            expires_at=utcnow() + timedelta(days=30),
            stripe_payment_intent_id=_pi(),
        )
        assert drained is not None
        await grants_repo.apply_consumption(conn, grant_id=drained, cents=300)

        remaining = await grants_repo.sum_active_remaining_cents(conn, user_a)
    assert remaining == 1000


async def test_apply_consumption_flips_status_exhausted(pool, user_ids):
    user_a, _ = user_ids
    async with service_tx(pool) as conn:
        gid = await grants_repo.insert_topup_grant(
            conn,
            user_id=user_a,
            supabase_user_id=str(uuid.uuid4()),
            grant_cents=1000,
            expires_at=utcnow() + timedelta(days=30),
            stripe_payment_intent_id=_pi(),
        )
        await grants_repo.apply_consumption(conn, grant_id=gid, cents=400)
        partial = await grants_repo.list_active_fifo(conn, user_a)
        assert len(partial) == 1
        assert partial[0].remaining_cents == 600  # still active

        await grants_repo.apply_consumption(conn, grant_id=gid, cents=600)
        after = await grants_repo.list_active_fifo(conn, user_a)
    assert after == []  # exhausted -> dropped from active FIFO list


async def test_list_active_fifo_orders_by_earliest_expiry(pool, user_ids):
    user_a, _ = user_ids
    sub = str(uuid.uuid4())
    async with service_tx(pool) as conn:
        late = await grants_repo.insert_topup_grant(
            conn,
            user_id=user_a,
            supabase_user_id=sub,
            grant_cents=100,
            expires_at=utcnow() + timedelta(days=300),
            stripe_payment_intent_id=_pi(),
        )
        early = await grants_repo.insert_topup_grant(
            conn,
            user_id=user_a,
            supabase_user_id=sub,
            grant_cents=100,
            expires_at=utcnow() + timedelta(days=5),
            stripe_payment_intent_id=_pi(),
        )
        ordered = await grants_repo.list_active_fifo(conn, user_a)
    assert [g.id for g in ordered] == [early, late]


async def test_budget_period_open_claim_close_lifecycle(pool, user_ids):
    user_a, user_b = user_ids
    now = utcnow()
    async with service_tx(pool) as conn:
        # user_a: window already due (period_end in the past) -> claimable
        due_id = await periods_repo.open_period(
            conn,
            user_id=user_a,
            supabase_user_id=str(uuid.uuid4()),
            plan_code="free",
            allowance_cents=100000,
            period_start=now - timedelta(days=31),
            period_end=now - timedelta(minutes=1),
        )
        # user_b: window not yet due -> NOT claimed
        await periods_repo.open_period(
            conn,
            user_id=user_b,
            supabase_user_id=str(uuid.uuid4()),
            plan_code="free",
            allowance_cents=100000,
            period_start=now,
            period_end=now + timedelta(days=30),
        )

        claimed = await periods_repo.claim_due_periods(conn, limit=50)
        claimed_ids = {p.id for p in claimed}
        assert due_id in claimed_ids
        assert all(p.user_id != user_b for p in claimed)
        # claimed window flipped to 'reconciling' and is still the open-ish one
        opened = await periods_repo.get_open_period(conn, user_a)
        assert opened is not None and opened.state == "reconciling"

        await periods_repo.close_period(
            conn,
            period_id=due_id,
            allowance_consumed_cents=4200,
            closing_litellm_spend=Decimal("0.42"),
        )
        assert await periods_repo.get_open_period(conn, user_a) is None


async def test_reanchor_open_period_for_upgrade_resets_current_window(pool, user_ids):
    user_a, _ = user_ids
    supabase_user_id = str(uuid.uuid4())
    old_start = datetime(2026, 6, 1, 12, 0, tzinfo=UTC)
    old_end = datetime(2026, 7, 1, 12, 0, tzinfo=UTC)
    new_start = datetime(2026, 6, 20, 12, 0, tzinfo=UTC)
    new_end = datetime(2026, 7, 20, 12, 0, tzinfo=UTC)
    last_seen_reset_at = datetime(2026, 6, 20, 11, 59, tzinfo=UTC)
    async with service_tx(pool) as conn:
        period_id = await periods_repo.open_period(
            conn,
            user_id=user_a,
            supabase_user_id=supabase_user_id,
            plan_code="basic",
            allowance_cents=3900,
            period_start=old_start,
            period_end=old_end,
            opening_litellm_spend=Decimal("1.23"),
            max_budget_cents_at_open=3900,
        )
        await conn.execute(
            """
            UPDATE pai_budget_periods
            SET allowance_consumed_cents = 1200,
                closing_litellm_spend = 9.99,
                reset_applied = TRUE
            WHERE id = %s
            """,
            (period_id,),
        )

        reanchored_id = await periods_repo.reanchor_open_period_for_upgrade(
            conn,
            user_id=user_a,
            supabase_user_id=supabase_user_id,
            plan_code="pro",
            allowance_cents=9900,
            period_start=new_start,
            period_end=new_end,
            opening_litellm_spend=Decimal("12.34"),
            last_seen_reset_at=last_seen_reset_at,
            max_budget_cents_at_open=11900,
        )
        cur = await conn.execute(
            """
            SELECT plan_code, allowance_cents, allowance_consumed_cents,
                   period_start, period_end, state, opening_litellm_spend,
                   closing_litellm_spend, last_seen_reset_at, reset_applied,
                   max_budget_cents_at_open
            FROM pai_budget_periods
            WHERE id = %s
            """,
            (period_id,),
        )
        row = await cur.fetchone()

    assert reanchored_id == period_id
    assert row["plan_code"] == "pro"
    assert row["allowance_cents"] == 9900
    assert row["allowance_consumed_cents"] == 0
    assert row["period_start"] == new_start
    assert row["period_end"] == new_end
    assert row["state"] == "open"
    assert row["opening_litellm_spend"] == Decimal("12.34")
    assert row["closing_litellm_spend"] is None
    assert row["last_seen_reset_at"] == last_seen_reset_at
    assert row["reset_applied"] is False
    assert row["max_budget_cents_at_open"] == 11900


async def test_consumption_record_idempotent(pool, user_ids):
    user_a, _ = user_ids
    now = utcnow()
    async with service_tx(pool) as conn:
        period_id = await periods_repo.open_period(
            conn,
            user_id=user_a,
            supabase_user_id=str(uuid.uuid4()),
            plan_code="free",
            allowance_cents=100000,
            period_start=now,
            period_end=now + timedelta(days=30),
        )
        first = await consumption_repo.record(
            conn,
            user_id=user_a,
            budget_period_id=period_id,
            bucket="allowance",
            cents=4200,
        )
        dup = await consumption_repo.record(
            conn,
            user_id=user_a,
            budget_period_id=period_id,
            bucket="allowance",
            cents=4200,
        )
    assert first is True
    assert dup is False
