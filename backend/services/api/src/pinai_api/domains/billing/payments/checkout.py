"""Stripe Checkout / Subscription modification — create / upgrade / downgrade
/ cancel / customer-portal decision logic.

Branch table (called from routes.py /create-checkout):

  existing sub status      | target plan      | action
  -------------------------+------------------+--------------------------------
  none                     | any              | Checkout Session w/ trial
  modifiable, same plan    | any              | 400 already-on-this-plan
  modifiable, target > cur | upgrade          | charge flat delta, then
                           |                  | Subscription.modify(
                           |                  |   proration=none,
                           |                  |   trial_end=next month)
  modifiable, target < cur | downgrade        | Subscription.modify(
                           |                  |   proration=none,
                           |                  |   billing_cycle_anchor=unchanged)

"modifiable" = status in {trialing, active, past_due}. We never modify
canceled / incomplete subscriptions — those fall through to "new".

Trust note: this file runs in the web process and uses Stripe SDK
directly (which holds the master STRIPE_SECRET_KEY via stripe_client).
"""

from __future__ import annotations

import logging
import math
from datetime import UTC, datetime
from decimal import Decimal, InvalidOperation
from typing import Any
from urllib.parse import urlsplit, urlunsplit

from fastapi import HTTPException
from pinai_db.rls import service_tx, user_scoped_tx

from pinai_api.config import get_web_settings

from ....platform.auth.deps import User
from . import budget_periods as periods_repo
from . import credit_grants as grants_repo
from . import plans as plans_repo
from . import subscriptions as subs_repo
from .stripe_client import add_calendar_months, coerce_dt, requires_stripe, stripe_attr

logger = logging.getLogger(__name__)


# Statuses where we still talk to Stripe to modify the existing sub.
# past_due included — Stripe still allows modify; LiteLLM budget won't
# reset until invoice.paid clears.
_MODIFIABLE_STATUSES = frozenset({"trialing", "active", "past_due"})

# Credits are integer cents of USD (100 credits = $1). Conversion to dollars
# happens only at the LiteLLM boundary. Mirrors webhook._CREDITS_PER_USD.
_CREDITS_PER_USD = 100


# ── customer / item helpers ──


async def _get_user_stripe_customer_id(pool, user_id: int) -> str | None:
    """Read users.stripe_customer_id. Returns None if the user has never
    started a checkout."""
    from pinai_db.rls import user_scoped_tx as _scoped

    async with _scoped(pool, user_id) as conn, conn.cursor() as cur:
        await cur.execute(
            "SELECT stripe_customer_id FROM users WHERE id = %s",
            (user_id,),
        )
        row = await cur.fetchone()
    return (row or {}).get("stripe_customer_id")


async def _virtual_key_for_user(conn, user_id: int) -> str | None:
    """Fetch the user's LiteLLM virtual key from users table."""
    async with conn.cursor() as cur:
        await cur.execute(
            "SELECT litellm_virtual_key FROM users WHERE id = %s",
            (user_id,),
        )
        row = await cur.fetchone()
    if not row:
        return None
    key = row.get("litellm_virtual_key")
    return key if isinstance(key, str) and key else None


def _now_utc() -> datetime:
    return datetime.now(UTC)


def _append_checkout_session_id(url: str) -> str:
    parts = urlsplit(url)
    session_param = "session_id={CHECKOUT_SESSION_ID}"
    query = f"{parts.query}&{session_param}" if parts.query else session_param
    return urlunsplit((parts.scheme, parts.netloc, parts.path, query, parts.fragment))


def _duration_seconds(start: datetime, end: datetime) -> str:
    if start.tzinfo is None:
        start = start.replace(tzinfo=UTC)
    if end.tzinfo is None:
        end = end.replace(tzinfo=UTC)
    seconds = max(1, math.ceil((end - start).total_seconds()))
    return f"{seconds}s"


def _budget_duration_for_period_window(period: Any | None) -> str | None:
    period_start = getattr(period, "period_start", None)
    period_end = getattr(period, "period_end", None)
    if not isinstance(period_start, datetime) or not isinstance(period_end, datetime):
        return None
    return _duration_seconds(period_start, period_end)


async def _sync_litellm_budget_reset_at(conn, user_id: int, period: Any | None) -> None:
    """Pin LiteLLM's live reset timestamp to the DB budget period.

    LiteLLM's public ``budget_duration`` API standardizes values to calendar
    boundaries (for example ``30d`` means the first day of next month), so it
    cannot represent our per-user Stripe/DB billing anchor. LiteLLM and
    backend share the same Postgres database; the reset timestamp lives in
    the isolated ``litellm`` schema, so we update only this one scheduler field
    directly.

    Best-effort and transaction-isolated. This cross-schema write is wrapped in
    a SAVEPOINT and its failure is swallowed, because ``recompute_litellm_budget``
    runs inside the key-mint ``service_tx`` (``provisioning._provision_and_persist``)
    and in PostgreSQL a single failed statement aborts the ENTIRE transaction.
    Without the savepoint, a failure here (e.g. a missing ``litellm`` schema
    grant) rolls back the freshly-minted virtual key along with it — the #197
    regression that left every post-onboarding user with a NULL key until
    migration 127 restored the grant. The reset timestamp is not load-bearing;
    it self-heals on the next recompute.
    """
    period_end = getattr(period, "period_end", None)
    if not isinstance(period_end, datetime):
        return
    if period_end.tzinfo is None:
        period_end = period_end.replace(tzinfo=UTC)
    else:
        period_end = period_end.astimezone(UTC)
    try:
        # Nested transaction == SAVEPOINT: a failure rolls back only this
        # statement, never the caller's (key-mint) transaction. See docstring.
        async with conn.transaction(), conn.cursor() as cur:
            await cur.execute(
                """
                UPDATE litellm."LiteLLM_VerificationToken"
                SET budget_reset_at = %s,
                    budget_duration = '30d',
                    updated_at = NOW()
                WHERE metadata->>'source' = 'backend'
                  AND metadata->>'internal_user_id' = %s
                """,
                (period_end, str(user_id)),
            )
    except Exception:
        logger.warning(
            "litellm budget reset timestamp sync failed (non-fatal) user=%d",
            user_id,
        )


