"""/api/payment/* — public-ish plan listing, authed checkout creation,
authed subscription read, and the public webhook endpoint.

Auth surface:
  * GET  /plans                        — public (anyone can list pricing).
  * GET  /subscription                 — Supabase JWT (current_user).
  * POST /create-checkout              — Supabase JWT.
  * POST /webhook                      — no auth; verifies Stripe-Signature
                                          header instead. PUBLIC-FACING.

The webhook endpoint must accept raw bytes (not parsed JSON) — Stripe
signs the exact bytes of the request body. FastAPI's Request.body() gives
us the bytes; we hand them to Stripe.Webhook.construct_event verbatim.
"""

from __future__ import annotations

import logging
import re
from datetime import datetime, timedelta

import httpx
from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from pinai_db.rls import service_tx, user_scoped_tx
from pydantic import BaseModel, Field

from ....platform.auth.deps import User, current_user, get_pool
from ....platform.litellm import client as litellm_client
from . import budget_periods as periods_repo
from . import checkout as checkout_flow
from . import credit_grants as grants_repo
from . import plans as plans_repo
from . import subscriptions as subs_repo
from . import webhook as webhook_handler

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/payment", tags=["payment"])


# ── /plans ──


@router.get("/plans")
async def list_plans(pool=Depends(get_pool)) -> dict:
    """Public — front-end pricing page calls this. No auth.

    Plans are catalog data, not user-specific; we run as service_role
    to skip RLS (table is read-public anyway, but explicit is clearer)."""
    async with service_tx(pool) as conn:
        items = await plans_repo.list_active(conn)
    return {"items": [p.to_public_dict() for p in items]}


# ── /subscription ──


@router.get("/subscription")
async def my_subscription(
    user: User = Depends(current_user),
    pool=Depends(get_pool),
) -> dict:
    async with user_scoped_tx(pool, user.id) as conn:
        sub = await subs_repo.get_for_user(conn, user.id)
    if sub is None:
        return {
            "status": "inactive",
            "planCode": None,
            "pendingPlanCode": None,
            "accessGranted": False,
            "currentPeriodEnd": None,
            "cancelAtPeriodEnd": False,
        }
    return {
        "status": sub.status,
        "planCode": sub.plan_code,
        "pendingPlanCode": sub.pending_plan_code,
        "accessGranted": sub.is_access_granted(),
        "currentPeriodStart": (
            sub.current_period_start.isoformat() if sub.current_period_start else None
        ),
        "currentPeriodEnd": (
            sub.current_period_end.isoformat() if sub.current_period_end else None
        ),
        "cancelAtPeriodEnd": sub.cancel_at_period_end,
    }


# ── /create-checkout ──


class CreateCheckoutRequest(BaseModel):
    planCode: str = Field(min_length=1)
    # Optional override for the post-checkout redirect URLs. If unset,
    # we use payment_public_base_url + /payment/{success,cancel}.
    successUrl: str | None = None
    cancelUrl: str | None = None


@router.post("/create-checkout")
async def create_checkout(
    body: CreateCheckoutRequest,
    user: User = Depends(current_user),
    pool=Depends(get_pool),
) -> dict:
    """Create a Stripe Checkout Session OR modify an existing subscription
    in place (upgrade / downgrade), depending on the user's current state.

    See checkout.create_or_change_subscription for the branch table.
    Response:
      - {"checkoutUrl": str, "sessionId": str, "flow": "new"} → redirect.
      - {"checkoutUrl": null, "flow": "upgrade"|"downgrade"}  → frontend
        can show success without redirect.
    """
    return await checkout_flow.create_or_change_subscription(
        pool,
        user=user,
        plan_code=body.planCode,
        success_url_override=body.successUrl,
        cancel_url_override=body.cancelUrl,
    )


# ── /topup ──


class TopupRequest(BaseModel):
    amountCents: int = Field(ge=1)
    successUrl: str | None = None
    cancelUrl: str | None = None


@router.post("/topup")
async def topup(
    body: TopupRequest,
    user: User = Depends(current_user),
    pool=Depends(get_pool),
) -> dict:
    """Buy a one-off credit topup. Returns a Stripe Checkout (mode='payment')
    URL; the grant lands via the checkout.session.completed webhook. Amount
    is in integer cents (1 credit = $0.01, bought 1:1)."""
    return await checkout_flow.create_topup_checkout(
        pool,
        user=user,
        amount_cents=body.amountCents,
        success_url_override=body.successUrl,
        cancel_url_override=body.cancelUrl,
    )


# ── /cancel ──


