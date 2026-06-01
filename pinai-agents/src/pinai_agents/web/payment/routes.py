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

from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from pydantic import BaseModel, Field

from ..auth.deps import User, current_user, get_pool
from ..db.rls import service_tx, user_scoped_tx
from . import checkout as checkout_flow
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


# ── /usage ──


@router.get("/usage")
async def usage(
    user: User = Depends(current_user),
    pool=Depends(get_pool),
) -> dict:
    """Return the user's LiteLLM spend / max_budget / reset time.

    The UI uses this to render a budget progress bar in the Subscription
    page. Real data — comes straight from LiteLLM via /key/info."""
    from ..litellm import client as litellm_client

    async with user_scoped_tx(pool, user.id) as conn:
        key = await checkout_flow._virtual_key_for_user(conn, user.id)
    if not key:
        return {"spendUsd": 0.0, "maxBudgetUsd": 0.0, "budgetResetAt": None, "budgetDuration": None}
    info = await litellm_client.get_key_info(key)
    spend = info.get("spend")
    if not isinstance(spend, (int, float)):
        spend = 0.0
    max_budget = info.get("max_budget")
    if not isinstance(max_budget, (int, float)):
        max_budget = 0.0
    return {
        "spendUsd": float(spend),
        "maxBudgetUsd": float(max_budget),
        "budgetResetAt": info.get("budget_reset_at"),
        "budgetDuration": info.get("budget_duration"),
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

    async with service_tx(pool) as conn:
        claimed = await webhook_handler.claim_event(conn, event)
        if not claimed:
            logger.info("stripe webhook: skipped already-processed event=%s", event.id)
            return {"received": True, "skipped": True}
        try:
            handled = await webhook_handler.dispatch(conn, event)
            await webhook_handler.mark_processed(conn, event.id, skipped=not handled)
            return {"received": True, "skipped": not handled}
        except Exception as e:
            await webhook_handler.mark_failed(conn, event.id, str(e))
            logger.exception("stripe webhook handler failed event=%s", event.id)
            # Re-raise so Stripe gets a 5xx and retries.
            raise HTTPException(500, "webhook handler error") from e