def _subscription_period_bounds(
    stripe_subscription: Any,
    *,
    fallback_start: datetime | None = None,
    fallback_end: datetime | None = None,
) -> tuple[datetime, datetime]:
    period_start = fallback_start or coerce_dt(
        stripe_attr(stripe_subscription, "current_period_start")
    )
    if period_start is None:
        period_start = _now_utc()
    period_end = coerce_dt(stripe_attr(stripe_subscription, "current_period_end"))
    if period_end is None:
        period_end = fallback_end
    if period_end is None or period_end <= period_start:
        period_end = add_calendar_months(period_start, 1)
    return period_start, period_end


async def _read_litellm_anchor_for_user(
    pool,
    user_id: int,
) -> tuple[Decimal, datetime | None]:
    """Read the LiteLLM spend/reset snapshot used to anchor a new DB window.

    Best-effort only: the accounting source of truth is SpendLogs, while this
    value preserves the live counter snapshot for audit and cap recompute.
    """
    from ....platform.litellm import client as litellm_client

    async with service_tx(pool) as conn:
        virtual_key = await _virtual_key_for_user(conn, user_id)
    if not virtual_key:
        return Decimal("0"), None
    try:
        info = await litellm_client.get_key_info(virtual_key)
    except litellm_client.LiteLLMError as e:
        logger.warning("failed to read LiteLLM spend anchor user=%d: %s", user_id, e)
        return Decimal("0"), None
    except Exception:
        logger.exception("unexpected failure reading LiteLLM spend anchor user=%d", user_id)
        return Decimal("0"), None

    raw_spend = info.get("spend")
    try:
        spend = Decimal(str(raw_spend)) if raw_spend is not None else Decimal("0")
    except (InvalidOperation, ValueError):
        spend = Decimal("0")
    return spend, coerce_dt(info.get("budget_reset_at"))


async def ensure_user_free_subscription(conn, user_id: int) -> None:
    """Upsert the user's pai_subscriptions row to Free state.
    Idempotent — safe to call repeatedly. Preserves stripe_customer_id
    on the row so a future resubscribe reuses the same Stripe Customer."""
    async with conn.cursor() as cur:
        await cur.execute(
            """
            INSERT INTO pai_subscriptions
              (user_id, stripe_customer_id, stripe_subscription_id,
               plan_code, status,
               current_period_start, current_period_end, cancel_at_period_end,
               created_at, updated_at)
            VALUES (%s, NULL, NULL, 'free', 'active', NULL, NULL, FALSE, NOW(), NOW())
            ON CONFLICT (user_id) DO UPDATE SET
              plan_code = 'free',
              stripe_subscription_id = NULL,
              status = 'active',
              current_period_start = NULL,
              current_period_end = NULL,
              cancel_at_period_end = FALSE,
              updated_at = NOW()
            """,
            (user_id,),
        )


async def recompute_litellm_budget(
    conn,
    user_id: int,
    *,
    reset_spend: bool = False,
    floor_usd: float | None = None,
) -> bool:
    """Single source of truth for a user's LiteLLM max_budget (Phase 2).

    Absolute recompute, never read-modify-write (so a webhook replay can't
    double-add and concurrent writers can't lose updates). The ceiling is::

        max_budget = (plan allowance remaining + active credit grants) / 100

    - Plan is resolved from pai_subscriptions (default 'free'); callers
      commit the plan there BEFORE calling.
    - Allowance remaining = plan.monthly_refresh_credits − the open window's
      allowance_consumed_cents. An OPEN window always has consumed=0 (it's
      only set when the window is reconciled), so mid-cycle this is the FULL
      (GROSS) allowance — LiteLLM's retained spend already nets usage, so
      netting consumed here too would double-deduct the user's own quota.
    - Credits = Σ(grant_cents − consumed_cents) over active, un-expired grants.

    reset_spend=True zeroes the LiteLLM spend window (renewal / reset to a
    fresh cycle); reset_spend=False preserves it (mid-cycle topup / upgrade —
    the cap rises, usage so far is kept).

    Returns True when the LiteLLM key was updated, False on no-op (user has
    no key yet — set on next ensure_user_litellm_key) or a swallowed
    LiteLLMError. Callers that need to know whether the spend reset actually
    applied (the reconcile job's reset_applied flag) use the return value.
    LiteLLMError is swallowed (logged): Stripe/DB state is already persisted;
    the budget self-heals on the next recompute.
    """
    from ....platform.litellm import client as litellm_client

    virtual_key = await _virtual_key_for_user(conn, user_id)
    if not virtual_key:
        return False

    sub = await subs_repo.get_for_user(conn, user_id)
    plan_code = sub.plan_code if sub and sub.plan_code else "free"
    plan = await plans_repo.find_by_code(conn, plan_code)
    allowance_cents = plan.monthly_refresh_credits if plan else 0

    period = await periods_repo.get_open_period(conn, user_id)
    allowance_consumed = period.allowance_consumed_cents if period else 0
    allowance_remaining = max(0, allowance_cents - allowance_consumed)

    credits_remaining = await grants_repo.sum_active_remaining_cents(conn, user_id)
    max_budget_usd = (allowance_remaining + credits_remaining) / _CREDITS_PER_USD
    # floor_usd protects against an instant 429 when the ceiling drops below
    # spend already incurred (credit expiry): forfeit the unused remainder but
    # don't retroactively block what the user already spent this window.
    if floor_usd is not None and floor_usd > max_budget_usd:
        max_budget_usd = floor_usd

    try:
        await litellm_client.update_key(
            virtual_key=virtual_key,
            max_budget_usd=max_budget_usd,
            reset_spend=reset_spend,
        )
        await _sync_litellm_budget_reset_at(conn, user_id, period)
        logger.info(
            "litellm budget recomputed: user=%d plan=%s allowance_remaining=%d "
            "credits=%d max_budget=$%.2f reset_spend=%s",
            user_id,
            plan_code,
            allowance_remaining,
            credits_remaining,
            max_budget_usd,
            reset_spend,
        )
        return True
    except litellm_client.LiteLLMError as e:
        logger.exception("litellm budget recompute failed user=%d: %s", user_id, e)
        return False
    except Exception:
        logger.exception("litellm budget recompute failed unexpectedly user=%d", user_id)
        return False


