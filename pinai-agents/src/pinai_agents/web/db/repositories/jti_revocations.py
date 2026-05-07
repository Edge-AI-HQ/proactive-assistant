"""pai_jti_revocations CRUD.

Schema: 028_pai_jti_revocations.sql.

Two callers:
  * verify_agent_run_jwt — the hot-path lookup. Single SELECT per
    /api/agent/* request; uses an in-memory LRU to avoid Postgres on
    every call (cache size = recent JWTs that have been verified, capped
    at 10k entries; LRU eviction).
  * /api/agent/jwt/revoke — the security-incident endpoint that adds
    a row.
  * scheduler sweep — drops rows older than expires_at.

Why service-role: the verify path doesn't yet know which user_id the
token belongs to (that's part of what the JWT carries). So the lookup
runs against all users — service_tx() context.
"""

from __future__ import annotations

from collections import OrderedDict
from datetime import datetime
from threading import Lock

# Hot-path cache: jti → bool (revoked) decision. Stops a /api/agent/*
# burst from hammering Postgres. Eviction: LRU bounded by max size.
# Negative cache (jti present but value False) is the common case;
# positive (revoked) entries are rare and stay until evicted.
_CACHE_MAX = 10_000
_cache: OrderedDict[str, bool] = OrderedDict()
_cache_lock = Lock()


def _cache_get(jti: str) -> bool | None:
    with _cache_lock:
        if jti in _cache:
            _cache.move_to_end(jti)
            return _cache[jti]
        return None


def _cache_put(jti: str, revoked: bool) -> None:
    with _cache_lock:
        _cache[jti] = revoked
        _cache.move_to_end(jti)
        while len(_cache) > _CACHE_MAX:
            _cache.popitem(last=False)


def _cache_invalidate(jti: str) -> None:
    """Called on revoke() so the next verify sees the new state."""
    with _cache_lock:
        _cache.pop(jti, None)


async def is_revoked(conn, jti: str) -> bool:
    """Hot-path lookup. Returns True if the jti is in the revocation
    table AND the original JWT TTL hasn't elapsed yet (rows past
    expires_at are dead-weight; we treat them as not-revoked since the
    JWT itself is already exp-rejected by pyjwt)."""
    if not jti:
        return False
    cached = _cache_get(jti)
    if cached is not None:
        return cached
    async with conn.cursor() as cur:
        await cur.execute(
            """
            SELECT 1 FROM pai_jti_revocations
            WHERE jti = %s AND expires_at > NOW()
            LIMIT 1
            """,
            (jti,),
        )
        revoked = (await cur.fetchone()) is not None
    _cache_put(jti, revoked)
    return revoked


async def revoke(
    conn, *, jti: str, user_id: int, expires_at: datetime,
    reason: str | None = None,
) -> None:
    """Insert a revocation row. Idempotent on the jti PK — a duplicate
    revoke for the same jti is a no-op."""
    async with conn.cursor() as cur:
        await cur.execute(
            """
            INSERT INTO pai_jti_revocations (jti, user_id, reason, expires_at)
            VALUES (%s, %s, %s, %s)
            ON CONFLICT (jti) DO NOTHING
            """,
            (jti, user_id, reason, expires_at),
        )
    _cache_invalidate(jti)


async def revoke_all_for_user(
    conn, *, user_id: int, jtis: list[tuple[str, datetime]],
    reason: str | None = None,
) -> int:
    """Bulk-revoke a list of (jti, expires_at) pairs for a single user.
    Used by support tooling after an account-takeover incident."""
    if not jtis:
        return 0
    async with conn.cursor() as cur:
        await cur.executemany(
            """
            INSERT INTO pai_jti_revocations (jti, user_id, reason, expires_at)
            VALUES (%s, %s, %s, %s)
            ON CONFLICT (jti) DO NOTHING
            """,
            [(jti, user_id, reason, exp) for jti, exp in jtis],
        )
    for jti, _ in jtis:
        _cache_invalidate(jti)
    return len(jtis)


async def sweep_expired(conn) -> int:
    """Remove rows whose underlying JWT TTL has passed. Run from the
    scheduler tick; returns count of rows deleted."""
    async with conn.cursor() as cur:
        await cur.execute(
            "DELETE FROM pai_jti_revocations WHERE expires_at <= NOW()",
        )
        return cur.rowcount or 0


def clear_cache_for_tests() -> None:
    """Test helper — wipe the LRU between tests."""
    with _cache_lock:
        _cache.clear()
