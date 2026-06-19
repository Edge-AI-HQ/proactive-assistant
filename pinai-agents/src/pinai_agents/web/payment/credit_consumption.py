"""pai_credit_consumption_events repository — 扣费审计 (append-only).

对账关窗时一行一笔:allowance 桶一行,每个被 FIFO 扣的 grant 一行,过期作废
一行。UNIQUE(period, COALESCE(grant,zero-uuid), bucket) 保证对账/webhook 重放
幂等。设计 SSOT: docs/plans/2026-06-15-billing-plan-change-credits.mdx Phase 2。
"""

from __future__ import annotations

# Placeholder UUID for the allowance/expiry buckets (grant_id IS NULL) so the
# unique index COALESCE(grant_id, this) matches the SQL-side COALESCE.
_NULL_GRANT_UUID = "00000000-0000-0000-0000-000000000000"


async def record(
    conn,
    *,
    user_id: int,
    budget_period_id: str,
    bucket: str,
    cents: int,
    grant_id: str | None = None,
) -> bool:
    """Append a consumption event. Idempotent via the unique
    (budget_period_id, COALESCE(grant_id, zero-uuid), bucket) index:
    returns True if a row was inserted, False on a duplicate (replay).
    bucket ∈ {'allowance','grant','expiry'}; grant_id required for 'grant'."""
    async with conn.cursor() as cur:
        await cur.execute(
            """
            INSERT INTO pai_credit_consumption_events
              (user_id, budget_period_id, grant_id, bucket, cents)
            VALUES (%s, %s, %s, %s, %s)
            ON CONFLICT (budget_period_id,
                         COALESCE(grant_id, '00000000-0000-0000-0000-000000000000'::uuid),
                         bucket)
            DO NOTHING
            RETURNING id
            """,
            (user_id, budget_period_id, grant_id, bucket, cents),
        )
        row = await cur.fetchone()
    return row is not None
