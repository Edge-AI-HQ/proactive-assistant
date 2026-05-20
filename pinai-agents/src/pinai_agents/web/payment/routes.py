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

from ...config import get_web_settings
from ..auth.deps import User, current_user, get_pool
from ..db.rls import service_tx, user_scoped_tx
from . import plans as plans_repo
from . import subscriptions as subs_repo
from . import webhook as webhook_handler
from .stripe_client import requires_stripe

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
    user: User = Depends(current_user), pool=Depends(get_pool),
) -> dict:
    async with user_scoped_tx(pool, user.id) as conn:
        sub = await subs_repo.get_for_user(conn, user.id)
    if sub is None:
        return {
            "status": "inactive", "planCode": None, "accessGranted": False,
            "currentPeriodEnd": None, "cancelAtPeriodEnd": False,
        }
    return {
        "status": sub.status,
        "planCode": sub.plan_code,
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
    """Create a Stripe Checkout Session for the user.

    Reuses an existing stripe_customer_id when the user has one (avoids
    duplicate customers in Stripe). New users get a fresh Customer
    created with metadata.user_id pointing back at our row.
    """
    stripe = requires_stripe()
    settings = get_web_settings()

    async with user_scoped_tx(pool, user.id) as conn:
        plan = await plans_repo.find_by_code(conn, body.planCode)
        if plan is None:
            raise HTTPException(400, f"unknown plan: {body.planCode}")
        # Look up existing customer.
        async with conn.cursor() as cur:
            await cur.execute(
                "SELECT stripe_customer_id FROM users WHERE id = %s", (user.id,),
            )
            row = await cur.fetchone()
        existing_customer_id = (row or {}).get("stripe_customer_id")

    customer_id = existing_customer_id
    if not customer_id:
        # Service-tx — new customer creation needs to write users.
        customer = stripe.Customer.create(
            email=user.email or None,
            # supabase_user_id is the primary back-reference (the external
            # namespace per AGENTS.md "用户标识规约"). internal_user_id is
            # included as debug-only context — webhook handlers resolve
            # the user via supabase_user_id.
            metadata={
                "supabase_user_id": user.supabase_user_id,
                "internal_user_id": str(user.id),
            },
        )
        customer_id = customer.id
        async with service_tx(pool) as conn:
            await subs_repo.upsert_user_stripe_customer(
                conn, user_id=user.id, stripe_customer_id=customer_id,
            )

    # Compute redirect URLs.
    base = settings.payment_public_base_url or ""
    success = body.successUrl or (f"{base}/payment/success" if base else None)
    cancel = body.cancelUrl or (f"{base}/payment/cancel" if base else None)
    if not success or not cancel:
        raise HTTPException(
            500,
            "checkout success / cancel URLs not configured "
            "(set PAYMENT_PUBLIC_BASE_URL or pass successUrl/cancelUrl)",
        )

    session = stripe.checkout.Session.create(
        mode="subscription",
        customer=customer_id,
        line_items=[{"price": plan.stripe_price_id, "quantity": 1}],
        success_url=success + "?session_id={CHECKOUT_SESSION_ID}",
        cancel_url=cancel,
        allow_promotion_codes=True,
        metadata={
            "supabase_user_id": user.supabase_user_id,
            "internal_user_id": str(user.id),
            "plan_code": plan.plan_code,
        },
        subscription_data={
            "metadata": {"user_id": str(user.id), "plan_code": plan.plan_code},
        },
    )
    return {"checkoutUrl": session.url, "sessionId": session.id}


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