async def sync_litellm_budget_for_plan(
    conn,
    user_id: int,
    plan_code: str,
    *,
    reset_spend: bool = True,
) -> None:
    """Compatibility wrapper around recompute_litellm_budget.

    Phase 2 made recompute_litellm_budget the single budget writer — it
    resolves the plan from pai_subscriptions and adds active credit grants on
    top of the plan allowance. This wrapper is kept so existing call sites
    (immediate upgrade, reconcile, cancel-to-free) and their tests stay
    unchanged. `plan_code` is now informational: every caller commits the
    plan to pai_subscriptions before calling, and recompute reads it there.
    """
    await recompute_litellm_budget(conn, user_id, reset_spend=reset_spend)


async def ensure_stripe_customer(pool, *, user: User) -> str:
    """Resolve or create the user's Stripe Customer. Pins customer_id
    back onto users.stripe_customer_id when newly created."""
    stripe = requires_stripe()

    existing = await _get_user_stripe_customer_id(pool, user.id)
    if existing:
        return existing

    customer = stripe.Customer.create(
        email=user.email or None,
        metadata={
            "supabase_user_id": user.supabase_user_id,
            "internal_user_id": str(user.id),
        },
    )
    async with service_tx(pool) as conn:
        await subs_repo.upsert_user_stripe_customer(
            conn,
            user_id=user.id,
            stripe_customer_id=customer.id,
        )
    return customer.id


# Credit topup bounds (integer cents). Presets 2000/5000/10000 are a UI
# concern; the backend only enforces min/max. 1:1 (no discount) per design.
_TOPUP_MIN_CENTS = 500  # $5
_TOPUP_MAX_CENTS = 100_000  # $1000 per one-off topup


async def create_topup_checkout(
    pool,
    *,
    user: User,
    amount_cents: int,
    success_url_override: str | None = None,
    cancel_url_override: str | None = None,
) -> dict[str, Any]:
    """Create a one-off Stripe Checkout Session (mode='payment') that buys
    `amount_cents` of credits 1:1. The grant is written when Stripe fires
    checkout.session.completed (webhook), idempotent on the PaymentIntent.

    Mirrors the mode='subscription' branch of create_or_change_subscription
    but with a dynamic price (price_data, not a catalog price), no
    subscription_data, and a kind='topup' metadata tag the webhook keys on.
    """
    if amount_cents < _TOPUP_MIN_CENTS or amount_cents > _TOPUP_MAX_CENTS:
        raise HTTPException(
            400,
            f"topup amount must be between ${_TOPUP_MIN_CENTS / 100:.0f} "
            f"and ${_TOPUP_MAX_CENTS / 100:.0f}",
        )
    settings = get_web_settings()
    stripe = requires_stripe()
    customer_id = await ensure_stripe_customer(pool, user=user)
    base = settings.payment_public_base_url or ""
    success = success_url_override or (f"{base}/payment/success" if base else None)
    cancel = cancel_url_override or (f"{base}/payment/cancel" if base else None)
    if not success or not cancel:
        raise HTTPException(
            500,
            "checkout success / cancel URLs not configured "
            "(set PAYMENT_PUBLIC_BASE_URL or pass successUrl/cancelUrl)",
        )

    # Stripe metadata values must be strings. credit_cents == amount paid (1:1).
    meta = {
        "supabase_user_id": user.supabase_user_id,
        "internal_user_id": str(user.id),
        "kind": "topup",
        "credit_cents": str(amount_cents),
    }
    session = stripe.checkout.Session.create(
        mode="payment",
        customer=customer_id,
        line_items=[
            {
                "price_data": {
                    "currency": "usd",
                    "unit_amount": amount_cents,
                    "product_data": {"name": f"PIN AI credits (${amount_cents / 100:.2f})"},
                },
                "quantity": 1,
            }
        ],
        success_url=_append_checkout_session_id(success),
        cancel_url=cancel,
        metadata=meta,
        payment_intent_data={"metadata": meta},
    )
    return {
        "checkoutUrl": session.url,
        "sessionId": session.id,
        "flow": "topup",
    }


def get_subscription_item_id(stripe_subscription_id: str) -> str:
    """Look up the (singleton) subscription_item id for a Stripe Subscription.
    We only ever attach one line item per subscription, so items.data[0].id
    is the canonical answer.

    NOTE: stripe.StripeObject subclasses dict, so `sub.items` returns
    dict.items() (the builtin method), not the subscription items field.
    Must use sub["items"] for the actual subscription items collection.
    """
    stripe = requires_stripe()
    sub = stripe.Subscription.retrieve(stripe_subscription_id)
    items = sub["items"]
    data = items["data"] if isinstance(items, dict) else items.data
    if not data:
        msg = f"subscription {stripe_subscription_id} has no items"
        raise RuntimeError(msg)
    first = data[0]
    return first["id"] if isinstance(first, dict) else first.id


# ── main flow ──


