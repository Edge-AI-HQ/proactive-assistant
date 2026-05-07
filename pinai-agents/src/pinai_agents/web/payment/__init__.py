"""Stripe-backed billing.

Module layout (inverted from the apis sprawl — one concern per file):

  stripe_client.py    — singleton Stripe client + secret resolution.
  plans.py            — billing plan catalog repo (read-only at runtime).
  subscriptions.py    — pai_subscriptions repo + sync_from_stripe().
  webhook.py          — webhook event verification + dispatch.
  guard.py            — has_active_subscription(user_id) — middleware-
                        callable from any route that needs paywall gating.
  routes.py           — /api/payment/* HTTP surface.

We keep the data model minimal:
  * One row per user in pai_subscriptions (current state, not history).
  * No per-period budget application (LiteLLM virtual key rate-limits live
    on the user row already, set on user provisioning).
  * Webhook idempotency via pai_stripe_webhook_events keyed by Stripe
    event_id — replays on retry collapse to a no-op.

Things deliberately not ported from apis:
  * Promotion-preview / coupon apply path (frontend can pass coupon to
    Stripe Checkout directly via allow_promotion_codes=True).
  * subscription-period budget reset cron — LiteLLM handles this natively.
  * Internal payment-session tokens — apis used these to bridge from a
    Telegram bot deep link to a logged-in checkout. Our flow is direct
    (frontend → checkout, Supabase JWT auths the user already).
"""

from __future__ import annotations

from .guard import has_active_subscription
from .stripe_client import get_stripe, requires_stripe

__all__ = [
    "get_stripe",
    "has_active_subscription",
    "requires_stripe",
]
