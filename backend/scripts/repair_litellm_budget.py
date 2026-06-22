#!/usr/bin/env python3
"""Admin: force-align a user's plan_code, Stripe subscription, and LiteLLM
budget. Use when a webhook drift left the user in a wedged state (e.g.
trial budget never refreshed, plan_code out of sync with LiteLLM key).

Usage (inside the api container):
    docker compose exec api uv run python -m scripts.repair_litellm_budget \
        --email liam.yu0301@gmail.com --plan free

    # or by supabase UUID (preferred for cross-env stability):
    docker compose exec api uv run python -m scripts.repair_litellm_budget \
        --supabase-uuid <uuid> --plan pro

What it does (in order, each step logs success/skip/fail and proceeds):
  1. Resolve user (by email OR supabase_user_id).
  2. Read pai_subscriptions row. If it has a stripe_subscription_id, call
     Stripe.Subscription.delete() to cancel immediately (so no further
     renewal invoices fire for that stale state).
  3. UPDATE pai_subscriptions: plan_code → target plan, status → 'active',
     stripe_subscription_id → NULL. We don't go through
     sync_from_stripe_subscription here because we're explicitly
     overriding Stripe's view of the world.
  4. Call checkout.sync_litellm_budget_for_plan(reset_spend=True) so the
     LiteLLM key's max_budget matches the new plan and spend is zeroed.

Bypasses webhook + RLS (service_role conn). Logs to stdout. Safe to
re-run — every step is upsert/update style, idempotent.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import sys
from pathlib import Path


def _setup_path() -> None:
    root = Path(__file__).resolve().parents[1]
    src = root / "src"
    if str(src) not in sys.path:
        sys.path.insert(0, str(src))


_setup_path()

from pinai_api.payment import checkout as checkout_flow  # noqa: E402
from pinai_api.payment.stripe_client import requires_stripe  # noqa: E402
from pinai_api.platform.db.pool import close_pool, open_pool  # noqa: E402

logger = logging.getLogger("repair_litellm_budget")


_VALID_PLANS = frozenset({"free", "basic", "pro", "max"})


async def _find_user(conn, *, email: str | None, supabase_uuid: str | None) -> dict | None:
    """Look up the user row by email OR supabase_user_id. Returns the
    full row (id, supabase_user_id, email, litellm_virtual_key, ...)."""
    async with conn.cursor() as cur:
        if supabase_uuid:
            await cur.execute(
                "SELECT id, supabase_user_id, email, litellm_virtual_key "
                "FROM users WHERE supabase_user_id = %s LIMIT 1",
                (supabase_uuid,),
            )
        else:
            await cur.execute(
                "SELECT id, supabase_user_id, email, litellm_virtual_key "
                "FROM users WHERE email = %s LIMIT 1",
                (email,),
            )
        return await cur.fetchone()


async def _read_subscription(conn, user_id: int) -> dict | None:
    async with conn.cursor() as cur:
        await cur.execute(
            "SELECT stripe_subscription_id, plan_code, status "
            "FROM pai_subscriptions WHERE user_id = %s",
            (user_id,),
        )
        return await cur.fetchone()


def _cancel_stripe_subscription(sub_id: str) -> str:
    """Cancel a Stripe subscription immediately. Returns one of:
    'canceled' (success), 'already_canceled' (Stripe says it's gone),
    'error: <msg>' (caller logs but continues)."""
    stripe = requires_stripe()
    try:
        sub = stripe.Subscription.delete(sub_id)
        return getattr(sub, "status", "canceled")
    except Exception as e:
        msg = str(e)
        if "No such subscription" in msg or "already_canceled" in msg.lower():
            return "already_canceled"
        return f"error: {msg}"


async def _force_set_plan(conn, *, user_id: int, plan_code: str) -> None:
    """Override pai_subscriptions to the target plan. Sets
    stripe_subscription_id NULL so future webhooks for the (canceled)
    Stripe sub don't fight us."""
    async with conn.cursor() as cur:
        await cur.execute(
            """
            INSERT INTO pai_subscriptions
              (user_id, stripe_customer_id, stripe_subscription_id,
               plan_code, status,
               current_period_start, current_period_end, cancel_at_period_end,
               created_at, updated_at)
            VALUES (%s, NULL, NULL, %s, 'active', NULL, NULL, FALSE, NOW(), NOW())
            ON CONFLICT (user_id) DO UPDATE SET
              stripe_subscription_id = NULL,
              plan_code = EXCLUDED.plan_code,
              status = 'active',
              current_period_start = NULL,
              current_period_end = NULL,
              cancel_at_period_end = FALSE,
              updated_at = NOW()
            """,
            (user_id, plan_code),
        )


async def _main(args: argparse.Namespace) -> int:
    if args.plan not in _VALID_PLANS:
        logger.error("invalid --plan %r (must be one of %s)", args.plan, sorted(_VALID_PLANS))
        return 2
    if not (args.email or args.supabase_uuid):
        logger.error("must provide --email or --supabase-uuid")
        return 2

    pool = await open_pool()
    try:
        async with pool.connection() as conn:
            user = await _find_user(
                conn,
                email=args.email,
                supabase_uuid=args.supabase_uuid,
            )
            if user is None:
                logger.error("user not found (email=%s uuid=%s)", args.email, args.supabase_uuid)
                return 1
            user_id = int(user["id"])
            logger.info(
                "resolved user: id=%d email=%s supabase_uuid=%s litellm_key=%s",
                user_id,
                user.get("email"),
                user.get("supabase_user_id"),
                "set" if user.get("litellm_virtual_key") else "MISSING",
            )

            sub = await _read_subscription(conn, user_id)
            if sub is None:
                logger.info("no pai_subscriptions row — will create fresh")
            else:
                logger.info(
                    "current subscription: plan_code=%s status=%s stripe_sub=%s",
                    sub.get("plan_code"),
                    sub.get("status"),
                    sub.get("stripe_subscription_id"),
                )

            # Step 1: cancel Stripe subscription (if any).
            stripe_sub_id = sub.get("stripe_subscription_id") if sub else None
            if stripe_sub_id:
                result = _cancel_stripe_subscription(stripe_sub_id)
                logger.info("stripe cancel %s → %s", stripe_sub_id, result)
            else:
                logger.info("no Stripe subscription to cancel")

            # Step 2: force pai_subscriptions to target plan.
            await _force_set_plan(conn, user_id=user_id, plan_code=args.plan)
            logger.info("pai_subscriptions updated → plan=%s status=active", args.plan)

            # Step 3: sync LiteLLM key max_budget + reset spend.
            await checkout_flow.sync_litellm_budget_for_plan(
                conn,
                user_id,
                args.plan,
                reset_spend=True,
            )
            # sync_litellm_budget_for_plan logs success/failure internally.
            logger.info("done")
        return 0
    finally:
        await close_pool(pool)


def main() -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
    )
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--email", help="user email")
    parser.add_argument("--supabase-uuid", help="users.supabase_user_id (UUID)")
    parser.add_argument(
        "--plan",
        required=True,
        help="target plan_code (free / basic / pro / max)",
    )
    args = parser.parse_args()
    return asyncio.run(_main(args))


if __name__ == "__main__":
    sys.exit(main())