async def create_or_change_subscription(
    pool,
    *,
    user: User,
    plan_code: str,
    success_url_override: str | None = None,
    cancel_url_override: str | None = None,
) -> dict[str, Any]:
    """Entry point for /api/payment/create-checkout.

    Returns one of:
      - {"checkoutUrl": str, "sessionId": str, "flow": "new"}
        — user needs to enter card on Stripe Checkout page
      - {"checkoutUrl": None, "flow": "upgrade"|"downgrade"}
        — existing subscription modified in place; frontend can show
          success state immediately
    """
    settings = get_web_settings()
    stripe = requires_stripe()

    async with user_scoped_tx(pool, user.id) as conn:
        target_plan = await plans_repo.find_by_code(conn, plan_code)
        if target_plan is None:
            raise HTTPException(400, f"unknown plan: {plan_code}")
        existing_sub = await subs_repo.get_for_user(conn, user.id)
        # Resolve current plan when we have an existing sub so we can
        # compare prices for upgrade/downgrade direction.
        current_plan = (
            await plans_repo.find_by_code(conn, existing_sub.plan_code)
            if existing_sub is not None and existing_sub.plan_code
            else None
        )

    is_modifiable = (
        existing_sub is not None
        and existing_sub.stripe_subscription_id is not None
        and existing_sub.status in _MODIFIABLE_STATUSES
    )

    if not is_modifiable:
        # NEW SUBSCRIPTION — Checkout Session with trial.
        customer_id = await ensure_stripe_customer(pool, user=user)
        base = settings.payment_public_base_url or ""
        success = success_url_override or (f"{base}/payment/success" if base else None)
        cancel = cancel_url_override or (f"{base}/payment/cancel" if base else None)
        if not success or not cancel:
            raise HTTPException(
                500,
                "checkout success / cancel URLs not configured "
                "(set PAYMENT_PUBLIC_BASE_URL or pass successUrl/cancelUrl)",
            )

        sub_metadata = {
            "supabase_user_id": user.supabase_user_id,
            "internal_user_id": str(user.id),
            "plan_code": target_plan.plan_code,
        }
        session = stripe.checkout.Session.create(
            mode="subscription",
            customer=customer_id,
            line_items=[{"price": target_plan.stripe_price_id, "quantity": 1}],
            success_url=_append_checkout_session_id(success),
            cancel_url=cancel,
            allow_promotion_codes=True,
            metadata=sub_metadata,
            subscription_data={
                "metadata": sub_metadata,
            },
        )
        return {
            "checkoutUrl": session.url,
            "sessionId": session.id,
            "flow": "new",
        }

    # ── existing modifiable sub ──
    assert existing_sub is not None  # for type-narrowing
    assert existing_sub.stripe_subscription_id is not None

    # Case A: target matches an already-scheduled switch — user clicked
    # the same pending plan again. Stripe.items[0].price + pending_plan_code
    # are already correct; skip the redundant Stripe API call + DB write.
    # Frontend gets the same "switch scheduled" toast as the first click.
    if (
        existing_sub.pending_plan_code is not None
        and existing_sub.pending_plan_code == target_plan.plan_code
    ):
        return {
            "checkoutUrl": None,
            # Direction relative to the current plan, not the pending one.
            "flow": (
                "upgrade"
                if current_plan is not None
                and target_plan.price_cents_monthly > current_plan.price_cents_monthly
                else "downgrade"
            ),
            "pendingPlanCode": target_plan.plan_code,
        }

    # Case B: target matches current plan AND there's a pending switch
    # → user wants to revoke the scheduled switch and stay put.
    # We must reset Stripe.items[0].price back to the current plan's
    # price too — otherwise next renewal still bills at the pending
    # plan's price even though we cleared pending_plan_code on our side.
    if (
        existing_sub.plan_code == target_plan.plan_code
        and existing_sub.pending_plan_code is not None
    ):
        item_id = get_subscription_item_id(existing_sub.stripe_subscription_id)
        revoked = stripe.Subscription.modify(
            existing_sub.stripe_subscription_id,
            items=[{"id": item_id, "price": target_plan.stripe_price_id}],
            proration_behavior="none",
            billing_cycle_anchor="unchanged",
            cancel_at_period_end=False,
            metadata={
                "supabase_user_id": user.supabase_user_id,
                "plan_code": target_plan.plan_code,
                # Stripe convention: empty string unsets the metadata key.
                # Must clear here too so the cloud webhook doesn't re-promote
                # the now-revoked plan on next invoice.paid.
                "pending_plan_code": "",
            },
        )
        async with service_tx(pool) as conn:
            await subs_repo.sync_from_stripe_subscription(
                conn,
                user_id=user.id,
                plan_code=None,
                stripe_subscription=revoked,
                update_plan_code=False,
            )
            await subs_repo.clear_pending_plan_code(conn, user.id)
        return {
            "checkoutUrl": None,
            "flow": "revoke",
            "pendingPlanCode": None,
        }

    # Case C: target matches current plan, no pending — genuinely a no-op
    # that almost certainly is a user error (the picker shouldn't expose
    # the current plan as an option).
    if existing_sub.plan_code == target_plan.plan_code:
        raise HTTPException(400, f"already on plan {target_plan.plan_code}")
    if current_plan is None:
        # Data inconsistency: pai_subscriptions row points to a plan_code
        # not present in pai_billing_plans. Bail out loudly — manual fix
        # in DB needed.
        raise HTTPException(
            500,
            "existing subscription references unknown plan "
            f"{existing_sub.plan_code!r}; manual data fix required",
        )

    is_upgrade = target_plan.price_cents_monthly > current_plan.price_cents_monthly
    if is_upgrade:
        # Immediate upgrade: charge the flat difference now + promote now.
        # Downgrades fall through to the deferred pending_plan_code path below.
        return await _apply_immediate_upgrade(
            pool,
            user=user,
            existing_sub=existing_sub,
            current_plan=current_plan,
            target_plan=target_plan,
        )

    item_id = get_subscription_item_id(existing_sub.stripe_subscription_id)
    # pending_plan_code is replicated to Stripe subscription metadata so the
    # webhook on a *different* backend can still resolve it on next renewal.
    # Without this, a switch scheduled locally + invoice.paid handled in the
    # cloud falls back to "Stripe items[0].price" which is already the next-
    # cycle price → cloud DB gets promoted one cycle early.
    mod_metadata = {
        "supabase_user_id": user.supabase_user_id,
        "plan_code": target_plan.plan_code,
        "pending_plan_code": target_plan.plan_code,
    }

    # Switch (upgrade / downgrade / lateral): never apply mid-period.
    # User keeps the current plan + budget through current_period_end;
    # the new plan kicks in on the next invoice.paid, where the webhook
    # promotes pending_plan_code → plan_code and resets LiteLLM to the
    # new cap. Stripe: items[0].price changes now (Stripe needs it to
    # compute the next invoice), but billing_cycle_anchor="unchanged" +
    # proration_behavior="none" mean the user isn't charged a cent until
    # next renewal.
    #
    # cancel_at_period_end=False: switching plans signals "I want to keep
    # using this product", so we revoke any pending cancellation. Without
    # this, a user who clicked Cancel and then Switch ends up with a
    # subscription that cancels at period_end (no renewal → no
    # invoice.paid → pending_plan_code never activates).
    modified = stripe.Subscription.modify(
        existing_sub.stripe_subscription_id,
        items=[{"id": item_id, "price": target_plan.stripe_price_id}],
        proration_behavior="none",
        billing_cycle_anchor="unchanged",
        cancel_at_period_end=False,
        metadata=mod_metadata,
    )
    async with service_tx(pool) as conn:
        # Sync canonical Stripe state back (status / period / cancel
        # flag) without touching plan_code — the new price already lives
        # on the Stripe sub, but pai_subscriptions.plan_code stays on
        # the current paid plan until invoice.paid promotes pending.
        await subs_repo.sync_from_stripe_subscription(
            conn,
            user_id=user.id,
            plan_code=None,
            stripe_subscription=modified,
            update_plan_code=False,
        )
        await subs_repo.set_pending_plan_code(
            conn,
            user_id=user.id,
            pending_plan_code=target_plan.plan_code,
        )
    return {
        "checkoutUrl": None,
        "flow": "upgrade" if is_upgrade else "downgrade",
        "pendingPlanCode": target_plan.plan_code,
    }


