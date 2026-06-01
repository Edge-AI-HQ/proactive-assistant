"""Per-user Browserbase context provisioning.

Lazy-creates one persistent context per user (via `bb.contexts.create`)
so cookies + login state survive across browser sessions. Stored on
`users.browserbase_context_id`. Disabled / no-op when
`BROWSERBASE_API_KEY` is unset.
"""

from __future__ import annotations

import asyncio
import logging

from browserbase import Browserbase
from psycopg_pool import AsyncConnectionPool

from ...config import get_web_settings
from ..auth.user_service import User
from ..db.rls import service_tx

logger = logging.getLogger(__name__)


async def ensure_browserbase_context(
    pool: AsyncConnectionPool,
    user: User,
) -> User:
    """Idempotent: returns `user` unchanged if already provisioned (or if
    Browserbase isn't configured). Otherwise mints a context, persists
    `users.browserbase_context_id`, returns the updated `User`.

    Failure mode: if the Browserbase call errors we leave `browserbase_context_id`
    NULL and return the user as-is. Browser tool falls back to ephemeral
    sessions, retry on the next chat-send. Same lazy-recovery posture as
    LiteLLM provisioning.
    """
    if user.browserbase_context_id:
        return user
    s = get_web_settings()
    if not (s.browserbase_api_key and s.browserbase_project_id):
        return user

    try:
        bb = Browserbase(api_key=s.browserbase_api_key)
        ctx = await asyncio.to_thread(
            bb.contexts.create,
            project_id=s.browserbase_project_id,
        )
    except Exception as e:
        logger.warning(
            "browserbase context provisioning failed user=%d: %s: %s",
            user.id,
            type(e).__name__,
            e,
        )
        return user

    context_id = getattr(ctx, "id", None)
    if not isinstance(context_id, str) or not context_id:
        logger.warning("browserbase context create returned no id user=%d", user.id)
        return user

    async with service_tx(pool) as conn:
        await conn.execute(
            "UPDATE users SET browserbase_context_id = %s WHERE id = %s",
            (context_id, user.id),
        )
    logger.info("browserbase context provisioned user=%d ctx=%s", user.id, context_id)
    user.browserbase_context_id = context_id
    return user
