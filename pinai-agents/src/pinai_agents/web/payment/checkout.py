"""Stripe Checkout / Subscription modification — create / upgrade / downgrade
/ cancel / customer-portal decision logic.

Branch table (called from routes.py /create-checkout):

  existing sub status      | target plan      | action
  -------------------------+------------------+--------------------------------
  none                     | any              | Checkout Session w/ trial
  modifiable, same plan    | any              | 400 already-on-this-plan
  modifiable, target > cur | upgrade          | Subscription.modify(
                           |                  |   proration=always_invoice)
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
from typing import Any

from fastapi import HTTPException

from ...config import get_web_settings
from ..auth.deps import User
from ..db.rls import service_tx, user_scoped_tx
from . import plans as plans_repo
from . import subscriptions as subs_repo
from .stripe_client import requires_stripe

logger = logging.getLogger(__name__)


# Statuses where we still talk to Stripe to modify the existing sub.
# past_due included — Stripe still allows modify; LiteLLM budget won't
# reset until invoice.paid clears.
_MODIFIABLE_STATUSES = frozenset({"trialing", "active", "past_due"})


# ── customer / item helpers ──


async def _get_user_stripe_customer_id(pool, user_id: int) -> str | None:
    """Read users.stripe_customer_id. Returns None if the user has never
    started a checkout."""
    from ..db.rls import user_scoped_tx as _scoped
    async with _scoped(pool, user_id) as conn, conn.cursor() as cur:
        await cur.execute(
            "SELECT stripe_customer_id FROM users WHERE id = %s", (user_id,),
        )
        row = await cur.fetchone()
    return (row or {}).get("stripe_customer_id")


async def _free_tier_budget_usd(conn) -> float:
    """Read Free plan's monthly budget from pai_billing_plans (SSOT).
    Falls back to $5 if 'free' row missing for some reason."""
    plan = await plans_repo.find_by_code(conn, "free")
    if plan is None:
        return 5.0
    return plan.monthly_refresh_credits / 100.0


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


async def sync_litellm_budget_for_plan(
    conn, user_id: int, plan_code: str, *, reset_spend: bool = True,
) -> None:
    """Update the user's LiteLLM key max_budget to match their plan.
    Looks up plan.monthly_refresh_credits / 100 for the USD amount.
    Silent no-op when the user has no LiteLLM key yet (will be set on
    next ensure_user_litellm_key call)."""
    from ..litellm import client as litellm_client
    plan = await plans_repo.find_by_code(conn, plan_code)
    if plan is None:
        logger.warning("sync_litellm_budget: unknown plan_code=%s user=%d", plan_code, user_id)
        return
    virtual_key = await _virtual_key_for_user(conn, user_id)
    if not virtual_key:
        return
    budget_usd = plan.monthly_refresh_credits / 100.0
    try:
        await litellm_client.update_key(
            virtual_key=virtual_key,
            max_budget_usd=budget_usd,
            budget_duration="30d",
            reset_spend=reset_spend,
        )
        logger.info(
            "litellm budget set: user=%d plan=%s max_budget=$%.2f",
            user_id, plan_code, budget_usd,
        )
    except litellm_client.LiteLLMError as e:
        logger.exception(
            "litellm /key/update failed user=%d plan=%s: %s",
            user_id, plan_code, e,
        )


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
            conn, user_id=user.id, stripe_customer_id=customer.id,
        )
    return customer.id


def get_subscription_item_id(stripe_subscription_id: str) -> str:
    """Look up the (singleton) subscription_item id for a Stripe Subscription.
    We only ever attach one line item per subscription, so items.data[0].id
    is the canonical answer."""
    stripe = requires_stripe()
    sub = stripe.Subscription.retrieve(stripe_subscription_id)
    items = sub.items
    data = items.data if hasattr(items, "data") else items["data"]
    if not data:
        msg = f"subscription {stripe_subscription_id} has no items"
        raise RuntimeError(msg)
    first = data[0]
    return first.id if hasattr(first, "id") else first["id"]


# ── main flow ──


async def create_or_change_subscription(
    pool, *, user: User, plan_code: str,
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
        success = success_url_override or (
            f"{base}/payment/success" if base else None
        )
        cancel = cancel_url_override or (
            f"{base}/payment/cancel" if base else None
        )
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
            success_url=success + "?session_id={CHECKOUT_SESSION_ID}",
            cancel_url=cancel,
            allow_promotion_codes=True,
            metadata=sub_metadata,
            subscription_data={
                "trial_period_days": target_plan.trial_period_days or None,
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

    item_id = get_subscription_item_id(existing_sub.stripe_subscription_id)
    is_upgrade = (
        target_plan.price_cents_monthly > current_plan.price_cents_monthly
    )
    mod_metadata = {
        "supabase_user_id": user.supabase_user_id,
        "plan_code": target_plan.plan_code,
    }

    if is_upgrade:
        # UPGRADE: prorate + invoice immediately (always_invoice). The
        # invoice.paid webhook will then fire and refresh LiteLLM budget
        # to the new ceiling.
        stripe.Subscription.modify(
            existing_sub.stripe_subscription_id,
            items=[{"id": item_id, "price": target_plan.stripe_price_id}],
            proration_behavior="always_invoice",
            metadata=mod_metadata,
        )
        return {"checkoutUrl": None, "flow": "upgrade"}

    # DOWNGRADE: no proration, no anchor shift — user keeps the higher
    # budget through current period end, then Stripe rolls them to the
    # cheaper plan at next renewal.
    stripe.Subscription.modify(
        existing_sub.stripe_subscription_id,
        items=[{"id": item_id, "price": target_plan.stripe_price_id}],
        proration_behavior="none",
        billing_cycle_anchor="unchanged",
        metadata=mod_metadata,
    )
    return {"checkoutUrl": None, "flow": "downgrade"}


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
            400, f"subscription is {sub.status}, cannot cancel",
        )
    if sub.cancel_at_period_end:
        # Already scheduled to cancel — idempotent.
        return {
            "ok": True,
            "alreadyScheduled": True,
            "currentPeriodEnd": (
                sub.current_period_end.isoformat()
                if sub.current_period_end else None
            ),
        }
    stripe.Subscription.modify(
        sub.stripe_subscription_id, cancel_at_period_end=True,
    )
    return {
        "ok": True,
        "currentPeriodEnd": (
            sub.current_period_end.isoformat()
            if sub.current_period_end else None
        ),
    }


async def create_customer_portal_session(
    pool, *, user: User, return_url_override: str | None = None,
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
            400, "no Stripe customer; complete checkout first",
        )
    base = settings.payment_public_base_url or ""
    return_url = return_url_override or (f"{base}/account" if base else None)
    if not return_url:
        raise HTTPException(500, "PAYMENT_PUBLIC_BASE_URL not configured")
    portal = stripe.billing_portal.Session.create(
        customer=customer_id, return_url=return_url,
    )
    return {"portalUrl": portal.url}


# ── reconcile + read-from-Stripe helpers ──

# Statuses we consider "real" enough to sync to pai_subscriptions.
_STRIPE_LIVE_STATUSES = frozenset(
    {"trialing", "active", "past_due", "canceled"},
)


def _stripe_attr(obj: Any, name: str) -> Any:
    """Read a field from a Stripe SDK object.

    Python Stripe SDK's StripeObject subclasses dict — that means certain
    field names collide with dict's own methods ('items', 'keys', 'values',
    'pop', ...). For those, attribute access returns the dict method, not
    the field. Always use bracket / .get access for fields that might
    collide. Safe fallback: try .get first, then attribute access."""
    if obj is None:
        return None
    if hasattr(obj, "get") and callable(obj.get):
        v = obj.get(name)
        if v is not None:
            return v
    return getattr(obj, name, None)


def _resolve_price_id_from_subscription(stripe_sub: Any) -> str | None:
    """Return the price id of the subscription's first line item.
    Returns None when the subscription has no items (data anomaly).
    Caller resolves price id → plan_code via plans_repo."""
    items_obj = _stripe_attr(stripe_sub, "items")
    if items_obj is None:
        return None
    data = _stripe_attr(items_obj, "data")
    if not data:
        return None
    first = data[0]
    price = _stripe_attr(first, "price")
    if price is None:
        return None
    return _stripe_attr(price, "id")


async def reconcile_subscription_from_stripe(
    pool, *, user: User,
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
        customer=customer_id, status="all", limit=10,
    )
    candidates = [
        s for s in (listing.data or [])
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
    actively_renewing = [
        s for s in candidates
        if not getattr(s, "cancel_at_period_end", False)
    ]

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
        await subs_repo.sync_from_stripe_subscription(
            conn, user_id=user.id, plan_code=plan_code,
            stripe_subscription=canonical,
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
    pool, *, user: User, limit: int = 10,
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
        dpm = _stripe_attr(_stripe_attr(customer, "invoice_settings"), "default_payment_method")
        if isinstance(dpm, str) and dpm:
            default_pm_id = dpm
        elif dpm is not None:
            default_pm_id = _stripe_attr(dpm, "id")
    except Exception as e:
        logger.warning("retrieving customer for default PM failed: %s", e)

    if default_pm_id and default_pm_id not in seen:
        seen.add(default_pm_id)
        ordered_pm_ids.append(default_pm_id)

    # (2) subscription.default_payment_method — Checkout(trial) lands here
    try:
        sub_listing = stripe.Subscription.list(customer=customer_id, status="all", limit=10)
        for sub in (sub_listing.data or []):
            spm = _stripe_attr(sub, "default_payment_method")
            spm_id = spm if isinstance(spm, str) else _stripe_attr(spm, "id")
            if isinstance(spm_id, str) and spm_id and spm_id not in seen:
                seen.add(spm_id)
                ordered_pm_ids.append(spm_id)
    except Exception as e:
        logger.warning("walking subscriptions for default PM failed: %s", e)

    # (3) PaymentMethods attached to the customer (the standard location)
    try:
        attached = stripe.Customer.list_payment_methods(
            customer_id, type="card", limit=limit,
        )
        for pm in (attached.data or []):
            pm_id = pm.id if hasattr(pm, "id") else _stripe_attr(pm, "id")
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
    for pm_id in ordered_pm_ids[:limit * 2]:
        try:
            pm = stripe.PaymentMethod.retrieve(pm_id)
            pm_type = _stripe_attr(pm, "type") or "unknown"
            entry: dict[str, Any] = {
                "id": pm_id,
                "type": pm_type,
                "isDefault": pm_id == default_pm_id,
                "brand": None, "last4": None, "expMonth": None, "expYear": None,
                "linkEmail": None,
            }
            identity: tuple[str, ...]
            if pm_type == "card":
                card = _stripe_attr(pm, "card")
                entry["brand"] = _stripe_attr(card, "brand")
                entry["last4"] = _stripe_attr(card, "last4")
                entry["expMonth"] = _stripe_attr(card, "exp_month")
                entry["expYear"] = _stripe_attr(card, "exp_year")
                identity = ("card", entry["brand"] or "", entry["last4"] or "")
            elif pm_type == "link":
                link = _stripe_attr(pm, "link")
                entry["linkEmail"] = _stripe_attr(link, "email")
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

    return {"items": items}


async def list_invoices_for_user(
    pool, *, user: User, limit: int = 12,
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
    for inv in (listing.data or []):
        lines_obj = getattr(inv, "lines", None)
        lines = getattr(lines_obj, "data", None) if lines_obj is not None else None
        first_desc: str | None = None
        if lines:
            first = lines[0]
            first_desc = (
                getattr(first, "description", None) if hasattr(first, "description")
                else first.get("description")
            )
        description = first_desc or getattr(inv, "description", None) or "Subscription"
        items.append({
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
        })
    return {"items": items}