async def _apply_immediate_upgrade(
    pool,
    *,
    user: User,
    existing_sub: Any,
    current_plan: Any,
    target_plan: Any,
) -> dict[str, Any]:
    """Immediate upgrade: charge the flat (new − old) price difference now,
    and ONLY after it clears swap the Stripe price + promote plan_code +
    raise the LiteLLM budget (spend preserved) + re-anchor the DB budget
    window to the upgraded billing period.

    Flat difference, not Stripe day-proration: our unit of value is credits
    (a quota), not days of access. Upgrading buys the bigger bucket, so the
    charge is the full price delta and the user immediately gets the full
    new allowance. The upgrade starts a new monthly period: a user who moves
    Basic → Pro on the 20th next resets on the following month's 20th. We use
    trial_end for that next renewal anchor because billing_cycle_anchor=now
    would make Stripe send another immediate subscription invoice.
    """
    stripe = requires_stripe()
    customer_id = existing_sub.stripe_customer_id or await _get_user_stripe_customer_id(
        pool, user.id
    )
    if not customer_id:
        raise HTTPException(400, "no Stripe customer for upgrade")

    delta_cents = target_plan.price_cents_monthly - current_plan.price_cents_monthly
    if delta_cents <= 0:
        # Defensive: create_or_change_subscription only routes true upgrades here.
        raise HTTPException(400, "upgrade difference must be positive")

    meta = {
        "kind": "upgrade_delta",
        "supabase_user_id": user.supabase_user_id,
        "from_plan": current_plan.plan_code,
        "to_plan": target_plan.plan_code,
    }

    # 1. Charge the difference NOW and confirm it's paid BEFORE touching any
    #    subscription / plan / budget state.
    #
    # Order matters (verified against Stripe test mode 2026-06-16): create the
    # invoice FIRST, then attach the one-off line item via `invoice=`.
    # Invoice.create does NOT pull in customer-pending InvoiceItems by
    # default — a customer-only item would be left off and the invoice would
    # total $0 (the user would get the upgrade for free).
    invoice = stripe.Invoice.create(
        customer=customer_id,
        collection_method="charge_automatically",
        auto_advance=False,
        metadata=meta,
    )
    stripe.InvoiceItem.create(
        customer=customer_id,
        invoice=invoice.id,
        amount=delta_cents,
        currency="usd",
        description=(f"Upgrade {current_plan.plan_code} → {target_plan.plan_code} (difference)"),
        metadata=meta,
    )
    invoice = stripe.Invoice.finalize_invoice(invoice.id)
    # finalize auto-settles a $0 invoice but leaves a real charge 'open'.
    # Only pay() when not already paid — pay() on an already-paid invoice
    # raises "Invoice is already paid", which would wrongly look like a
    # payment failure (verified against Stripe test mode 2026-06-16).
    if stripe_attr(invoice, "status") != "paid":
        try:
            invoice = stripe.Invoice.pay(invoice.id)
        except Exception as e:
            try:
                stripe.Invoice.void_invoice(invoice.id)
            except Exception:
                logger.warning("failed to void unpaid upgrade invoice %s", invoice.id)
            raise HTTPException(
                status_code=402,
                detail=f"upgrade payment failed: {type(e).__name__}",
            ) from e
    if stripe_attr(invoice, "status") != "paid":
        stripe.Invoice.void_invoice(invoice.id)
        raise HTTPException(402, "upgrade payment not completed")

    opening_litellm_spend, last_seen_reset_at = await _read_litellm_anchor_for_user(
        pool,
        user.id,
    )

    upgrade_period_start = _now_utc()
    upgrade_period_end = add_calendar_months(upgrade_period_start, 1)

    # 2. Difference paid → swap the recurring price, anchor the next full
    #    subscription invoice one month from now, and revoke any scheduled
    #    switch. The already-paid one-off invoice covers the upgraded period.
    item_id = get_subscription_item_id(existing_sub.stripe_subscription_id)
    modified = stripe.Subscription.modify(
        existing_sub.stripe_subscription_id,
        items=[{"id": item_id, "price": target_plan.stripe_price_id}],
        proration_behavior="none",
        trial_end=int(upgrade_period_end.timestamp()),
        cancel_at_period_end=False,
        metadata={
            "supabase_user_id": user.supabase_user_id,
            "plan_code": target_plan.plan_code,
            "pending_plan_code": "",
        },
    )
    period_start, period_end = _subscription_period_bounds(
        modified,
        fallback_start=upgrade_period_start,
        fallback_end=upgrade_period_end,
    )

    # 3. Promote plan_code immediately + move the DB ledger to the upgraded
    #    period + raise LiteLLM budget, keeping spend.
    async with service_tx(pool) as conn:
        await subs_repo.sync_from_stripe_subscription(
            conn,
            user_id=user.id,
            plan_code=target_plan.plan_code,
            stripe_subscription=modified,
            update_plan_code=True,
        )
        await subs_repo.clear_pending_plan_code(conn, user.id)
        credits_remaining = await grants_repo.sum_active_remaining_cents(conn, user.id)
        await periods_repo.reanchor_open_period_for_upgrade(
            conn,
            user_id=user.id,
            supabase_user_id=user.supabase_user_id,
            plan_code=target_plan.plan_code,
            allowance_cents=target_plan.monthly_refresh_credits,
            period_start=period_start,
            period_end=period_end,
            opening_litellm_spend=opening_litellm_spend,
            last_seen_reset_at=last_seen_reset_at,
            max_budget_cents_at_open=target_plan.monthly_refresh_credits + credits_remaining,
        )
        await sync_litellm_budget_for_plan(
            conn,
            user.id,
            target_plan.plan_code,
            reset_spend=False,
        )

    logger.info(
        "immediate upgrade applied: user=%d %s → %s (charged %d cents)",
        user.id,
        current_plan.plan_code,
        target_plan.plan_code,
        delta_cents,
    )
    return {
        "checkoutUrl": None,
        "flow": "upgrade",
        "applied": True,
        "pendingPlanCode": None,
    }


