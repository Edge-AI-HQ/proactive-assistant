"""users table upsert by Supabase UUID → BIGINT user_id.

This module owns the row's first-touch lifecycle:
    1. INSERT a fresh users row when the Supabase UUID isn't on file yet,
       then seed the user's default goals (local, idempotent).
    2. ON CONFLICT UPDATE on subsequent calls (same user re-authing) —
       just bumps last_active_at + email-sync.

Authentication stays free of external-service calls: the LiteLLM virtual
key is intentionally NOT minted here. Every consumer that needs it
(chat-send, generate, ambient, voice, proactive, scheduler) lazily
provisions it via `ensure_user_litellm_key` at point of use, so keeping it
off the auth hot path means login never blocks on LiteLLM availability.
This matters most for brand-new users: the first authenticated request
(GET /api/settings) gates the whole UI, so it must stay millisecond-fast.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

from pinai_db.rls import service_tx
from psycopg_pool import AsyncConnectionPool

logger = logging.getLogger(__name__)


@dataclass(slots=True)
class User:
    id: int
    supabase_user_id: str
    email: str | None
    litellm_virtual_key: str | None
    browserbase_context_id: str | None

    def __post_init__(self) -> None:
        # psycopg hydrates a uuid column as a UUID object; coerce to str at
        # this boundary so the annotated type holds. Consumers that JSON-
        # serialize it (Supabase Storage list/remove in account deletion)
        # or compare it as a string can't trip over a stray UUID instance.
        self.supabase_user_id = str(self.supabase_user_id)


async def upsert_user_by_supabase_id(
    pool: AsyncConnectionPool,
    *,
    supabase_user_id: str,
    email: str | None = None,
) -> User:
    """Find or create a users row for this Supabase user.

    Behavior:
      * INSERT path → row is created, then we seed the user's default
        goals (local, idempotent). The LiteLLM key is left NULL and
        lazily provisioned at point of use (see module docstring).
      * UPDATE path → existing row, only bumps last_active_at + email
        if Supabase changed it.
    """
    async with service_tx(pool) as conn:
        cur = await conn.execute(
            """
            INSERT INTO users (supabase_user_id, email, last_active_at)
            VALUES (%s, %s, NOW())
            ON CONFLICT (supabase_user_id) DO UPDATE SET
              email = COALESCE(EXCLUDED.email, users.email),
              last_active_at = NOW()
            RETURNING id, supabase_user_id, email, litellm_virtual_key,
                      browserbase_context_id, (xmax = 0) AS inserted
            """,
            (supabase_user_id, email),
        )
        row: dict[str, Any] | None = await cur.fetchone()
    if row is None:
        msg = f"user upsert returned no row (supabase_user_id={supabase_user_id})"
        raise RuntimeError(msg)

    user = User(
        id=row["id"],
        supabase_user_id=row["supabase_user_id"],
        email=row.get("email"),
        litellm_virtual_key=row.get("litellm_virtual_key"),
        browserbase_context_id=row.get("browserbase_context_id"),
    )

    # First-touch bootstrap on the INSERT branch (xmax=0 means the row
    # came from INSERT, not ON CONFLICT). Seed portrait defaults only
    # (IDENTITY/SOUL persona baseline + starter GOALS) — idempotent
    # local-DB work, recoverable via the agent's memory_edit path if it
    # fails. The LiteLLM key is deliberately not minted here (see module
    # docstring): every consumer lazy-provisions via
    # ensure_user_litellm_key, so external calls stay off the auth path.
    if row.get("inserted"):
        from pinai_api.domains.memory.portrait import seed_portrait_defaults  # noqa: PLC0415

        await seed_portrait_defaults(pool, user.id)

    return user


async def load_user_by_supabase_id(
    pool: AsyncConnectionPool,
    supabase_user_id: str,
) -> User | None:
    """Hydrate a User by Supabase UUID WITHOUT creating one.

    Unlike `upsert_user_by_supabase_id`, this never inserts — used by the
    internal impersonation mint, where the target must already exist
    (minting a chat token for a brand-new empty user is meaningless).
    Returns None if no such user.
    """
    async with service_tx(pool) as conn:
        cur = await conn.execute(
            """
            SELECT id, supabase_user_id, email, litellm_virtual_key,
                   browserbase_context_id
            FROM users WHERE supabase_user_id = %s
            """,
            (supabase_user_id,),
        )
        row: dict[str, Any] | None = await cur.fetchone()
    if row is None:
        return None
    return User(
        id=row["id"],
        supabase_user_id=row["supabase_user_id"],
        email=row.get("email"),
        litellm_virtual_key=row.get("litellm_virtual_key"),
        browserbase_context_id=row.get("browserbase_context_id"),
    )


@dataclass(slots=True, frozen=True)
class RunCredentials:
    """The two per-run credentials an agent run rides on: the user's LiteLLM
    virtual key and persistent Browserbase context id. Both may be NULL until
    lazily provisioned at point of use."""

    litellm_virtual_key: str | None
    browserbase_context_id: str | None


async def get_run_credentials(
    pool: AsyncConnectionPool,
    user_id: int,
) -> RunCredentials:
    """Read a user's run credentials (LiteLLM virtual key + Browserbase
    context id) by internal BIGINT id.

    The single public accessor for these two `users` columns — `users` is a
    platform/auth-owned table, so callers (control's run worker, billing,
    browser) go through here instead of issuing their own SELECT. Returns
    both as NULL when the row is gone (never raises): the run worker decides
    whether a missing key is fatal, and the Browserbase context may still be
    backfilled lazily at the call site.
    """
    async with service_tx(pool) as conn:
        cur = await conn.execute(
            "SELECT litellm_virtual_key, browserbase_context_id FROM users WHERE id = %s",
            (user_id,),
        )
        row: dict[str, Any] | None = await cur.fetchone()
    if row is None:
        return RunCredentials(litellm_virtual_key=None, browserbase_context_id=None)
    return RunCredentials(
        litellm_virtual_key=row.get("litellm_virtual_key"),
        browserbase_context_id=row.get("browserbase_context_id"),
    )


async def load_user_by_id(
    pool: AsyncConnectionPool,
    internal_user_id: int,
) -> User | None:
    """Hydrate a User row by BIGINT id.

    For background tasks / agent JWT paths that only carry the internal
    id but need the Supabase UUID (e.g. to derive the Composio /
    LiteLLM / Storage external namespace). Returns None if the row is
    gone — caller decides whether that's fatal.
    """
    async with service_tx(pool) as conn:
        cur = await conn.execute(
            """
            SELECT id, supabase_user_id, email, litellm_virtual_key,
                   browserbase_context_id
            FROM users WHERE id = %s
            """,
            (internal_user_id,),
        )
        row: dict[str, Any] | None = await cur.fetchone()
    if row is None:
        return None
    return User(
        id=row["id"],
        supabase_user_id=row["supabase_user_id"],
        email=row.get("email"),
        litellm_virtual_key=row.get("litellm_virtual_key"),
        browserbase_context_id=row.get("browserbase_context_id"),
    )
