"""pai_budget_periods repository — 每用户额度窗口 (一行 open,历史保留).

一个 DB 自管窗口驱动对账(免费 + 付费统一)。免费用户没有 invoice.paid,靠
period_end<=NOW() 被对账 job 认领。只有 scheduler 关窗,webhook 只标到期。

Service-role writes (scheduler 对账 + webhook 标到期)。设计 SSOT:
docs/plans/2026-06-15-billing-plan-change-credits.mdx Phase 2。
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from typing import Any


@dataclass(slots=True)
class BudgetPeriod:
    id: str
    user_id: int
    supabase_user_id: str
    plan_code: str
    allowance_cents: int
    allowance_consumed_cents: int
    period_start: datetime
    period_end: datetime
    state: str
    opening_litellm_spend: Decimal
    closing_litellm_spend: Decimal | None
    last_seen_reset_at: datetime | None
    reset_applied: bool
    max_budget_cents_at_open: int | None

    @classmethod
    def from_record(cls, row: dict[str, Any]) -> BudgetPeriod:
        return cls(
            id=str(row["id"]),
            user_id=int(row["user_id"]),
            supabase_user_id=str(row["supabase_user_id"]),
            plan_code=row["plan_code"],
            allowance_cents=int(row["allowance_cents"]),
            allowance_consumed_cents=int(row["allowance_consumed_cents"]),
            period_start=row["period_start"],
            period_end=row["period_end"],
            state=row["state"],
            opening_litellm_spend=Decimal(row["opening_litellm_spend"]),
            closing_litellm_spend=(
                Decimal(row["closing_litellm_spend"])
                if row.get("closing_litellm_spend") is not None
                else None
            ),
            last_seen_reset_at=row.get("last_seen_reset_at"),
            reset_applied=bool(row["reset_applied"]),
            max_budget_cents_at_open=(
                int(row["max_budget_cents_at_open"])
                if row.get("max_budget_cents_at_open") is not None
                else None
            ),
        )


async def get_open_period(conn, user_id: int) -> BudgetPeriod | None:
    """The user's current un-closed window (state open or reconciling). At
    most one exists (uq_budget_periods_one_open). recompute reads its
    allowance_consumed_cents to size the remaining allowance."""
    async with conn.cursor() as cur:
        await cur.execute(
            """
            SELECT * FROM pai_budget_periods
            WHERE user_id = %s AND state IN ('open', 'reconciling')
            ORDER BY period_start DESC
            LIMIT 1
            """,
            (user_id,),
        )
        row = await cur.fetchone()
    return BudgetPeriod.from_record(row) if row else None


async def open_period(
    conn,
    *,
    user_id: int,
    supabase_user_id: str,
    plan_code: str,
    allowance_cents: int,
    period_start: datetime,
    period_end: datetime,
    opening_litellm_spend: Decimal | int = 0,
    last_seen_reset_at: datetime | None = None,
    max_budget_cents_at_open: int | None = None,
) -> str:
    """Open a fresh window. allowance_consumed starts at 0; opening spend is
    the LiteLLM key spend at window start (0 right after a reset_spend).
    max_budget_cents_at_open records the LiteLLM ceiling for the reconcile
    safety net."""
    async with conn.cursor() as cur:
        await cur.execute(
            """
            INSERT INTO pai_budget_periods
              (user_id, supabase_user_id, plan_code, allowance_cents,
               period_start, period_end, state, opening_litellm_spend,
               last_seen_reset_at, max_budget_cents_at_open)
            VALUES (%s, %s, %s, %s, %s, %s, 'open', %s, %s, %s)
            RETURNING id
            """,
            (
                user_id,
                supabase_user_id,
                plan_code,
                allowance_cents,
                period_start,
                period_end,
                opening_litellm_spend,
                last_seen_reset_at,
                max_budget_cents_at_open,
            ),
        )
        row = await cur.fetchone()
    return str(row["id"])


async def ensure_open_period(
    conn,
    *,
    user_id: int,
    supabase_user_id: str,
    plan_code: str,
    allowance_cents: int,
    period_days: int = 30,
) -> str | None:
    """Open an initial window for a user who has none (e.g. a brand-new user
    provisioned after the 100 backfill). Idempotent: returns None if the user
    already has an open/reconciling window. period_end defaults to now + 30d
    (the reconcile job re-anchors to the real LiteLLM reset on close)."""
    existing = await get_open_period(conn, user_id)
    if existing is not None:
        return None
    async with conn.cursor() as cur:
        await cur.execute(
            """
            INSERT INTO pai_budget_periods
              (user_id, supabase_user_id, plan_code, allowance_cents,
               period_start, period_end, state, opening_litellm_spend,
               max_budget_cents_at_open)
            VALUES (%s, %s, %s, %s, NOW(), NOW() + make_interval(days => %s),
                    'open', 0, %s)
            RETURNING id
            """,
            (
                user_id,
                supabase_user_id,
                plan_code,
                allowance_cents,
                period_days,
                allowance_cents,
            ),
        )
        row = await cur.fetchone()
    return str(row["id"]) if row else None


async def reanchor_open_period_for_upgrade(
    conn,
    *,
    user_id: int,
    supabase_user_id: str,
    plan_code: str,
    allowance_cents: int,
    period_start: datetime,
    period_end: datetime,
    opening_litellm_spend: Decimal | int = 0,
    last_seen_reset_at: datetime | None = None,
    max_budget_cents_at_open: int | None = None,
) -> str:
    """Move the current open window onto an immediately-upgraded plan.

    Upgrade has already been paid and the LiteLLM spend counter is preserved,
    so the new accounting window starts at the upgrade instant instead of the
    old plan's renewal day. If no open window exists (older users/backfills),
    open one with the same boundaries.
    """
    async with conn.cursor() as cur:
        await cur.execute(
            """
            UPDATE pai_budget_periods
            SET plan_code = %s,
                allowance_cents = %s,
                allowance_consumed_cents = 0,
                period_start = %s,
                period_end = %s,
                opening_litellm_spend = %s,
                closing_litellm_spend = NULL,
                last_seen_reset_at = %s,
                reset_applied = FALSE,
                max_budget_cents_at_open = %s,
                updated_at = NOW()
            WHERE user_id = %s AND state = 'open'
            RETURNING id
            """,
            (
                plan_code,
                allowance_cents,
                period_start,
                period_end,
                opening_litellm_spend,
                last_seen_reset_at,
                max_budget_cents_at_open,
                user_id,
            ),
        )
        row = await cur.fetchone()
    if row:
        return str(row["id"])
    return await open_period(
        conn,
        user_id=user_id,
        supabase_user_id=supabase_user_id,
        plan_code=plan_code,
        allowance_cents=allowance_cents,
        period_start=period_start,
        period_end=period_end,
        opening_litellm_spend=opening_litellm_spend,
        last_seen_reset_at=last_seen_reset_at,
        max_budget_cents_at_open=max_budget_cents_at_open,
    )


async def claim_due_periods(conn, *, limit: int = 50) -> list[BudgetPeriod]:
    """Atomically claim due open windows for reconciliation: flip
    state open→reconciling and return them. FOR UPDATE SKIP LOCKED makes
    this safe across replicas (each row claimed by exactly one worker)."""
    async with conn.cursor() as cur:
        await cur.execute(
            """
            UPDATE pai_budget_periods
            SET state = 'reconciling', updated_at = NOW()
            WHERE id IN (
                SELECT id FROM pai_budget_periods
                WHERE state = 'open' AND period_end <= NOW()
                ORDER BY period_end ASC
                LIMIT %s
                FOR UPDATE SKIP LOCKED
            )
            RETURNING *
            """,
            (limit,),
        )
        rows = await cur.fetchall()
    return [BudgetPeriod.from_record(r) for r in rows]


async def close_period(
    conn,
    *,
    period_id: str,
    allowance_consumed_cents: int,
    closing_litellm_spend: Decimal | int,
) -> None:
    """Mark a claimed window reconciled with its final allowance draw +
    closing LiteLLM spend snapshot."""
    async with conn.cursor() as cur:
        await cur.execute(
            """
            UPDATE pai_budget_periods
            SET state = 'reconciled',
                allowance_consumed_cents = %s,
                closing_litellm_spend = %s,
                updated_at = NOW()
            WHERE id = %s
            """,
            (allowance_consumed_cents, closing_litellm_spend, period_id),
        )


async def release_period(conn, *, period_id: str) -> None:
    """Return a claimed window from 'reconciling' back to 'open' so the next
    tick retries it — used when reconciling a window raised before it closed
    (the ledger writes + close happen in one tx that rolled back, so the row
    is unchanged apart from the earlier state flip)."""
    async with conn.cursor() as cur:
        await cur.execute(
            """
            UPDATE pai_budget_periods
            SET state = 'open', updated_at = NOW()
            WHERE id = %s AND state = 'reconciling'
            """,
            (period_id,),
        )


async def mark_reset_applied(conn, *, period_id: str) -> None:
    """Record that the post-reconcile recompute(reset_spend=True) succeeded
    against LiteLLM, so a retry doesn't re-reset. Set on the NEW window."""
    async with conn.cursor() as cur:
        await cur.execute(
            """
            UPDATE pai_budget_periods
            SET reset_applied = TRUE, updated_at = NOW()
            WHERE id = %s
            """,
            (period_id,),
        )


async def set_period_end(conn, *, user_id: int, period_end: datetime) -> None:
    """Bring the user's open window's period_end forward (used on downgrade:
    invoice.paid sets it to NOW() so the next reconcile tick opens a fresh
    lower-tier window). No-op when the user has no open window."""
    async with conn.cursor() as cur:
        await cur.execute(
            """
            UPDATE pai_budget_periods
            SET period_end = %s, updated_at = NOW()
            WHERE user_id = %s AND state = 'open'
            """,
            (period_end, user_id),
        )
