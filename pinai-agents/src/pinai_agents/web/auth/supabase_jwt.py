"""Verify Supabase Auth JWT via the project's `/auth/v1/user` endpoint.

Why network verification (mirrors apis's pattern):
  - The HS256 signing secret would be one more rotatable secret to
    manage; we already have the project's anon key in env for the
    frontend build, so reusing it costs nothing.
  - Aligns with Supabase's modern publishable + secret key model.
  - Token revocation is honored within the cache TTL (any per-token
    revocation propagates after at most CACHE_TTL_SEC).

A 30-second LRU cache + concurrent-call dedup keep the round-trip
overhead off the hot path: a typical page load fires 5–10 /api/*
requests in parallel, all carrying the same token. Without dedup
that's 5–10 HTTPS hops; with it, exactly one — plus we cache the
result for follow-up bursts.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import time
from collections import OrderedDict
from dataclasses import dataclass
from typing import Any

import httpx

from ...config import get_web_settings

logger = logging.getLogger(__name__)


class JWTVerifyError(Exception):
    """Raised when token verification fails (network error, invalid token,
    or Supabase rejection)."""


@dataclass(slots=True)
class SupabaseClaims:
    sub: str            # Supabase user UUID
    email: str | None
    role: str           # 'authenticated' for end users


_CACHE_TTL_SEC = 30.0
_CACHE_MAX_ENTRIES = 1024

# Module-level cache + in-flight map. Keyed by sha256(token) so the
# raw token never lives in process memory beyond the request handling
# its own caller. Bounded by max-entries with FIFO eviction; bounded
# by TTL so revoked tokens stop verifying within 30s.
_cache: OrderedDict[str, tuple[float, SupabaseClaims]] = OrderedDict()
_inflight: dict[str, asyncio.Future[SupabaseClaims]] = {}


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _cache_get(key: str) -> SupabaseClaims | None:
    entry = _cache.get(key)
    if entry is None:
        return None
    expiry, claims = entry
    if time.monotonic() > expiry:
        _cache.pop(key, None)
        return None
    _cache.move_to_end(key)  # LRU touch
    return claims


def _cache_set(key: str, claims: SupabaseClaims) -> None:
    _cache[key] = (time.monotonic() + _CACHE_TTL_SEC, claims)
    _cache.move_to_end(key)
    while len(_cache) > _CACHE_MAX_ENTRIES:
        _cache.popitem(last=False)  # evict oldest


def reset_cache_for_tests() -> None:
    """Test helper — clears module-level cache + inflight state."""
    _cache.clear()
    _inflight.clear()


async def _call_supabase(token: str) -> SupabaseClaims:
    """Hit `${SUPABASE_URL}/auth/v1/user` and parse the user response.
    Raises JWTVerifyError on any non-2xx or malformed body."""
    settings = get_web_settings()
    if not settings.supabase_url:
        raise JWTVerifyError("SUPABASE_URL not configured")
    if not settings.supabase_publishable_key:
        raise JWTVerifyError("SUPABASE_PUBLISHABLE_KEY not configured")

    url = f"{settings.supabase_url.rstrip('/')}/auth/v1/user"
    headers = {
        "Authorization": f"Bearer {token}",
        "apikey": settings.supabase_publishable_key,
    }
    timeout = httpx.Timeout(connect=3.0, read=5.0, write=3.0, pool=3.0)
    try:
        async with httpx.AsyncClient(timeout=timeout) as cli:
            resp = await cli.get(url, headers=headers)
    except httpx.RequestError as e:
        raise JWTVerifyError(f"supabase auth unreachable: {e}") from e

    if resp.status_code in (401, 403):
        raise JWTVerifyError(f"supabase rejected token ({resp.status_code})")
    if not resp.is_success:
        raise JWTVerifyError(
            f"supabase /auth/v1/user {resp.status_code}: {resp.text[:200]}",
        )

    try:
        data: dict[str, Any] = resp.json()
    except ValueError as e:
        raise JWTVerifyError(f"supabase response not JSON: {e}") from e

    sub = data.get("id")
    if not isinstance(sub, str) or not sub:
        raise JWTVerifyError("supabase response missing user id")
    email_raw = data.get("email")
    role_raw = data.get("role")
    return SupabaseClaims(
        sub=sub,
        email=email_raw if isinstance(email_raw, str) and email_raw else None,
        role=role_raw if isinstance(role_raw, str) and role_raw else "authenticated",
    )


async def verify_supabase_jwt(token: str) -> SupabaseClaims:
    """Verify a Supabase Auth bearer token. Cached + deduped."""
    if not token:
        raise JWTVerifyError("empty token")

    key = _hash_token(token)
    cached = _cache_get(key)
    if cached is not None:
        return cached

    # Coalesce concurrent verifications — second caller awaits the same
    # future the first caller is producing.
    if key in _inflight:
        return await _inflight[key]

    fut: asyncio.Future[SupabaseClaims] = asyncio.get_running_loop().create_future()
    _inflight[key] = fut
    try:
        claims = await _call_supabase(token)
    except Exception as e:
        if not fut.done():
            fut.set_exception(e)
        raise
    else:
        _cache_set(key, claims)
        if not fut.done():
            fut.set_result(claims)
        return claims
    finally:
        _inflight.pop(key, None)