@router.post("/cancel")
async def cancel_subscription(
    user: User = Depends(current_user),
    pool=Depends(get_pool),
) -> dict:
    """Schedule cancellation at end of current period (soft cancel).

    User keeps access until current_period_end; Stripe then transitions
    to status=canceled and fires customer.subscription.deleted which
    zeros the LiteLLM budget. No refund (matches PIN Claw policy)."""
    return await checkout_flow.cancel_subscription(pool, user=user)


# ── /customer-portal ──


class CustomerPortalRequest(BaseModel):
    returnUrl: str | None = None


@router.post("/customer-portal")
async def customer_portal(
    body: CustomerPortalRequest | None = None,
    user: User = Depends(current_user),
    pool=Depends(get_pool),
) -> dict:
    """Mint a Stripe Customer Portal URL the frontend redirects to.

    The portal handles: billing history, card update, cancel UI, invoice
    download. We deliberately don't self-implement any of that surface."""
    return await checkout_flow.create_customer_portal_session(
        pool,
        user=user,
        return_url_override=(body.returnUrl if body else None),
    )


# ── /reconcile ──


@router.post("/reconcile")
async def reconcile(
    user: User = Depends(current_user),
    pool=Depends(get_pool),
) -> dict:
    """Pull the user's current subscription state from Stripe and sync
    into pai_subscriptions. Used by the frontend on mount + after returning
    from Stripe Checkout — in local dev we don't have Stripe webhook
    forwarding so this is the synchronization path."""
    return await checkout_flow.reconcile_subscription_from_stripe(pool, user=user)


# ── /payment-methods ──


@router.get("/payment-methods")
async def payment_methods(
    user: User = Depends(current_user),
    pool=Depends(get_pool),
) -> dict:
    """List the user's Stripe-managed cards (real data; no mocks).
    Returns empty when the user hasn't started checkout yet."""
    return await checkout_flow.list_payment_methods_for_user(pool, user=user)


# ── /invoices ──


@router.get("/invoices")
async def invoices(
    user: User = Depends(current_user),
    pool=Depends(get_pool),
    limit: int = 12,
) -> dict:
    """List the user's invoices from Stripe (real billing history).
    Includes hosted_invoice_url for the UI to link out to each receipt."""
    return await checkout_flow.list_invoices_for_user(pool, user=user, limit=limit)


# ── /history ──


@router.get("/history")
async def payment_history(
    user: User = Depends(current_user),
    pool=Depends(get_pool),
    limit: int = 12,
) -> dict:
    """List the user's payment history across Stripe invoices and top-ups."""
    return await checkout_flow.list_payment_history_for_user(pool, user=user, limit=limit)


# ── /usage ──

_DURATION_RE = re.compile(r"(\d+)\s*(mo|[smhdw])")
_DURATION_UNIT = {
    "s": "seconds",
    "m": "minutes",
    "h": "hours",
    "d": "days",
    "w": "weeks",
}


def _parse_budget_duration(value: object) -> timedelta | None:
    """Parse a LiteLLM budget_duration like '30d' / '24h' / '1mo' into a
    timedelta. Returns None if the shape is unrecognized."""
    if not isinstance(value, str):
        return None
    m = _DURATION_RE.fullmatch(value.strip())
    if not m:
        return None
    n = int(m.group(1))
    unit = m.group(2)
    if unit == "mo":
        return timedelta(days=30 * n)
    return timedelta(**{_DURATION_UNIT[unit]: n})


def _parse_dt(value: object) -> datetime | None:
    if isinstance(value, datetime):
        return value
    if isinstance(value, str) and value:
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
    return None


def _current_period_start(info: dict) -> datetime | None:
    """Start of the LiteLLM key's current budget window, derived as
    budget_reset_at - budget_duration. Used to sum provider usage over the
    SAME period the LiteLLM spend covers. None if the window can't be
    derived (caller then sums all-time)."""
    reset = _parse_dt(info.get("budget_reset_at"))
    dur = _parse_budget_duration(info.get("budget_duration"))
    if reset and dur:
        return reset - dur
    return None


