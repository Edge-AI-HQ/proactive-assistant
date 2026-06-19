"""pai_credit_grants repository — 充值台账 (append-only).

一次充值一行。充值 credits 持久、12 月过期、不退。grant_cents/consumed_cents
以整数分计 (1 credit = $0.01,对齐 monthly_refresh_credits)。
stripe_payment_intent_id 是充值幂等锚(配合 099 的 partial unique 索引)。

Service-role writes (Stripe webhook 充值入账 + scheduler 对账扣减)。RLS 经
user-scope 策略对行 owner 开放读。设计 SSOT:
docs/plans/2026-06-15-billing-plan-change-credits.mdx Phase 2。
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any


@dataclass(slots=True)
class CreditGrant:
    id: str
    user_id: int
    grant_cents: int
    consumed_cents: int
    status: str
    granted_at: datetime
    expires_at: datetime

    @classmethod
    def from_record(cls, row: dict[str, Any]) -> CreditGrant:
        return cls(
            id=str(row["id"]),
            user_id=int(row["user_id"]),
            grant_cents=int(row["grant_cents"]),
            consumed_cents=int(row["consumed_cents"]),
            status=row["status"],
            granted_at=row["granted_at"],
            expires_at=row["expires_at"],
        )

    @property
    def remaining_cents(self) -> int:
        return self.grant_cents - self.consumed_cents


async def insert_topup_grant(
    conn,
    *,
    user_id: int,
    supabase_user_id: str,
    grant_cents: int,
    expires_at: datetime,
    stripe_payment_intent_id: str,
    stripe_event_id: str | None = None,
) -> str | None:
    """Insert a topup grant. Idempotent on stripe_payment_intent_id (the
    economic identity): returns the new grant id, or None when this
    payment_intent already produced a grant (ON CONFLICT DO NOTHING). The
    caller must only recompute the LiteLLM budget when a real row was
    inserted (non-None), so a webhook replay doesn't double-credit."""
    async with conn.cursor() as cur:
        await cur.execute(
            """
            INSERT INTO pai_credit_grants
              (user_id, supabase_user_id, grant_cents, source,
               stripe_payment_intent_id, stripe_event_id, expires_at)
            VALUES (%s, %s, %s, 'topup', %s, %s, %s)
            ON CONFLICT (stripe_payment_intent_id)
              WHERE source = 'topup' AND stripe_payment_intent_id IS NOT NULL
            DO NOTHING
            RETURNING id
            """,
            (
                user_id,
                supabase_user_id,
                grant_cents,
                stripe_payment_intent_id,
                stripe_event_id,
                expires_at,
            ),
        )
        row = await cur.fetchone()
    return str(row["id"]) if row else None


async def sum_active_remaining_cents(conn, user_id: int) -> int:
    """Σ(grant_cents − consumed_cents) over the user's active, un-expired
    grants. This is the 'credits' bucket that recompute_litellm_budget adds
    on top of the plan allowance."""
    async with conn.cursor() as cur:
        await cur.execute(
            """
            SELECT COALESCE(SUM(grant_cents - consumed_cents), 0) AS remaining
            FROM pai_credit_grants
            WHERE user_id = %s AND status = 'active' AND expires_at > NOW()
            """,
            (user_id,),
        )
        row = await cur.fetchone()
    return int(row["remaining"]) if row else 0


async def list_active_fifo(conn, user_id: int) -> list[CreditGrant]:
    """Active, un-expired grants ordered FIFO (earliest expiry first, then
    earliest granted) — the order the reconcile job drains overflow from."""
    async with conn.cursor() as cur:
        await cur.execute(
            """
            SELECT * FROM pai_credit_grants
            WHERE user_id = %s AND status = 'active' AND expires_at > NOW()
            ORDER BY expires_at ASC, granted_at ASC
            """,
            (user_id,),
        )
        rows = await cur.fetchall()
    return [CreditGrant.from_record(r) for r in rows]


async def apply_consumption(conn, *, grant_id: str, cents: int) -> None:
    """Add `cents` to a grant's consumed_cents and flip it to 'exhausted'
    once fully drained. Caller guarantees cents <= remaining (the CHECK
    consumed_cents <= grant_cents would otherwise reject)."""
    async with conn.cursor() as cur:
        await cur.execute(
            """
            UPDATE pai_credit_grants
            SET consumed_cents = consumed_cents + %s,
                status = CASE
                    WHEN consumed_cents + %s >= grant_cents THEN 'exhausted'
                    ELSE status
                END,
                updated_at = NOW()
            WHERE id = %s
            """,
            (cents, cents, grant_id),
        )
