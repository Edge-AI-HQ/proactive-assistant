"""Billing plan catalog — read-only at runtime.

Catalog edits go through migrations, not the API. This file just exposes
list / lookup helpers for the routes layer.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(slots=True)
class BillingPlan:
    plan_code: str
    display_name: str
    stripe_price_id: str
    currency: str
    price_cents_monthly: int
    monthly_refresh_credits: int
    trial_period_days: int
    sort_order: int
    is_active: bool
    metadata: dict[str, Any]

    @classmethod
    def from_record(cls, row: dict[str, Any]) -> BillingPlan:
        meta = row.get("metadata") or {}
        if isinstance(meta, str):
            import json
            meta = json.loads(meta)
        return cls(
            plan_code=row["plan_code"],
            display_name=row["display_name"],
            stripe_price_id=row["stripe_price_id"],
            currency=row["currency"],
            price_cents_monthly=int(row["price_cents_monthly"]),
            monthly_refresh_credits=int(row["monthly_refresh_credits"]),
            trial_period_days=int(row.get("trial_period_days") or 0),
            sort_order=int(row["sort_order"]),
            is_active=bool(row["is_active"]),
            metadata=meta if isinstance(meta, dict) else {},
        )

    def to_public_dict(self) -> dict[str, Any]:
        """Frontend pricing page shape."""
        return {
            "planCode": self.plan_code,
            "displayName": self.display_name,
            "currency": self.currency,
            "priceCentsMonthly": self.price_cents_monthly,
            "monthlyRefreshCredits": self.monthly_refresh_credits,
            "trialPeriodDays": self.trial_period_days,
            "sortOrder": self.sort_order,
        }


async def list_active(conn) -> list[BillingPlan]:
    async with conn.cursor() as cur:
        await cur.execute(
            """
            SELECT * FROM pai_billing_plans
            WHERE is_active = TRUE
            ORDER BY sort_order, plan_code
            """,
        )
        rows = await cur.fetchall()
    return [BillingPlan.from_record(r) for r in rows]


async def find_by_code(conn, plan_code: str) -> BillingPlan | None:
    async with conn.cursor() as cur:
        await cur.execute(
            "SELECT * FROM pai_billing_plans WHERE plan_code = %s AND is_active = TRUE",
            (plan_code,),
        )
        row = await cur.fetchone()
    return BillingPlan.from_record(row) if row else None


async def find_by_stripe_price(conn, stripe_price_id: str) -> BillingPlan | None:
    async with conn.cursor() as cur:
        await cur.execute(
            "SELECT * FROM pai_billing_plans WHERE stripe_price_id = %s",
            (stripe_price_id,),
        )
        row = await cur.fetchone()
    return BillingPlan.from_record(row) if row else None