@router.get("/usage")
async def usage(
    user: User = Depends(current_user),
    pool=Depends(get_pool),
) -> dict:
    """Return the user's total spend / max_budget / reset time.

    The UI uses this to render a budget progress bar in the Subscription
    page. spendUsd is the user's UNIFIED consumption: LiteLLM token spend
    (from /key/info) PLUS non-LiteLLM provider spend (e.g. ByteDance
    streaming ASR, tracked in pai_provider_usage_events), summed over the
    same budget period."""
    async with user_scoped_tx(pool, user.id) as conn:
        key = await checkout_flow._virtual_key_for_user(conn, user.id)
        period = await periods_repo.get_open_period(conn, user.id)
        topup_credits_available = await grants_repo.sum_active_remaining_cents(conn, user.id)
    plan_allowance_credits = period.allowance_cents if period else 0
    if not key:
        return {
            "spendUsd": 0.0,
            "maxBudgetUsd": 0.0,
            "planAllowanceCredits": plan_allowance_credits,
            "topupCreditsAvailable": topup_credits_available,
            "budgetResetAt": None,
            "budgetDuration": None,
        }
    try:
        info = await litellm_client.get_key_info(key)
    except (litellm_client.LiteLLMError, httpx.HTTPError) as exc:
        logger.warning("payment usage: LiteLLM key info unavailable user=%d: %s", user.id, exc)
        info = {}
    spend = info.get("spend")
    if not isinstance(spend, (int, float)):
        spend = 0.0
    fallback_max_budget_cents = 0
    if period:
        fallback_max_budget_cents = (
            period.max_budget_cents_at_open
            if period.max_budget_cents_at_open is not None
            else max(0, period.allowance_cents - period.allowance_consumed_cents)
            + topup_credits_available
        )
    max_budget = info.get("max_budget")
    if not isinstance(max_budget, (int, float)):
        max_budget = fallback_max_budget_cents / 100.0
    if not period:
        plan_allowance_credits = max(
            0,
            round(float(max_budget) * 100) - topup_credits_available,
        )

    # Fold in non-LiteLLM provider spend so the total reflects ALL of the
    # user's consumption, aligned to the DB budget window.
    period_start = period.period_start if period else _current_period_start(info)
    from ..repository import ProviderUsageRepository

    async with user_scoped_tx(pool, user.id) as conn:
        provider_cost = await ProviderUsageRepository(user.id, conn).sum_cost_usd(
            since=period_start
        )

    return {
        "spendUsd": float(spend) + float(provider_cost),
        "maxBudgetUsd": float(max_budget),
        "planAllowanceCredits": plan_allowance_credits,
        "topupCreditsAvailable": topup_credits_available,
        "budgetResetAt": period.period_end.isoformat() if period else info.get("budget_reset_at"),
        "budgetDuration": (
            checkout_flow._budget_duration_for_period_window(period)
            if period
            else info.get("budget_duration")
        ),
    }


# ── /webhook ──


@router.post("/webhook", status_code=status.HTTP_200_OK)
async def webhook(
    request: Request,
    pool=Depends(get_pool),
    stripe_signature: str | None = Header(None, alias="Stripe-Signature"),
) -> dict:
    """Stripe webhook target. Verifies signature, claims, dispatches.

    Returns 200 immediately on dup events (Stripe retries are normal).
    Returns 4xx on signature failure. Returns 500 only on unexpected
    handler errors — Stripe will retry automatically with backoff.
    """
    if not stripe_signature:
        raise HTTPException(400, "missing Stripe-Signature header")
    body_bytes = await request.body()
    try:
        event = webhook_handler.construct_event(body_bytes, stripe_signature)
    except webhook_handler.WebhookSignatureError as e:
        logger.warning("stripe webhook: signature verify failed: %s", e)
        raise HTTPException(400, "invalid signature") from e

    # Claim in its OWN committed transaction first. If claim + dispatch shared
    # one tx, a dispatch failure (re-raised below) would roll back the claim
    # row too — losing the 'failed' audit marker. With the claim committed,
    # mark_failed records on the persisted row and the next Stripe retry
    # re-claims it (claim_event re-claims 'failed' rows).
    async with service_tx(pool) as conn:
        claimed = await webhook_handler.claim_event(conn, event)
    if not claimed:
        logger.info("stripe webhook: skipped already-processed event=%s", event.id)
        return {"received": True, "skipped": True}

    # Dispatch in a second transaction so its DB writes are atomic per attempt.
    try:
        async with service_tx(pool) as conn:
            handled = await webhook_handler.dispatch(conn, event)
            await webhook_handler.mark_processed(conn, event.id, skipped=not handled)
        return {"received": True, "skipped": not handled}
    except Exception as e:
        async with service_tx(pool) as conn:
            await webhook_handler.mark_failed(conn, event.id, str(e))
        logger.exception("stripe webhook handler failed event=%s", event.id)
        # Re-raise so Stripe gets a 5xx and retries (re-claims the 'failed' row).
        raise HTTPException(500, "webhook handler error") from e