async def cancel_subscription(pool, *, user: User) -> dict[str, Any]:
    """Soft cancel: cancel_at_period_end=True. User keeps access until
    current_period_end then Stripe transitions to canceled, firing
    customer.subscription.deleted which zeros LiteLLM budget.

    No refund (per project plan, matches PIN Claw policy)."""
    stripe = requires_stripe()
    async with user_scoped_tx(pool, user.id) as conn:
        sub = await subs_repo.get_for_user(conn, user.id)
    if not sub or not sub.stripe_subscription_id:
        raise HTTPException(400, "no active subscription to cancel")
    if sub.status not in _MODIFIABLE_STATUSES:
        raise HTTPException(
            400,
            f"subscription is {sub.status}, cannot cancel",
        )
    if sub.cancel_at_period_end:
        # Already scheduled to cancel — idempotent.
        return {
            "ok": True,
            "alreadyScheduled": True,
            "currentPeriodEnd": (
                sub.current_period_end.isoformat() if sub.current_period_end else None
            ),
        }
    stripe.Subscription.modify(
        sub.stripe_subscription_id,
        cancel_at_period_end=True,
    )
    return {
        "ok": True,
        "currentPeriodEnd": (
            sub.current_period_end.isoformat() if sub.current_period_end else None
        ),
    }


async def create_customer_portal_session(
    pool,
    *,
    user: User,
    return_url_override: str | None = None,
) -> dict[str, Any]:
    """Return a Stripe Customer Portal session URL. The portal handles
    billing history, card update, cancel UI, invoice download —
    everything we deliberately do NOT self-implement.

    Reads stripe_customer_id from users (works as soon as the user has
    at least started a Checkout — pai_subscriptions row only appears
    after webhook fires)."""
    stripe = requires_stripe()
    settings = get_web_settings()
    customer_id = await _get_user_stripe_customer_id(pool, user.id)
    if not customer_id:
        raise HTTPException(
            400,
            "no Stripe customer; complete checkout first",
        )
    base = settings.payment_public_base_url or ""
    return_url = return_url_override or (f"{base}/account" if base else None)
    if not return_url:
        raise HTTPException(500, "PAYMENT_PUBLIC_BASE_URL not configured")
    portal = stripe.billing_portal.Session.create(
        customer=customer_id,
        return_url=return_url,
    )
    return {"portalUrl": portal.url}


# ── reconcile + read-from-Stripe helpers ──

# Statuses we consider "real" enough to sync to pai_subscriptions.
_STRIPE_LIVE_STATUSES = frozenset(
    {"trialing", "active", "past_due", "canceled"},
)


def _payment_method_entry(
    *,
    pm_id: str,
    pm_type: str,
    is_default: bool,
    is_saved: bool,
    source: str,
) -> dict[str, Any]:
    return {
        "id": pm_id,
        "type": pm_type,
        "isDefault": is_default,
        "isSaved": is_saved,
        "source": source,
        "brand": None,
        "last4": None,
        "expMonth": None,
        "expYear": None,
        "linkEmail": None,
    }


def _entry_from_checkout_charge(
    charge: Any,
    *,
    is_default: bool = False,
    fallback_email: str | None = None,
) -> dict[str, Any] | None:
    details = stripe_attr(charge, "payment_method_details")
    pm_type = stripe_attr(details, "type")
    charge_id = stripe_attr(charge, "id")
    if not isinstance(pm_type, str) or not pm_type:
        return None
    if not isinstance(charge_id, str) or not charge_id:
        return None

    entry = _payment_method_entry(
        pm_id=charge_id,
        pm_type=pm_type,
        is_default=is_default,
        is_saved=False,
        source="checkout",
    )
    if pm_type == "card":
        card = stripe_attr(details, "card")
        entry["brand"] = stripe_attr(card, "brand")
        entry["last4"] = stripe_attr(card, "last4")
        entry["expMonth"] = stripe_attr(card, "exp_month")
        entry["expYear"] = stripe_attr(card, "exp_year")
    elif pm_type == "link":
        link = stripe_attr(details, "link")
        link_email = stripe_attr(link, "email")
        entry["linkEmail"] = (
            link_email if isinstance(link_email, str) and link_email else fallback_email
        )
    return entry


async def _latest_topup_payment_intent_id(pool, user_id: int) -> str | None:
    async with user_scoped_tx(pool, user_id) as conn, conn.cursor() as cur:
        await cur.execute(
            """
            SELECT stripe_payment_intent_id
            FROM pai_credit_grants
            WHERE user_id = %s
              AND source = 'topup'
              AND stripe_payment_intent_id IS NOT NULL
            ORDER BY granted_at DESC
            LIMIT 1
            """,
            (user_id,),
        )
        row = await cur.fetchone()
    pi_id = (row or {}).get("stripe_payment_intent_id")
    return pi_id if isinstance(pi_id, str) and pi_id else None


async def _topup_history_items(pool, user_id: int, *, limit: int) -> list[dict[str, Any]]:
    async with user_scoped_tx(pool, user_id) as conn, conn.cursor() as cur:
        await cur.execute(
            """
            SELECT id, grant_cents, granted_at
            FROM pai_credit_grants
            WHERE user_id = %s AND source = 'topup'
            ORDER BY granted_at DESC
            LIMIT %s
            """,
            (user_id, limit),
        )
        rows = await cur.fetchall()
    return [
        {
            "id": str(row["id"]),
            "kind": "topup",
            "status": "paid",
            "amountPaidCents": int(row["grant_cents"]),
            "currency": "usd",
            "description": "PIN AI credits",
            "createdAt": int(row["granted_at"].timestamp()),
            "hostedInvoiceUrl": None,
            "pdfUrl": None,
        }
        for row in rows
    ]


