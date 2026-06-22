"""Web-process Postgres connection pool.

Single process-wide AsyncConnectionPool against Supabase service_role.
Lifecycle owned by the FastAPI app's lifespan in `web.app.create_app`.

Why psycopg v3 (not asyncpg):
  Same driver as Step 1's LangGraph checkpointer (`chat/runtime/checkpoint.py`)
  → one Postgres adapter to keep in step. AGENTS.md 第 4 用业界标准做法 +
  第 8 低冗余。

The pool is not exported as a module-global so that tests can spin up
their own pool against TEST_DATABASE_URL without singleton interference.
Routes / services hold a reference passed in at construction time.
"""

from __future__ import annotations

import logging

from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

logger = logging.getLogger(__name__)


async def open_pool(*, dsn: str, min_size: int = 1, max_size: int = 12) -> AsyncConnectionPool:
    """Open and warm an async pool. Caller owns shutdown via `pool.close()`.

    pinai_db is service-agnostic — it never reads any service's config. The DSN
    and pool sizes are injected by the owner of the pool lifecycle (the web
    app's lifespan resolves them from its own web settings and passes them in).

    Args:
        dsn: connection string (caller resolves from its own settings/env).
        min_size: pool floor — connections kept open even when idle.
        max_size: pool ceiling.

    Raises RuntimeError if `dsn` is empty (web won't boot without DB).
    """
    if not dsn:
        msg = "DATABASE_URL not set; web process needs a DB connection"
        raise RuntimeError(msg)

    # Stale-connection protection — see chat/runtime/checkpoint.py for
    # the same three-layer pattern + rationale (TCP keepalive + tcp
    # user timeout + max_idle proactive recycle + check on borrow).
    # Web pool sees enough polling traffic that idle conns rarely sit
    # long enough to go stale, but the same defenses cost nothing and
    # keep behavior identical between the two pools.
    pool = AsyncConnectionPool(
        conninfo=dsn,
        min_size=min_size,
        max_size=max_size,
        max_idle=60,
        kwargs={
            "row_factory": dict_row,
            "keepalives": 1,
            "keepalives_idle": 15,
            "keepalives_interval": 5,
            "keepalives_count": 3,
            "connect_timeout": 5,
            "tcp_user_timeout": 10000,
        },
        check=AsyncConnectionPool.check_connection,
        # Lazy open — caller decides when to actually connect (lifespan
        # startup) so import-time side effects stay zero.
        open=False,
    )
    await pool.open()
    # Sanity-check the connection — fail fast on bad DSN rather than
    # waiting for the first real query.
    async with pool.connection() as conn:
        await conn.execute("SELECT 1")
    logger.info("web pg pool opened (max=%d)", pool.max_size)
    return pool


async def close_pool(pool: AsyncConnectionPool) -> None:
    await pool.close()
    logger.info("web pg pool closed")
