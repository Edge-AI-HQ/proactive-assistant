"""Redis-independent budget reconciliation (Phase 2 credits).

Each due budget window is closed by rebuilding the credits ledger — plan
allowance first, overflow over credit grants FIFO (earliest expiry first) —
then the next window is opened and the LiteLLM spend window is reset. Runs as
a standalone asyncio task in the web-process lifespan, NOT gated on Redis, so
free users (who never produce an invoice.paid) still get reconciled.

Invariants:
- Window LLM spend is opening_litellm_spend carried from an immediate upgrade
  plus SpendLogs (append-only per-request rows over [period_start, period_end)),
  NOT a live key.spend counter diff. LiteLLM resets that counter on its own
  monthly schedule mid-window, so a counter diff is unreliable; SpendLogs
  survives the reset. Resetting key.spend at window roll is purely for the
  real-time max_budget cap, never for accounting.
- Only the scheduler closes windows; webhooks only move period_end. Multi-
  replica safe via claim_due_periods' FOR UPDATE SKIP LOCKED + the consumption
  UNIQUE index (replays are no-ops).
- DB ledger is committed BEFORE the LiteLLM reset; a LiteLLM failure leaves
  reset_applied=FALSE and self-heals on the next budget write.
- Money is integer cents end-to-end; USD only crosses at the LiteLLM boundary.

Design SSOT: docs/plans/2026-06-15-billing-plan-change-credits.mdx Phase 2.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime, timedelta
from decimal import Decimal

from ..db.repositories.provider_usage import ProviderUsageRepository
from ..db.rls import service_tx
from ..litellm import client as litellm_client
from ..payment import budget_periods as periods_repo
from ..payment import credit_consumption as consumption_repo
from ..payment import credit_grants as grants_repo
from ..payment import plans as plans_repo
from ..payment import subscriptions as subs_repo

logger = logging.getLogger(__name__)

_RECONCILE_INTERVAL_SEC = 60
_CREDITS_PER_USD = 100
_DEFAULT_PERIOD_DAYS = 30
_CLAIM_BATCH = 50


def _usd_to_cents(usd: Decimal | float | int) -> int:
    """Round a USD amount to integer cents (credits)."""
    return int((Decimal(str(usd)) * _CREDITS_PER_USD).quantize(Decimal("1")))


async def _reconcile_one(pool, period) -> None:
    """Reconcile one claimed (state='reconciling') window end to end."""
    from ..payment import checkout as checkout_flow

    user_id = period.user_id

    # 1. Read the user's LiteLLM key. No DB tx is held across the network call.
    async with service_tx(pool) as conn:
        virtual_key = await checkout_flow._virtual_key_for_user(conn, user_id)

    # 2. window_total (cents) = actual LiteLLM spend this window + provider
    #    (ASR) cost. The LiteLLM portion is summed from SpendLogs over
    #    [period_start, period_end) — append-only per-request rows that are
    #    immune to the key's monthly budget_reset_at auto-reset. We must NOT
    #    derive it from the live key.spend counter: LiteLLM resets that counter
    #    mid-window every cycle (reset anchored to the calendar month, not our
    #    window), so a closing-minus-opening diff under-counts and the old
    #    "reset raced" safety net over-charged the full ceiling, draining a
    #    user's purchased credits regardless of real usage. SpendLogs is the
    #    true draw. A transport failure raises out of _reconcile_one, leaving
    #    the window unclosed for retry (never charge a guessed amount).
    litellm_usd = 0.0
    if virtual_key:
        litellm_usd = await litellm_client.sum_spend_for_key_window(
            virtual_key=virtual_key,
            start=period.period_start,
            end=period.period_end,
        )
    litellm_cents = max(0, _usd_to_cents(litellm_usd))

    async with service_tx(pool) as conn:
        provider_usd = await ProviderUsageRepository(user_id, conn).sum_cost_usd(
            since=period.period_start
        )
    provider_cents = _usd_to_cents(provider_usd)

    carried_litellm_cents = max(0, _usd_to_cents(period.opening_litellm_spend))
    window_total = carried_litellm_cents + litellm_cents + provider_cents

    # 3. Rebuild the ledger, close this window, open the next — one tx.
    async with service_tx(pool) as conn:
        allowance_consumed = min(window_total, period.allowance_cents)
        overflow = window_total - allowance_consumed
        await consumption_repo.record(
            conn,
            user_id=user_id,
            budget_period_id=period.id,
            bucket="allowance",
            cents=allowance_consumed,
        )
        if overflow > 0:
            for grant in await grants_repo.list_active_fifo(conn, user_id):
                if overflow <= 0:
                    break
                take = min(overflow, grant.remaining_cents)
                await grants_repo.apply_consumption(conn, grant_id=grant.id, cents=take)
                await consumption_repo.record(
                    conn,
                    user_id=user_id,
                    budget_period_id=period.id,
                    grant_id=grant.id,
                    bucket="grant",
                    cents=take,
                )
                overflow -= take
            if overflow > 0:
                # max_budget caps total draw at allowance + credits, so this
                # shouldn't happen — log if the ledger somehow over-drew.
                logger.warning(
                    "budget reconcile: window=%s user=%d over-drew by %d cents",
                    period.id,
                    user_id,
                    overflow,
                )

        await periods_repo.close_period(
            conn,
            period_id=period.id,
            allowance_consumed_cents=allowance_consumed,
            closing_litellm_spend=Decimal(str(litellm_usd)),
        )

        # Open the next window for the user's CURRENT plan (downgrade/upgrade
        # already committed plan_code to pai_subscriptions before this tick).
        sub = await subs_repo.get_for_user(conn, user_id)
        plan_code = sub.plan_code if sub and sub.plan_code else "free"
        plan = await plans_repo.find_by_code(conn, plan_code)
        allowance_cents = plan.monthly_refresh_credits if plan else 0
        now = datetime.now(UTC)
        if sub and sub.current_period_end and sub.current_period_end > now:
            period_end = sub.current_period_end
        else:
            period_end = now + timedelta(days=_DEFAULT_PERIOD_DAYS)
        new_period_id = await periods_repo.open_period(
            conn,
            user_id=user_id,
            supabase_user_id=period.supabase_user_id,
            plan_code=plan_code,
            allowance_cents=allowance_cents,
            period_start=now,
            period_end=period_end,
            opening_litellm_spend=0,
        )

    # 4. DB committed → reset the LiteLLM spend window for the new period so the
    #    real-time max_budget cap (key.spend < max_budget) starts fresh. This
    #    only drives live enforcement; per-window accounting comes from
    #    SpendLogs (step 2), so it can never affect attribution. On failure
    #    reset_applied stays FALSE; the budget self-heals on the next budget
    #    write (recompute is an absolute, idempotent rebuild).
    async with service_tx(pool) as conn:
        applied = await checkout_flow.recompute_litellm_budget(conn, user_id, reset_spend=True)
        if applied:
            await periods_repo.mark_reset_applied(conn, period_id=new_period_id)


async def _reconcile_budget_periods(pool) -> int:
    """One reconciliation pass. Returns the number of windows processed."""
    async with service_tx(pool) as conn:
        claimed = await periods_repo.claim_due_periods(conn, limit=_CLAIM_BATCH)
    for period in claimed:
        try:
            await _reconcile_one(pool, period)
        except Exception:
            logger.exception(
                "budget reconcile failed window=%s user=%d; releasing for retry",
                period.id,
                period.user_id,
            )
            async with service_tx(pool) as conn:
                await periods_repo.release_period(conn, period_id=period.id)
    return len(claimed)


async def _expire_credit_grants(pool) -> int:
    """Expire credit grants past their 12-month TTL: forfeit the unused
    remainder (not refundable, per design) and shrink the LiteLLM ceiling.

    Read-time exclusion already keeps expired grants out of max_budget
    (sum_active_remaining_cents / list_active_fifo filter expires_at>NOW()),
    so this is the proactive sweep: flip status='expired', audit the forfeited
    cents, and recompute promptly — floored at current spend so an expiry can't
    instant-429 a user mid-cycle. Returns the number of users swept.
    """
    from ..payment import checkout as checkout_flow

    async with service_tx(pool) as conn:
        cur = await conn.execute(
            "SELECT DISTINCT user_id FROM pai_credit_grants "
            "WHERE status = 'active' AND expires_at <= NOW()"
        )
        user_ids = [r["user_id"] for r in await cur.fetchall()]

    for uid in user_ids:
        # Read current spend (for the 429 floor) — LiteLLM call, no tx held.
        async with service_tx(pool) as conn:
            virtual_key = await checkout_flow._virtual_key_for_user(conn, uid)
        floor_usd: float | None = None
        if virtual_key:
            info = await litellm_client.get_key_info(virtual_key)
            raw_spend = info.get("spend")
            if isinstance(raw_spend, (int, float)):
                floor_usd = float(raw_spend)

        async with service_tx(pool) as conn:
            cur = await conn.execute(
                """
                UPDATE pai_credit_grants
                SET status = 'expired', updated_at = NOW()
                WHERE user_id = %s AND status = 'active' AND expires_at <= NOW()
                RETURNING id, (grant_cents - consumed_cents) AS forfeited
                """,
                (uid,),
            )
            expired = await cur.fetchall()
            period = await periods_repo.get_open_period(conn, uid)
            if period is not None:
                for row in expired:
                    forfeited = int(row["forfeited"])
                    if forfeited > 0:
                        await consumption_repo.record(
                            conn,
                            user_id=uid,
                            budget_period_id=period.id,
                            grant_id=str(row["id"]),
                            bucket="expiry",
                            cents=forfeited,
                        )
            await checkout_flow.recompute_litellm_budget(
                conn, uid, reset_spend=False, floor_usd=floor_usd
            )
        logger.info("expired %d credit grant(s) for user=%d", len(expired), uid)
    return len(user_ids)


async def loop(pool) -> None:
    """Forever loop: reconcile due windows every ~60s; sweep expired credit
    grants ~daily. Initial stagger keeps cold-start work off the boot tick.
    Swallows generic errors to stay alive; re-raises CancelledError so
    lifespan shutdown can cancel it."""
    await asyncio.sleep(_RECONCILE_INTERVAL_SEC)
    expiry_every = max(1, 86_400 // _RECONCILE_INTERVAL_SEC)
    ticks = 0
    while True:
        try:
            processed = await _reconcile_budget_periods(pool)
            if processed:
                logger.info("budget reconcile: processed %d due window(s)", processed)
            if ticks % expiry_every == 0:
                swept = await _expire_credit_grants(pool)
                if swept:
                    logger.info("credit expiry: swept %d user(s)", swept)
        except asyncio.CancelledError:
            logger.info("budget reconcile loop cancelled")
            raise
        except Exception:
            logger.exception("budget reconcile pass raised")
        ticks += 1
        await asyncio.sleep(_RECONCILE_INTERVAL_SEC)
