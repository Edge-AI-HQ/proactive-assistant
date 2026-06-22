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

from datetime import UTC, datetime
from threading import Lock
from typing import TYPE_CHECKING, Any

from fastapi import HTTPException

from pinai_api.config import get_web_settings

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


# ── Stripe payload normalization helpers ────────────────────────────────
# Shared across checkout / subscriptions / webhook so the Stripe-object
# field reads and timestamp coercion live in one place.


def stripe_attr(obj: Any, name: str) -> Any:
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


def coerce_dt(v: Any) -> datetime | None:
    """Normalize a Stripe timestamp (unix int/float, ISO string, or
    datetime) into an aware UTC datetime. Returns None for None / garbage."""
    if v is None:
        return None
    if isinstance(v, datetime):
        return v.astimezone(UTC) if v.tzinfo else v.replace(tzinfo=UTC)
    if isinstance(v, int | float):
        return datetime.fromtimestamp(float(v), tz=UTC)
    if isinstance(v, str):
        try:
            s = v[:-1] + "+00:00" if v.endswith("Z") else v
            return datetime.fromisoformat(s).astimezone(UTC)
        except ValueError:
            return None
    return None


def add_calendar_months(dt: datetime, months: int) -> datetime:
    """Add N calendar months, preserving the day where possible (clamped to
    the target month's length). Naive datetimes are treated as UTC."""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    month_index = dt.month - 1 + months
    year = dt.year + month_index // 12
    month = month_index % 12 + 1
    month_lengths = {
        1: 31,
        2: 29 if year % 4 == 0 and (year % 100 != 0 or year % 400 == 0) else 28,
        3: 31,
        4: 30,
        5: 31,
        6: 30,
        7: 31,
        8: 31,
        9: 30,
        10: 31,
        11: 30,
        12: 31,
    }
    return dt.replace(year=year, month=month, day=min(dt.day, month_lengths[month]))