def _resolve_price_id_from_subscription(stripe_sub: Any) -> str | None:
    """Return the price id of the subscription's first line item.
    Returns None when the subscription has no items (data anomaly).
    Caller resolves price id → plan_code via plans_repo."""
    items_obj = stripe_attr(stripe_sub, "items")
    if items_obj is None:
        return None
    data = stripe_attr(items_obj, "data")
    if not data:
        return None
    first = data[0]
    price = stripe_attr(first, "price")
    if price is None:
        return None
    return stripe_attr(price, "id")


async def reconcile_subscription_from_stripe(
    pool,
    *,
    user: User,
) -> dict[str, Any]:
    """Pull canonical subscription state from Stripe and upsert into
    pai_subscriptions. Used when Stripe webhook hasn't (yet) reached
    our backend — typical in local dev without Stripe CLI forwarding
    or right after the user returns from Stripe Checkout.

    Returns a small summary; UI should follow up with getCurrentSubscription
    for the canonical local view."""
    stripe = requires_stripe()

    customer_id = await _get_user_stripe_customer_id(pool, user.id)
    if not customer_id:
        # User never started Checkout — just make sure they're on Free.
        async with service_tx(pool) as conn:
            await ensure_user_free_subscription(conn, user.id)
            await sync_litellm_budget_for_plan(conn, user.id, "free", reset_spend=False)
        return {"synced": True, "planCode": "free", "reason": "no_stripe_customer"}

    listing = stripe.Subscription.list(
        customer=customer_id,
        status="all",
        limit=10,
    )
    candidates = [
        s
        for s in (listing.data or [])
        if getattr(s, "status", "") in {"trialing", "active", "past_due"}
    ]
    if not candidates:
        # No active Stripe sub for this customer — fall back to Free.
        async with service_tx(pool) as conn:
            await ensure_user_free_subscription(conn, user.id)
            await sync_litellm_budget_for_plan(conn, user.id, "free", reset_spend=False)
        return {"synced": True, "planCode": "free", "reason": "fallback_to_free"}

    # "Actually renewing" = active and NOT scheduled to cancel. A sub
    # in active + cancel_at_period_end=True will wind down on its own,
    # not a duplicate to warn about.
    actively_renewing = [s for s in candidates if not getattr(s, "cancel_at_period_end", False)]

    # Pick the most recent (highest created timestamp). Multiple active
    # subscriptions on one customer is a data anomaly we shouldn't enable,
    # but tolerate here so reconcile picks the latest intent.
    candidates.sort(key=lambda s: getattr(s, "created", 0) or 0, reverse=True)
    canonical = candidates[0]

    price_id = _resolve_price_id_from_subscription(canonical)
    plan_code: str | None = None
    if price_id:
        async with user_scoped_tx(pool, user.id) as conn:
            plan = await plans_repo.find_by_stripe_price(conn, price_id)
            plan_code = plan.plan_code if plan else None

    async with service_tx(pool) as conn:
        # Read existing state so we can detect "first subscribe": user was
        # on free (or no row) and Stripe now shows an active paid sub.
        # In production invoice.paid webhook is the canonical promotion
        # path, but in local dev (no webhook forwarding) or during the
        # brief window before invoice.paid lands, the DB would otherwise
        # stay on free while Stripe already says paid. This is the ONLY
        # case where reconcile is allowed to overwrite plan_code +
        # touch LiteLLM — switches between paid plans (the "pending"
        # case) still require invoice.paid because items[0].price on
        # Stripe may be scheduled-for-next-cycle, not current.
        old_sub = await subs_repo.get_for_user(conn, user.id)
        old_plan_code = old_sub.plan_code if old_sub else None
        canonical_status = getattr(canonical, "status", "")
        is_first_subscribe = (
            old_plan_code in (None, "free")
            and canonical_status in ("trialing", "active")
            and plan_code is not None
            and plan_code != "free"
        )

        await subs_repo.sync_from_stripe_subscription(
            conn,
            user_id=user.id,
            plan_code=plan_code,
            stripe_subscription=canonical,
            update_plan_code=is_first_subscribe,
        )

        if is_first_subscribe:
            # New paid subscription is now active — bring LiteLLM into
            # line with the plan cap + zero the spend window. Idempotent
            # if the invoice.paid webhook fires later: webhook re-syncs
            # the same plan/budget pair, no drift.
            assert plan_code is not None  # implied by is_first_subscribe
            await sync_litellm_budget_for_plan(
                conn,
                user.id,
                plan_code,
                reset_spend=True,
            )

    return {
        "synced": True,
        "subscriptionId": canonical.id,
        "status": canonical.status,
        "planCode": plan_code,
        "totalActive": len(candidates),
        # only count subs that will keep billing — the UI uses this to
        # decide whether to surface the "duplicate subscriptions" warning
        "activelyRenewing": len(actively_renewing),
    }


