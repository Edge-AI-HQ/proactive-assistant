"""Stripe SDK singleton + secret accessor.

Stripe's Python SDK uses a module-level api_key (`stripe.api_key = ...`),
not per-client instances. We set it once at first access from
STRIPE_SECRET_KEY env, then return the module itself as the "client".

`requires_stripe()` raises HTTPException(503) when the key isn't
configured — call this from route handlers; `get_stripe()` returns
None instead, for code paths that want to no-op when billing is off
(useful in dev / unit tests).
"""

from __future__ import annotations

from threading import Lock
from typing import TYPE_CHECKING

from fastapi import HTTPException

from ...config import get_web_settings

if TYPE_CHECKING:
    import stripe  # noqa: F401 — type alias only, lazy-imported below

_init_lock = Lock()
_initialized = False


def _maybe_init() -> object | None:
    """Lazy-init the Stripe SDK. Returns the module or None when no key."""
    global _initialized
    settings = get_web_settings()
    if not settings.stripe_secret_key:
        return None
    if not _initialized:
        with _init_lock:
            if not _initialized:
                import stripe as stripe_mod

                stripe_mod.api_key = settings.stripe_secret_key
                # Pin API version explicitly so a Stripe-side default bump
                # doesn't reshape webhook payloads under us.
                stripe_mod.api_version = "2024-09-30.acacia"
                _initialized = True
                return stripe_mod
    import stripe as stripe_mod

    return stripe_mod


def get_stripe() -> object | None:
    """Return the configured Stripe SDK module, or None when unconfigured."""
    return _maybe_init()


def requires_stripe():
    """Same, but raises HTTPException(503) on missing config — for routes."""
    s = _maybe_init()
    if s is None:
        raise HTTPException(503, "Stripe is not configured on this deployment")
    return s


def requires_webhook_secret() -> str:
    secret = get_web_settings().stripe_webhook_secret
    if not secret:
        raise HTTPException(503, "Stripe webhook secret is not configured")
    return secret
