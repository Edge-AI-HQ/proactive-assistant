"""users table upsert by Supabase UUID → BIGINT user_id.

This module owns the row's first-touch lifecycle:
    1. INSERT a fresh users row when the Supabase UUID isn't on file yet.
    2. Synchronously provision a LiteLLM virtual key for the new row.
    3. ON CONFLICT UPDATE on subsequent calls (same user re-authing) —
       just bumps last_active_at + email-sync. virtual_key is left alone
       once provisioned.

If LiteLLM is unreachable during step 2, the user logs in fine with
virtual_key=NULL; lazy provisioning on the next /chat-stream/send round-
trip recovers. We treat LiteLLM downtime as transient and avoid blocking
authentication.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

from psycopg_pool import AsyncConnectionPool

from ..db.rls import service_tx

logger = logging.getLogger(__name__)


@dataclass(slots=True)
class User:
    id: int
    supabase_user_id: str
    email: str | None
    litellm_virtual_key: str | None
    browserbase_context_id: str | None


async def upsert_user_by_supabase_id(
    pool: AsyncConnectionPool,
    *,
    supabase_user_id: str,
    email: str | None = None,
) -> User:
    """Find or create a users row for this Supabase user.

    Behavior:
      * INSERT path → row is created, then we synchronously provision a
        LiteLLM virtual key (best-effort; failure leaves the row with a
        NULL key so chat-send can lazy-retry).
      * UPDATE path → existing row, only bumps last_active_at + email
        if Supabase changed it. Doesn't touch virtual_key.
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
    # came from INSERT, not ON CONFLICT). Both steps are best-effort —
    # LiteLLM downtime degrades to NULL key + lazy-retry on chat-send,
    # goal seeding failure logs and is recoverable via the agent's
    # evolve / goal_upsert path.
    if row.get("inserted"):
        if not user.litellm_virtual_key:
            from ..services.litellm_provisioning import (  # noqa: PLC0415
                provision_user_litellm_key,
            )
            user = await provision_user_litellm_key(pool, user)

        from ..services.default_goals import seed_default_goals  # noqa: PLC0415
        await seed_default_goals(pool, user.id)

    return user


async def load_user_by_id(
    pool: AsyncConnectionPool, internal_user_id: int,
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