async def list_payment_methods_for_user(
    pool,
    *,
    user: User,
    limit: int = 10,
) -> dict[str, Any]:
    """Return the user's Stripe-managed cards.

    Cards live in 3 possible places depending on how they got there:
      1. customer.invoice_settings.default_payment_method — set when
         the user explicitly sets a default in Customer Portal
      2. subscription.default_payment_method — Stripe Checkout in
         subscription+trial mode attaches the card here, NOT to the
         customer (this is the common case we kept missing)
      3. payment_methods.list(customer=...) — attached cards, the
         "normal" location

    We walk all three, dedupe by pm.id, mark whichever is the customer
    default (if any) with isDefault=True. Real data — no mocking.
    """
    stripe = requires_stripe()
    customer_id = await _get_user_stripe_customer_id(pool, user.id)
    if not customer_id:
        return {"items": []}

    seen: set[str] = set()
    ordered_pm_ids: list[str] = []
    default_pm_id: str | None = None

    # (1) Customer.invoice_settings.default_payment_method
    try:
        customer = stripe.Customer.retrieve(customer_id)
        dpm = stripe_attr(stripe_attr(customer, "invoice_settings"), "default_payment_method")
        if isinstance(dpm, str) and dpm:
            default_pm_id = dpm
        elif dpm is not None:
            default_pm_id = stripe_attr(dpm, "id")
    except Exception as e:
        logger.warning("retrieving customer for default PM failed: %s", e)

    if default_pm_id and default_pm_id not in seen:
        seen.add(default_pm_id)
        ordered_pm_ids.append(default_pm_id)

    # (2) subscription.default_payment_method — Checkout(trial) lands here
    try:
        sub_listing = stripe.Subscription.list(customer=customer_id, status="all", limit=10)
        for sub in sub_listing.data or []:
            spm = stripe_attr(sub, "default_payment_method")
            spm_id = spm if isinstance(spm, str) else stripe_attr(spm, "id")
            if isinstance(spm_id, str) and spm_id and spm_id not in seen:
                seen.add(spm_id)
                ordered_pm_ids.append(spm_id)
    except Exception as e:
        logger.warning("walking subscriptions for default PM failed: %s", e)

    # (3) PaymentMethods attached to the customer (the standard location)
    try:
        attached = stripe.Customer.list_payment_methods(
            customer_id,
            type="card",
            limit=limit,
        )
        for pm in attached.data or []:
            pm_id = pm.id if hasattr(pm, "id") else stripe_attr(pm, "id")
            if pm_id and pm_id not in seen:
                seen.add(pm_id)
                ordered_pm_ids.append(pm_id)
    except Exception as e:
        logger.warning("Customer.list_payment_methods failed: %s", e)

    # Retrieve each PM to get type-specific display fields. Stripe supports
    # many PM types (card / link / us_bank_account / apple_pay / ...);
    # frontend renders different chips based on `type`.
    # Dedup logic: same underlying instrument across multiple Stripe
    # PaymentMethod objects gets one entry. Identity key per type:
    #   card  → (brand, last4)         — same card = same number
    #   link  → linkEmail              — one Link account per email
    #   other → pm.id                  — no dedup, treat each as unique
    items: list[dict[str, Any]] = []
    seen_identity: set[tuple[str, ...]] = set()
    for pm_id in ordered_pm_ids[: limit * 2]:
        try:
            pm = stripe.PaymentMethod.retrieve(pm_id)
            pm_type = stripe_attr(pm, "type") or "unknown"
            entry = _payment_method_entry(
                pm_id=pm_id,
                pm_type=pm_type,
                is_default=pm_id == default_pm_id,
                is_saved=True,
                source="saved",
            )
            identity: tuple[str, ...]
            if pm_type == "card":
                card = stripe_attr(pm, "card")
                entry["brand"] = stripe_attr(card, "brand")
                entry["last4"] = stripe_attr(card, "last4")
                entry["expMonth"] = stripe_attr(card, "exp_month")
                entry["expYear"] = stripe_attr(card, "exp_year")
                identity = ("card", entry["brand"] or "", entry["last4"] or "")
            elif pm_type == "link":
                link = stripe_attr(pm, "link")
                entry["linkEmail"] = stripe_attr(link, "email")
                identity = ("link", entry["linkEmail"] or "")
            else:
                identity = ("other", pm_id)
            if identity in seen_identity:
                continue
            seen_identity.add(identity)
            items.append(entry)
            if len(items) >= limit:
                break
        except Exception as e:
            logger.warning("PaymentMethod.retrieve %s failed: %s", pm_id, e)

    # If no explicit customer default but exactly one PM survived dedup,
    # mark it default — that's the user's effective default in practice
    # (Stripe applied it to their subscription).
    if not default_pm_id and len(items) == 1:
        items[0]["isDefault"] = True

    if not items:
        pi_id = await _latest_topup_payment_intent_id(pool, user.id)
        if pi_id:
            try:
                payment_intent = stripe.PaymentIntent.retrieve(pi_id, expand=["latest_charge"])
                charge = stripe_attr(payment_intent, "latest_charge")
                if isinstance(charge, str) and hasattr(stripe, "Charge"):
                    charge = stripe.Charge.retrieve(charge)
                user_email = getattr(user, "email", None)
                checkout_entry = _entry_from_checkout_charge(
                    charge,
                    is_default=True,
                    fallback_email=user_email
                    if isinstance(user_email, str) and user_email
                    else None,
                )
                if checkout_entry is not None:
                    items.append(checkout_entry)
            except Exception as e:
                logger.warning("PaymentIntent.retrieve %s for checkout PM failed: %s", pi_id, e)

    return {"items": items}


async def list_invoices_for_user(
    pool,
    *,
    user: User,
    limit: int = 12,
) -> dict[str, Any]:
    """Return the user's Stripe invoices (real history). Each entry
    includes the hosted_invoice_url so the UI can link out for the
    full receipt + PDF download."""
    stripe = requires_stripe()
    customer_id = await _get_user_stripe_customer_id(pool, user.id)
    if not customer_id:
        return {"items": []}

    listing = stripe.Invoice.list(customer=customer_id, limit=limit)
    items: list[dict[str, Any]] = []
    for inv in listing.data or []:
        lines_obj = getattr(inv, "lines", None)
        lines = getattr(lines_obj, "data", None) if lines_obj is not None else None
        first_desc: str | None = None
        if lines:
            first = lines[0]
            first_desc = (
                getattr(first, "description", None)
                if hasattr(first, "description")
                else first.get("description")
            )
        description = first_desc or getattr(inv, "description", None) or "Subscription"
        items.append(
            {
                "id": inv.id,
                "number": getattr(inv, "number", None),
                "status": inv.status,
                "amountPaidCents": getattr(inv, "amount_paid", 0),
                "amountDueCents": getattr(inv, "amount_due", 0),
                "currency": inv.currency,
                "description": description,
                "createdAt": getattr(inv, "created", 0),
                "hostedInvoiceUrl": getattr(inv, "hosted_invoice_url", None),
                "pdfUrl": getattr(inv, "invoice_pdf", None),
            }
        )
    return {"items": items}


async def list_payment_history_for_user(
    pool,
    *,
    user: User,
    limit: int = 12,
) -> dict[str, Any]:
    """Return UI billing history across Stripe invoices and credit top-ups."""
    invoice_items = []
    try:
        invoice_items = (await list_invoices_for_user(pool, user=user, limit=limit)).get(
            "items", []
        )
    except Exception as e:
        logger.warning("list invoices for payment history failed: %s", e)
    for item in invoice_items:
        item["kind"] = "invoice"

    topup_items = await _topup_history_items(pool, user.id, limit=limit)
    items = sorted(
        [*invoice_items, *topup_items],
        key=lambda item: int(item.get("createdAt") or 0),
        reverse=True,
    )[:limit]
    return {"items": items}
