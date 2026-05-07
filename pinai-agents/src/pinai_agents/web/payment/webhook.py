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

from . import plans, subscriptions
from .stripe_client import requires_stripe, requires_webhook_secret

logger = logging.getLogger(__name__)


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
    user_id = _resolve_user_id_for_event(event)
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
      - metadata.user_id (we set this on session creation)
    """
    user_id = _user_id_from_metadata(session)
    if user_id is None:
        # Fall back to looking up by customer_id (e.g. session created
        # without our metadata for some reason).
        cust = _attr(session, "customer")
        cust_id = cust if isinstance(cust, str) else _attr(cust, "id")
        if cust_id:
            user_id = await subscriptions.find_user_by_stripe_customer(conn, cust_id)
    if user_id is None:
        logger.warning("checkout.completed without resolvable user (session=%s)",
                       _attr(session, "id"))
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
        conn, user_id=user_id, plan_code=plan_code, stripe_subscription=sub,
    )


async def _handle_subscription_event(conn, sub: Any) -> None:
    """customer.subscription.{created,updated,deleted} — re-fetch for
    canonical state and upsert. Stripe webhooks can arrive out of order;
    re-fetching avoids stale overwrites."""
    sub_id = _attr(sub, "id")
    if not sub_id:
        return

    # Try to resolve user via metadata first (same path as checkout).
    user_id = _user_id_from_metadata(sub)
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
    await subscriptions.sync_from_stripe_subscription(
        conn, user_id=user_id, plan_code=plan_code, stripe_subscription=fresh,
    )


async def _handle_invoice_paid(conn, invoice: Any) -> None:
    """invoice.paid arrives on each renewal. We re-sync the subscription
    so current_period_{start,end} advance to the next period."""
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
        logger.warning("invoice.paid without resolvable user (invoice=%s)",
                       _attr(invoice, "id"))
        return
    stripe = requires_stripe()
    fresh = stripe.Subscription.retrieve(sub_id)
    plan_code = await _plan_code_for_subscription(conn, fresh)
    await subscriptions.sync_from_stripe_subscription(
        conn, user_id=user_id, plan_code=plan_code, stripe_subscription=fresh,
    )


# ── helpers ──


def _resolve_user_id_for_event(event: Any) -> int | None:
    """Best-effort user id pull from event payload metadata.
    Used for the audit log; sync handlers re-resolve more carefully."""
    obj = event.data.object if hasattr(event, "data") else event["data"]["object"]
    return _user_id_from_metadata(obj)


def _user_id_from_metadata(obj: Any) -> int | None:
    md = _attr(obj, "metadata") or {}
    if isinstance(md, dict):
        raw = md.get("user_id") or md.get("supabase_user_id_int")
        if raw is None:
            return None
        try:
            return int(raw)
        except (ValueError, TypeError):
            return None
    return None


def _attr(obj: Any, name: str) -> Any:
    if obj is None:
        return None
    if hasattr(obj, name):
        return getattr(obj, name)
    if isinstance(obj, dict):
        return obj.get(name)
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


def _event_to_dict(event: Any) -> dict[str, Any]:
    """Stripe-py events have a .to_dict() method; fall back to dict()."""
    if hasattr(event, "to_dict"):
        return event.to_dict()
    if isinstance(event, dict):
        return event
    return {"id": _attr(event, "id"), "type": _attr(event, "type")}
