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

    # Provision LiteLLM key on the INSERT branch (xmax=0 means the row
    # came from INSERT, not ON CONFLICT). Done synchronously so the
    # caller can rely on user.litellm_virtual_key being populated; on
    # LiteLLM failure we degrade to NULL and the next chat-send retries.
    if row.get("inserted") and not user.litellm_virtual_key:
        from ..services.litellm_provisioning import (  # noqa: PLC0415
            provision_user_litellm_key,
        )
        user = await provision_user_litellm_key(pool, user)

    return user
