"""Minimal Supabase-JWT auth for the reward dashboard.

The reward dashboard is an internal review tool. It verifies a reviewer's
Supabase Auth bearer token and resolves it to the BIGINT `users` row — but
it must NOT hold any master credential. So instead of importing the api
process's auth layer, it carries its own self-contained verification:

  * `verify_supabase_jwt` — network verification via the project's
    `/auth/v1/user` endpoint (same model as the api process), with a tiny
    LRU cache + concurrent-call dedup so a page-load burst of /api/* calls
    costs one HTTPS hop. VERIFY-ONLY: no secret key, no admin calls, no
    JWT signing.
  * `current_user` — verify → idempotent `users` upsert → `User`. Unlike
    the api's variant this upsert does NOT seed default goals (that's a
    product-onboarding concern owned by the api process); the reviewer's
    row is expected to already exist, and a first-touch insert just
    materializes the BIGINT id so the dashboard's user-scoped queries work.
  * dev-only bypass — under `DEPLOY_ENV=dev`, a fixed `X-Dev-Auth` marker
    returns a deterministic reviewer identity without a Supabase round-trip
    (so the dashboard can be exercised locally in a browser). Inert outside
    dev.

The dashboard's routes scope every query to the resolved `user.id` inside
`user_scoped_tx`, exactly like the api's UI routes.
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
from fastapi import Depends, Header, HTTPException, Request, status
from pinai_db.rls import service_tx
from psycopg_pool import AsyncConnectionPool

from pinai_reward_dashboard.config import get_settings

logger = logging.getLogger(__name__)


# ── User row ──────────────────────────────────────────────────────────


@dataclass(slots=True)
class User:
    """Resolved reviewer principal.

    Mirrors the shape the dashboard routes/repos consume. `litellm_virtual_key`
    / `browserbase_context_id` are carried for shape-compatibility with the
    repos' wire helpers but are never used by the dashboard (it mints no
    credentials)."""

    id: int
    supabase_user_id: str
    email: str | None
    litellm_virtual_key: str | None = None
    browserbase_context_id: str | None = None

    def __post_init__(self) -> None:
        # psycopg hydrates a uuid column as a UUID object; coerce to str at
        # this boundary so the annotated type holds.
        self.supabase_user_id = str(self.supabase_user_id)


async def _upsert_user_by_supabase_id(
    pool: AsyncConnectionPool,
    *,
    supabase_user_id: str,
    email: str | None = None,
) -> User:
    """Find or create the reviewer's `users` row (idempotent).

    No default-goal seeding (that's the api process's onboarding job). The
    INSERT path just materializes the BIGINT id; the UPDATE path bumps
    last_active_at + email-sync."""
    async with service_tx(pool) as conn:
        cur = await conn.execute(
            """
            INSERT INTO users (supabase_user_id, email, last_active_at)
            VALUES (%s, %s, NOW())
            ON CONFLICT (supabase_user_id) DO UPDATE SET
              email = COALESCE(EXCLUDED.email, users.email),
              last_active_at = NOW()
            RETURNING id, supabase_user_id, email
            """,
            (supabase_user_id, email),
        )
        row: dict[str, Any] | None = await cur.fetchone()
    if row is None:
        msg = f"user upsert returned no row (supabase_user_id={supabase_user_id})"
        raise RuntimeError(msg)
    return User(
        id=row["id"],
        supabase_user_id=row["supabase_user_id"],
        email=row.get("email"),
    )


# ── Supabase JWT verification (verify-only, cached) ──────────────────────


class JWTVerifyError(Exception):
    """Raised when token verification fails (network error, invalid token,
    or Supabase rejection)."""


@dataclass(slots=True)
class SupabaseClaims:
    sub: str  # Supabase user UUID
    email: str | None
    role: str  # 'authenticated' for end users


_CACHE_TTL_SEC = 30.0
_CACHE_MAX_ENTRIES = 1024

# Module-level cache + in-flight map. Keyed by sha256(token) so the raw
# token never lives in process memory beyond the request handling its own
# caller. Bounded by max-entries (FIFO eviction) + TTL (revoked tokens stop
# verifying within 30s).
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
    settings = get_settings()
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


# ── FastAPI deps ─────────────────────────────────────────────────────────


def _extract_bearer(authorization: str | None) -> str:
    """Pull `<token>` out of `Authorization: Bearer <token>`. Raises 401 on miss."""
    if not authorization:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authorization header missing",
            headers={"WWW-Authenticate": "Bearer"},
        )
    parts = authorization.strip().split(None, 1)
    if len(parts) != 2 or parts[0].lower() != "bearer":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authorization header must be `Bearer <token>`",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return parts[1]


def get_pool(request: Request) -> AsyncConnectionPool:
    """Extract the lifespan-managed pool. 503 if DB never opened."""
    pool: AsyncConnectionPool | None = getattr(request.app.state, "pool", None)
    if pool is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="DB pool not initialized — check DATABASE_URL",
        )
    return pool


# Dev-only short-circuit. Active ONLY when DEPLOY_ENV=dev AND the request
# carries the fixed reviewer marker header. Lets the internal-reward-dashboard
# be verified end-to-end in a browser without Supabase OAuth round-trips. The
# marker is a fixed string rather than a secret because the bypass only fires
# under DEPLOY_ENV=dev (never on prod/test/fly) and the local dev Postgres is
# not a production credential surface. Inert in any non-dev environment.
_DEV_AUTH_REVIEWER_HEADER_VALUE = "pinai-dev-reviewer"
_DEV_AUTH_REVIEWER_EMAIL = "dev-reviewer@local.invalid"
_DEV_AUTH_REVIEWER_SUB = "00000000-0000-0000-0000-00000000d0d1"


async def current_user(
    authorization: str | None = Header(default=None),
    x_dev_auth: str | None = Header(default=None, alias="X-Dev-Auth"),
    pool: AsyncConnectionPool = Depends(get_pool),
) -> User:
    """Verify Supabase JWT and resolve to the BIGINT `users` row.

    On miss: 401. The upsert is idempotent — first touch creates the row,
    subsequent calls fetch the existing one.

    Dev-only bypass: when DEPLOY_ENV=dev AND the request carries the known
    `X-Dev-Auth: pinai-dev-reviewer` marker, return a deterministic reviewer
    without touching Supabase. Inert outside DEPLOY_ENV=dev."""
    settings = get_settings()
    marker = x_dev_auth.strip() if x_dev_auth else None
    if settings.deploy_env == "dev" and marker == _DEV_AUTH_REVIEWER_HEADER_VALUE:
        logger.info("dev auth bypass active (DEPLOY_ENV=dev, reviewer)")
        return await _upsert_user_by_supabase_id(
            pool,
            supabase_user_id=_DEV_AUTH_REVIEWER_SUB,
            email=_DEV_AUTH_REVIEWER_EMAIL,
        )

    token = _extract_bearer(authorization)
    try:
        claims = await verify_supabase_jwt(token)
    except JWTVerifyError as e:
        logger.info("Supabase JWT verify failed: %s", e)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="invalid Supabase token",
            headers={"WWW-Authenticate": "Bearer"},
        ) from e

    return await _upsert_user_by_supabase_id(
        pool,
        supabase_user_id=claims.sub,
        email=claims.email,
    )
