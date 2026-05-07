"""Subscription guard — single function the rest of the app uses to gate
paid features.

Cheap to call (one indexed query). Routes / tools that need paywall
should `if not await has_active_subscription(conn, user_id): raise 402`.
"""

from __future__ import annotations

from .subscriptions import get_for_user


async def has_active_subscription(conn, user_id: int) -> bool:
    """True when the user has a current Stripe sub in trialing or active.

    Returns False for past_due / canceled / incomplete / no row at all
    — all of these mean "do not give access to paid features". The
    cancel-at-period-end case keeps returning True until the period
    actually ends; Stripe flips the row to canceled at that point.
    """
    sub = await get_for_user(conn, user_id)
    return bool(sub and sub.is_access_granted())
