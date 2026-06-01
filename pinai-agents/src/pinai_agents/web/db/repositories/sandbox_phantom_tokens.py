"""pai_sandbox_phantom_tokens CRUD.

Schema: 032_pai_sandbox_phantom_tokens.sql.

Three callers:
  * /api/agent/sandbox/phantom/mint — chat process posts here with its
    chat-driving JWT; we generate a fresh random token, hash + store,
    return raw to caller for injection into the Daytona env.
  * /api/agent/sandbox/phantom/revoke — chat process revokes when
    evicting / shutting down a sandbox.
  * current_agent_run dep — hot-path lookup for every /api/agent/* call
    from a sandbox. LRU-cached to skip Postgres on the common positive case.

Token format: `pai_sbx_<urlsafe-base64-of-32-random-bytes>`. The prefix
lets the dep cheaply route phantom vs JWT (JWTs start with `eyJ…`).

Storage: SHA-256(raw_token) only. Never store the raw token. Even a full
DB dump is unusable to call the API.
"""

from __future__ import annotations

import hashlib
import logging
import secrets
from collections import OrderedDict
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from threading import Lock

from psycopg import AsyncConnection

logger = logging.getLogger(__name__)

# Hot-path cache: token_hash → (user_id, scope_label, sandbox_id) for
# unrevoked, unexpired tokens. None means "we looked, it's not valid."
# LRU bounded to defend against an attacker spraying random tokens to
# pin DB by hammering the cache miss path.
_CACHE_MAX = 10_000
_cache: OrderedDict[str, _PhantomResolved | None] = OrderedDict()
_cache_lock = Lock()


# Default expiration for a phantom — matches sandbox auto_delete (24h).
# Keep in sync with chat/tools/sandbox.py:_AUTO_DELETE_MIN. Going past
# this on the DB side would surface as "sandbox gone but phantom still
# valid", which is the orphan we explicitly want to bound.
DEFAULT_PHANTOM_TTL_SECONDS = 24 * 60 * 60

# Wire-format prefix. Dep code routes on this; pinai_sdk doesn't see it
# (it just forwards whatever string is in PAI_SANDBOX_TOKEN as Bearer).
PHANTOM_PREFIX = "pai_sbx_"


@dataclass(slots=True, frozen=True)
class _PhantomResolved:
    user_id: int
    scope_label: str | None
    sandbox_id: str | None


def _hash_token(raw: str) -> str:
    """SHA-256 → hex. The DB column is TEXT for portability; hex is fine
    (length 64, no encoding pitfalls). HMAC isn't needed here — the input
    is high-entropy random, not user-supplied, so no rainbow-table risk."""
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _generate_raw_token() -> str:
    """`pai_sbx_<urlsafe-base64-of-32-bytes>` → 256 bits of entropy.
    `secrets.token_urlsafe(32)` returns ~43 chars of base64url, total ~51."""
    return f"{PHANTOM_PREFIX}{secrets.token_urlsafe(32)}"


def _cache_get(token_hash: str) -> _PhantomResolved | None | _Sentinel:
    """Three-state result: hit-positive (resolved), hit-negative (None),
    miss (sentinel) — caller must distinguish "we cached the negative"
    from "we never looked"."""
    with _cache_lock:
        if token_hash in _cache:
            _cache.move_to_end(token_hash)
            return _cache[token_hash]
        return _CACHE_MISS


def _cache_put(token_hash: str, resolved: _PhantomResolved | None) -> None:
    with _cache_lock:
        _cache[token_hash] = resolved
        _cache.move_to_end(token_hash)
        while len(_cache) > _CACHE_MAX:
            _cache.popitem(last=False)


def _cache_invalidate(token_hash: str) -> None:
    with _cache_lock:
        _cache.pop(token_hash, None)


class _Sentinel:
    """Distinct type for cache-miss vs cached-negative. A bare `None` would
    collide with the cached-negative case (token looked up, found invalid)."""


_CACHE_MISS = _Sentinel()


async def mint(
    conn: AsyncConnection,
    *,
    user_id: int,
    scope_label: str | None,
    ttl_seconds: int = DEFAULT_PHANTOM_TTL_SECONDS,
) -> tuple[str, str]:
    """Generate + persist a new phantom. Returns (raw_token, token_hash).

    Caller is responsible for ferrying the raw_token into the Daytona
    sandbox env (PAI_SANDBOX_TOKEN). The token_hash is returned mostly
    for logs / correlation.

    sandbox_id is bound later via `bind_sandbox` once Daytona returns
    the id — the env-vars-fixed-at-create constraint forces this order.
    """
    raw = _generate_raw_token()
    token_hash = _hash_token(raw)
    expires_at = datetime.now(UTC) + timedelta(seconds=ttl_seconds)
    async with conn.cursor() as cur:
        await cur.execute(
            """
            INSERT INTO pai_sandbox_phantom_tokens
              (token_hash, user_id, scope_label, expires_at)
            VALUES (%s, %s, %s, %s)
            """,
            (token_hash, user_id, scope_label, expires_at),
        )
    return raw, token_hash


