"""pai_subscriptions repository + sync_from_stripe.

Single source of truth for "does this user have an active subscription?".
Webhook handlers call sync_from_stripe(); guard.has_active_subscription()
reads. The row is upserted, never appended — we don't track period
history (LiteLLM holds spend history, billing_plans holds catalog
history; if we ever need full period history, restore something like
apis's subscription_periods).

Service-role writes only. RLS opens reads to the row owner via the
user-scope policy.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

# These statuses count as "user has access". Stripe statuses we don't
# explicitly map fall through to no-access (defensive default).
_ACTIVE_STATUSES = frozenset({"trialing", "active"})


@dataclass(slots=True)
class SubscriptionRow:
    user_id: int
    stripe_customer_id: str | None
    stripe_subscription_id: str | None
    plan_code: str | None
    status: str
    current_period_start: datetime | None
    current_period_end: datetime | None
    cancel_at_period_end: bool
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_record(cls, row: dict[str, Any]) -> SubscriptionRow:
        return cls(
            user_id=int(row["user_id"]),
            stripe_customer_id=row.get("stripe_customer_id"),
            stripe_subscription_id=row.get("stripe_subscription_id"),
            plan_code=row.get("plan_code"),
            status=row["status"],
            current_period_start=row.get("current_period_start"),
            current_period_end=row.get("current_period_end"),
            cancel_at_period_end=bool(row.get("cancel_at_period_end")),
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )

    def is_access_granted(self) -> bool:
        """User can use paid features. Mirrors apis subscriptionPolicy."""
        return self.status in _ACTIVE_STATUSES


async def get_for_user(conn, user_id: int) -> SubscriptionRow | None:
    """Read the user's subscription row. Returns None if no row exists
    (user never started checkout)."""
    async with conn.cursor() as cur:
        await cur.execute(
            "SELECT * FROM pai_subscriptions WHERE user_id = %s",
            (user_id,),
        )
        row = await cur.fetchone()
    return SubscriptionRow.from_record(row) if row else None


async def upsert_user_stripe_customer(
    conn, *, user_id: int, stripe_customer_id: str,
) -> None:
    """Persist the Stripe customer_id back onto the users row so
    subsequent checkouts reuse it (avoids duplicate Stripe customers)."""
    async with conn.cursor() as cur:
        await cur.execute(
            """
            UPDATE users SET stripe_customer_id = %s
            WHERE id = %s AND (stripe_customer_id IS NULL OR stripe_customer_id <> %s)
            """,
            (stripe_customer_id, user_id, stripe_customer_id),
        )


async def sync_from_stripe_subscription(
    conn, *, user_id: int, plan_code: str | None, stripe_subscription: Any,
) -> SubscriptionRow:
    """Upsert pai_subscriptions from a Stripe Subscription object.

    Stripe.Subscription fields used:
      - id, customer, status
      - current_period_start, current_period_end (unix seconds)
      - cancel_at_period_end (bool)

    plan_code is resolved by the caller (look up pai_billing_plans by the
    subscription's first item's price id). Pass None to leave plan_code
    untouched (e.g. delete events).
    """
    sub = stripe_subscription
    sub_id = sub.id if hasattr(sub, "id") else sub.get("id")
    customer = sub.customer if hasattr(sub, "customer") else sub.get("customer")
    customer_id = customer if isinstance(customer, str) else (
        customer.get("id") if isinstance(customer, dict) else None
    )
    status = sub.status if hasattr(sub, "status") else sub.get("status", "inactive")
    cap = (sub.cancel_at_period_end if hasattr(sub, "cancel_at_period_end")
           else sub.get("cancel_at_period_end", False))
    p_start = _coerce_dt(_get(sub, "current_period_start"))
    p_end = _coerce_dt(_get(sub, "current_period_end"))

    async with conn.cursor() as cur:
        if plan_code is None:
            await cur.execute(
                """
                INSERT INTO pai_subscriptions
                  (user_id, stripe_customer_id, stripe_subscription_id,
                   status, current_period_start, current_period_end,
                   cancel_at_period_end, updated_at)
                VALUES (%s, %s, %s, %s, %s, %s, %s, NOW())
                ON CONFLICT (user_id) DO UPDATE SET
                  stripe_customer_id = EXCLUDED.stripe_customer_id,
                  stripe_subscription_id = EXCLUDED.stripe_subscription_id,
                  status = EXCLUDED.status,
                  current_period_start = EXCLUDED.current_period_start,
                  current_period_end = EXCLUDED.current_period_end,
                  cancel_at_period_end = EXCLUDED.cancel_at_period_end,
                  updated_at = NOW()
                RETURNING *
                """,
                (user_id, customer_id, sub_id, status, p_start, p_end, bool(cap)),
            )
        else:
            await cur.execute(
                """
                INSERT INTO pai_subscriptions
                  (user_id, stripe_customer_id, stripe_subscription_id,
                   plan_code, status,
                   current_period_start, current_period_end,
                   cancel_at_period_end, updated_at)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, NOW())
                ON CONFLICT (user_id) DO UPDATE SET
                  stripe_customer_id = EXCLUDED.stripe_customer_id,
                  stripe_subscription_id = EXCLUDED.stripe_subscription_id,
                  plan_code = EXCLUDED.plan_code,
                  status = EXCLUDED.status,
                  current_period_start = EXCLUDED.current_period_start,
                  current_period_end = EXCLUDED.current_period_end,
                  cancel_at_period_end = EXCLUDED.cancel_at_period_end,
                  updated_at = NOW()
                RETURNING *
                """,
                (user_id, customer_id, sub_id, plan_code, status,
                 p_start, p_end, bool(cap)),
            )
        row = await cur.fetchone()
    if row is None:
        msg = "subscription upsert returned no row"
        raise RuntimeError(msg)
    if customer_id:
        await upsert_user_stripe_customer(
            conn, user_id=user_id, stripe_customer_id=customer_id,
        )
    return SubscriptionRow.from_record(row)


def _get(obj: Any, attr: str) -> Any:
    if hasattr(obj, attr):
        return getattr(obj, attr)
    if isinstance(obj, dict):
        return obj.get(attr)
    return None


def _coerce_dt(v: Any) -> datetime | None:
    if v is None:
        return None
    if isinstance(v, datetime):
        return v if v.tzinfo else v.replace(tzinfo=UTC)
    if isinstance(v, (int, float)):
        return datetime.fromtimestamp(float(v), tz=UTC)
    if isinstance(v, str):
        try:
            s = v if not v.endswith("Z") else v[:-1] + "+00:00"
            return datetime.fromisoformat(s).astimezone(UTC)
        except ValueError:
            return None
    return None


# ── User lookup by Stripe identifiers (webhook side) ──


async def find_user_by_stripe_customer(conn, stripe_customer_id: str) -> int | None:
    """Resolve the pinai user from a Stripe customer_id. Used by webhook
    handlers when the event payload doesn't carry our user metadata."""
    async with conn.cursor() as cur:
        await cur.execute(
            "SELECT id FROM users WHERE stripe_customer_id = %s LIMIT 1",
            (stripe_customer_id,),
        )
        row = await cur.fetchone()
    return int(row["id"]) if row else None


async def find_user_by_stripe_subscription(conn, stripe_subscription_id: str) -> int | None:
    async with conn.cursor() as cur:
        await cur.execute(
            "SELECT user_id FROM pai_subscriptions WHERE stripe_subscription_id = %s LIMIT 1",
            (stripe_subscription_id,),
        )
        row = await cur.fetchone()
    return int(row["user_id"]) if row else None


async def find_user_by_supabase_user_id(conn, supabase_user_id: str) -> int | None:
    """Resolve the internal BIGINT id from a Supabase UUID. Used by the
    Stripe webhook to convert metadata.supabase_user_id (the external
    namespace per AGENTS.md "用户标识规约") back to the internal id
    needed for DB writes."""
    async with conn.cursor() as cur:
        await cur.execute(
            "SELECT id FROM users WHERE supabase_user_id = %s LIMIT 1",
            (supabase_user_id,),
        )
        row = await cur.fetchone()
    return int(row["id"]) if row else None
