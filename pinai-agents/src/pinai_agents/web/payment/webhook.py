"""Stripe webhook event handler.

Lifecycle for one webhook:
  1. Signature verify via stripe.Webhook.construct_event(body, sig, secret).
     Bad signature → 400, no DB touch.
  2. Idempotency claim: INSERT INTO pai_stripe_webhook_events (event_id, ...)
     ON CONFLICT DO NOTHING. If conflict (already claimed), return 200 with
     status=skipped — Stripe retries are normal, must be no-op safe.
  3. Dispatch by event.type. Only the four types we care about are handled;
     everything else marks `skipped` and the row records it for audit.
  4. Mark processed (or failed with error_message) on the row.

Trust note: the webhook runs as service_role (no app.user_id binding), so
RLS service_role fallback policies let us read+write across users. We
authorize-by-event-payload — the event.data.object carries either our
metadata.supabase_user_id or a stripe_customer_id we resolve.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from ..litellm import client as litellm_client
from . import plans, subscriptions
from .stripe_client import requires_stripe, requires_webhook_secret

logger = logging.getLogger(__name__)

# 100 LiteLLM credits == $1 USD spend ceiling. PIN Claw mapping; we keep
# it 1:1 with pai_billing_plans.monthly_refresh_credits.
_CREDITS_PER_USD = 100

# LiteLLM budget window: refreshes monthly on each invoice.paid.
_BUDGET_DURATION = "30d"


class WebhookSignatureError(Exception):
    """Bad / missing Stripe-Signature header."""


def construct_event(body: bytes, signature: str) -> Any:
    """Verify the signature and parse. Raises WebhookSignatureError on
    any failure — caller maps to HTTP 400."""
    stripe = requires_stripe()
    secret = requires_webhook_secret()
    try:
        return stripe.Webhook.construct_event(body, signature, secret)
    except Exception as e:
        raise WebhookSignatureError(str(e)) from e


async def claim_event(conn, event: Any) -> bool:
    """Try to claim the event for processing. Returns True if we got the
    claim (caller proceeds), False if it was already claimed
    (caller short-circuits with status=skipped). Idempotent on retry."""
    user_id = await _resolve_user_id_for_event(conn, event)
    async with conn.cursor() as cur:
        await cur.execute(
            """
            INSERT INTO pai_stripe_webhook_events
              (event_id, event_type, user_id, status, raw_data)
            VALUES (%s, %s, %s, 'claimed', %s::jsonb)
            ON CONFLICT (event_id) DO NOTHING
            RETURNING event_id
            """,
            (event.id, event.type, user_id, json.dumps(_event_to_dict(event))),
        )
        row = await cur.fetchone()
    return row is not None


async def mark_processed(conn, event_id: str, *, skipped: bool = False) -> None:
    new_status = "skipped" if skipped else "processed"
    async with conn.cursor() as cur:
        await cur.execute(
            """
            UPDATE pai_stripe_webhook_events
            SET status = %s, processed_at = NOW()
            WHERE event_id = %s
            """,
            (new_status, event_id),
        )


async def mark_failed(conn, event_id: str, message: str) -> None:
    async with conn.cursor() as cur:
        await cur.execute(
            """
            UPDATE pai_stripe_webhook_events
            SET status = 'failed', error_message = %s, processed_at = NOW()
            WHERE event_id = %s
            """,
            (message[:2000], event_id),
        )


async def dispatch(conn, event: Any) -> bool:
    """Route the event to its handler. Returns True if handled, False if
    skipped (event type we don't care about). Caller marks the
    pai_stripe_webhook_events row accordingly. Raises on handler failure
    so caller can mark_failed + propagate to Stripe (which will retry)."""
    obj = event.data.object if hasattr(event, "data") else event["data"]["object"]
    etype = event.type
    logger.info("stripe webhook: dispatch event_type=%s id=%s", etype, event.id)

    if etype == "checkout.session.completed":
        await _handle_checkout_completed(conn, obj)
        return True

    if etype in (
        "customer.subscription.created",
        "customer.subscription.updated",
        "customer.subscription.deleted",
    ):
        await _handle_subscription_event(conn, obj)
        return True

    if etype == "invoice.paid":
        await _handle_invoice_paid(conn, obj)
        return True

    # Anything else — explicitly skipped, audit row gets status=skipped.
    return False


async def _handle_checkout_completed(conn, session: Any) -> None:
    """A user finished Stripe Checkout. The session contains:
    - customer (id we should pin onto users.stripe_customer_id)
    - subscription (id; we fetch full Subscription to sync state)
    - metadata.supabase_user_id (we set this on session creation —
      external namespace per AGENTS.md "用户标识规约")
    """
    user_id = await _user_id_from_metadata(conn, session)
    if user_id is None:
        # Fall back to looking up by customer_id (e.g. session created
        # without our metadata for some reason).
        cust = _attr(session, "customer")
        cust_id = cust if isinstance(cust, str) else _attr(cust, "id")
        if cust_id:
            user_id = await subscriptions.find_user_by_stripe_customer(conn, cust_id)
    if user_id is None:
        logger.warning(
            "checkout.completed without resolvable user (session=%s)", _attr(session, "id")
        )
        return

    sub_id = _attr(session, "subscription")
    if isinstance(sub_id, dict):
        sub_id = sub_id.get("id")
    if not sub_id:
        # Subscription will land on customer.subscription.created shortly.
        return

    stripe = requires_stripe()
    sub = stripe.Subscription.retrieve(sub_id)
    plan_code = await _plan_code_for_subscription(conn, sub)
    await subscriptions.sync_from_stripe_subscription(
        conn,
        user_id=user_id,
        plan_code=plan_code,
        stripe_subscription=sub,
    )


async def _handle_subscription_event(conn, sub: Any) -> None:
    """customer.subscription.{created,updated,deleted} — re-fetch for
    canonical state and upsert. Stripe webhooks can arrive out of order;
    re-fetching avoids stale overwrites.

    On status=canceled (terminal), also zero the LiteLLM budget so the
    user can no longer hit paid LLMs."""
    sub_id = _attr(sub, "id")
    if not sub_id:
        return

    # Try to resolve user via metadata first (same path as checkout).
    user_id = await _user_id_from_metadata(conn, sub)
    if user_id is None:
        # Fall back to customer_id, then to existing pai_subscriptions row.
        cust = _attr(sub, "customer")
        cust_id = cust if isinstance(cust, str) else _attr(cust, "id")
        if cust_id:
            user_id = await subscriptions.find_user_by_stripe_customer(conn, cust_id)
        if user_id is None:
            user_id = await subscriptions.find_user_by_stripe_subscription(conn, sub_id)
    if user_id is None:
        logger.warning("subscription event without resolvable user (sub=%s)", sub_id)
        return

    # Always re-fetch — webhook payload may be stale by the time we process.
    stripe = requires_stripe()
    fresh = stripe.Subscription.retrieve(sub_id)
    plan_code = await _plan_code_for_subscription(conn, fresh)

    # update_plan_code=False: Stripe.subscription.items[0].price may
    # already reflect a scheduled mid-period switch (see checkout
    # create_or_change_subscription's "Switch" path). Letting that
    # bleed into pai_subscriptions.plan_code would activate the
    # next-cycle plan early. invoice.paid is the SSOT for actually
    # promoting pending_plan_code → plan_code on renewal.
    await subscriptions.sync_from_stripe_subscription(
        conn,
        user_id=user_id,
        plan_code=plan_code,
        stripe_subscription=fresh,
        update_plan_code=False,
    )

    from . import checkout as checkout_flow

    fresh_status = _attr(fresh, "status")
    if fresh_status == "canceled":
        # On terminal cancel, demote the user back to Free tier (not zero
        # budget — Free is the default state, $5/30d). Note:
        # cancel_at_period_end=True alone does NOT trigger this — Stripe
        # only fires deleted (status=canceled) when the period actually
        # ends. Customer Portal "cancel immediately" also lands here.
        await checkout_flow.ensure_user_free_subscription(conn, user_id)
        await checkout_flow.sync_litellm_budget_for_plan(
            conn,
            user_id,
            "free",
            reset_spend=True,
        )


async def _handle_invoice_paid(conn, invoice: Any) -> None:
    """invoice.paid arrives on each renewal. Three jobs:
      1. Re-sync pai_subscriptions so current_period_{start,end} advance.
      2. Promote pending_plan_code (if set) → plan_code, clear pending.
         This is where mid-period plan switches actually take effect.
      3. Refresh the LiteLLM virtual key budget:
         - max_budget = new plan.monthly_refresh_credits / 100 (USD ceiling)
         - budget_duration = '30d' (LiteLLM rebases window to NOW)
         - spend = 0 (explicit reset)

    invoice.paid is the SSOT for LiteLLM budget refresh AND for plan
    transitions. customer.subscription.updated NEVER promotes plan_code
    (it only syncs status/period metadata) because Stripe.items[0].price
    can change mid-period without an actual billing event.
    """
    sub_id = _attr(invoice, "subscription")
    if isinstance(sub_id, dict):
        sub_id = sub_id.get("id")
    if not sub_id:
        return
    user_id = await subscriptions.find_user_by_stripe_subscription(conn, sub_id)
    if user_id is None:
        cust = _attr(invoice, "customer")
        cust_id = cust if isinstance(cust, str) else _attr(cust, "id")
        if cust_id:
            user_id = await subscriptions.find_user_by_stripe_customer(conn, cust_id)
    if user_id is None:
        logger.warning("invoice.paid without resolvable user (invoice=%s)", _attr(invoice, "id"))
        return
    stripe = requires_stripe()
    fresh = stripe.Subscription.retrieve(sub_id)
    stripe_plan_code = await _plan_code_for_subscription(conn, fresh)

    # Resolve pending_plan_code from two sources, in this order:
    #   1. Stripe subscription.metadata.pending_plan_code — set by whichever
    #      backend ran the switch (see checkout.create_or_change_subscription).
    #      This is the cross-environment SSOT: if a switch was scheduled on
    #      one backend (e.g. local dev) and invoice.paid lands on a different
    #      backend (e.g. cloud dev where the webhook is configured), the
    #      metadata is the only place both sides can see the pending value.
    #      Without this lookup the cloud backend would fall back to
    #      Stripe.items[0].price — which is already the next-cycle price —
    #      and incorrectly promote plan_code one cycle early.
    #   2. Local DB pai_subscriptions.pending_plan_code — fallback for
    #      subscriptions scheduled before this metadata path rolled out,
    #      and as a belt-and-suspenders read on the same backend.
    pending = _pending_from_stripe_metadata(fresh)
    pre_sync = await subscriptions.get_for_user(conn, user_id)
    if pending is None:
        pending = pre_sync.pending_plan_code if pre_sync else None
    if pending:
        plan_code = pending
        logger.info(
            "invoice.paid promoting pending plan: user=%d %s → %s",
            user_id,
            pre_sync.plan_code if pre_sync else "?",
            pending,
        )
    else:
        plan_code = stripe_plan_code

    await subscriptions.sync_from_stripe_subscription(
        conn,
        user_id=user_id,
        plan_code=plan_code,
        stripe_subscription=fresh,
    )
    if pending:
        await subscriptions.clear_pending_plan_code(conn, user_id)
        # Also clear from Stripe metadata so the next invoice.paid doesn't
        # re-detect the same pending value and re-promote. DB is already
        # consistent at this point so metadata cleanup is best-effort —
        # log + continue on Stripe API failure.
        try:
            stripe.Subscription.modify(
                sub_id,
                metadata={"pending_plan_code": ""},
            )
        except Exception as e:
            logger.warning(
                "failed to clear pending_plan_code from Stripe metadata for sub=%s: %s",
                sub_id,
                e,
            )

    # ── LiteLLM budget refresh ──
    if plan_code is None:
        logger.warning(
            "invoice.paid for user=%d but plan_code unresolved; LiteLLM budget not refreshed",
            user_id,
        )
        return
    plan = await plans.find_by_code(conn, plan_code)
    if plan is None:
        return
    virtual_key = await _virtual_key_for_user(conn, user_id)
    if not virtual_key:
        logger.warning(
            "invoice.paid: user=%d has no litellm_virtual_key; budget not refreshed",
            user_id,
        )
        return
    budget_usd = plan.monthly_refresh_credits / _CREDITS_PER_USD
    try:
        await litellm_client.update_key(
            virtual_key=virtual_key,
            max_budget_usd=budget_usd,
            budget_duration=_BUDGET_DURATION,
            reset_spend=True,
        )
        logger.info(
            "litellm budget refreshed: user=%d plan=%s max_budget=$%.2f",
            user_id,
            plan_code,
            budget_usd,
        )
    except litellm_client.LiteLLMError as e:
        # Don't fail the whole webhook on LiteLLM hiccup — Stripe state
        # is already persisted; spend tracking just drifts until next
        # invoice.paid retry. Log and continue.
        logger.exception(
            "litellm /key/update failed for user=%d: %s",
            user_id,
            e,
        )


# ── helpers ──


async def _resolve_user_id_for_event(conn, event: Any) -> int | None:
    """Best-effort user id pull from event payload metadata.
    Used for the audit log; sync handlers re-resolve more carefully."""
    obj = event.data.object if hasattr(event, "data") else event["data"]["object"]
    return await _user_id_from_metadata(conn, obj)


async def _user_id_from_metadata(conn, obj: Any) -> int | None:
    """Resolve the internal BIGINT user id from a Stripe metadata blob.

    Primary key is `supabase_user_id` (UUID) per AGENTS.md "用户标识规约";
    `internal_user_id` is debug-only context. We never trust the BIGINT
    from metadata alone — local docker / dev / prod assign different
    SERIAL ids to the same Supabase user, so resolving by BIGINT would
    cross-env-pollute. Always re-resolve via the UUID's users row.
    """
    md = _attr(obj, "metadata") or {}
    if not isinstance(md, dict):
        return None
    supabase_uuid = md.get("supabase_user_id")
    if isinstance(supabase_uuid, str) and supabase_uuid:
        return await subscriptions.find_user_by_supabase_user_id(conn, supabase_uuid)
    return None


def _attr(obj: Any, name: str) -> Any:
    if obj is None:
        return None
    if hasattr(obj, name):
        return getattr(obj, name)
    if isinstance(obj, dict):
        return obj.get(name)
    return None


def _pending_from_stripe_metadata(sub: Any) -> str | None:
    """Read pending_plan_code from a Stripe Subscription's metadata.

    Returns None when the key is absent or empty-string. Empty-string is
    the Stripe-API convention for 'unset this metadata field' — used by
    checkout's revoke path and by _handle_invoice_paid post-promote
    cleanup. Treating it as None means a metadata key that was explicitly
    cleared on Stripe doesn't accidentally re-trigger a promotion.
    """
    md = _attr(sub, "metadata") or {}
    if not isinstance(md, dict):
        return None
    value = md.get("pending_plan_code")
    if isinstance(value, str) and value:
        return value
    return None


async def _plan_code_for_subscription(conn, sub: Any) -> str | None:
    """Resolve our plan_code from the subscription's first item price."""
    items = _attr(sub, "items") or {}
    data = _attr(items, "data") or []
    if not data:
        return None
    first = data[0]
    price = _attr(first, "price") or {}
    price_id = _attr(price, "id")
    if not price_id:
        return None
    plan = await plans.find_by_stripe_price(conn, price_id)
    return plan.plan_code if plan else None


async def _virtual_key_for_user(conn, user_id: int) -> str | None:
    """Fetch the user's LiteLLM virtual key from users table. Returns
    None if the user has no key provisioned yet (will be set on next
    chat-side `ensure_user_litellm_key` call).

    Mirrors checkout._virtual_key_for_user — duplicated here to avoid
    a webhook → checkout circular import (checkout already imports
    plans + subscriptions which webhook also uses)."""
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


def _event_to_dict(event: Any) -> dict[str, Any]:
    """Stripe-py events have a .to_dict() method; fall back to dict()."""
    if hasattr(event, "to_dict"):
        return event.to_dict()
    if isinstance(event, dict):
        return event
    return {"id": _attr(event, "id"), "type": _attr(event, "type")}