async def bind_sandbox(
    conn: AsyncConnection,
    *,
    token_hash: str,
    sandbox_id: str,
) -> None:
    """Attach a Daytona sandbox id to an already-minted phantom row.

    Cache invalidation: the cached negative (if any) gets cleared so the
    next resolve sees the bound sandbox_id. Positive cache entries don't
    change auth outcome — sandbox_id is metadata only — so we leave them.
    """
    async with conn.cursor() as cur:
        await cur.execute(
            """
            UPDATE pai_sandbox_phantom_tokens
            SET sandbox_id = %s
            WHERE token_hash = %s
            """,
            (sandbox_id, token_hash),
        )
    _cache_invalidate(token_hash)


async def resolve(
    conn: AsyncConnection,
    *,
    raw_token: str,
) -> _PhantomResolved | None:
    """Hot-path lookup. None means "no valid phantom for this token".

    Format check is cheap: token must start with the phantom prefix,
    otherwise we return None without touching DB or cache (defends
    against attackers using random JWTs / garbage as phantoms)."""
    if not raw_token.startswith(PHANTOM_PREFIX):
        return None
    token_hash = _hash_token(raw_token)
    cached = _cache_get(token_hash)
    if not isinstance(cached, _Sentinel):
        return cached  # may be None (cached negative) or a resolved entry

    async with conn.cursor() as cur:
        await cur.execute(
            """
            SELECT user_id, scope_label, sandbox_id
            FROM pai_sandbox_phantom_tokens
            WHERE token_hash = %s
              AND revoked_at IS NULL
              AND expires_at > NOW()
            LIMIT 1
            """,
            (token_hash,),
        )
        row = await cur.fetchone()

    if row is None:
        _cache_put(token_hash, None)
        return None

    # psycopg with dict_row returns a Mapping; index by name.
    resolved = _PhantomResolved(
        user_id=row["user_id"],
        scope_label=row["scope_label"],
        sandbox_id=row["sandbox_id"],
    )
    _cache_put(token_hash, resolved)
    return resolved


async def revoke_by_token(
    conn: AsyncConnection,
    *,
    raw_token: str,
    reason: str | None = None,
) -> bool:
    """Revoke by raw token. Returns True if a row was actually updated.

    Idempotent — already-revoked rows don't double-update (UPDATE ...
    WHERE revoked_at IS NULL keeps the original revoke_at)."""
    if not raw_token.startswith(PHANTOM_PREFIX):
        return False
    token_hash = _hash_token(raw_token)
    async with conn.cursor() as cur:
        await cur.execute(
            """
            UPDATE pai_sandbox_phantom_tokens
            SET revoked_at = NOW(), revoke_reason = %s
            WHERE token_hash = %s AND revoked_at IS NULL
            """,
            (reason, token_hash),
        )
        rowcount = cur.rowcount or 0
    _cache_invalidate(token_hash)
    return rowcount > 0


async def revoke_by_sandbox(
    conn: AsyncConnection,
    *,
    sandbox_id: str,
    user_id: int,
    reason: str | None = None,
) -> int:
    """Revoke all unrevoked phantoms bound to a Daytona sandbox id.

    user_id is required as a defense-in-depth check — without it, a
    compromised mint endpoint could revoke other users' phantoms by
    guessing sandbox ids. The WHERE binds both."""
    async with conn.cursor() as cur:
        await cur.execute(
            """
            UPDATE pai_sandbox_phantom_tokens
            SET revoked_at = NOW(), revoke_reason = %s
            WHERE sandbox_id = %s AND user_id = %s AND revoked_at IS NULL
            RETURNING token_hash
            """,
            (reason, sandbox_id, user_id),
        )
        rows = await cur.fetchall()
    for row in rows:
        _cache_invalidate(row["token_hash"])
    return len(rows)


async def sweep_expired(conn: AsyncConnection, *, retain_days: int = 7) -> int:
    """Drop rows whose TTL elapsed > retain_days ago. Run nightly.

    Retention beyond expires_at gives us forensic window: if an incident
    surfaces 5 days later, the row is still there to inspect."""
    async with conn.cursor() as cur:
        await cur.execute(
            """
            DELETE FROM pai_sandbox_phantom_tokens
            WHERE expires_at < NOW() - make_interval(days => %s)
            """,
            (retain_days,),
        )
        return cur.rowcount or 0


def clear_cache_for_tests() -> None:
    """Test helper — wipe the LRU between tests."""
    with _cache_lock:
        _cache.clear()
