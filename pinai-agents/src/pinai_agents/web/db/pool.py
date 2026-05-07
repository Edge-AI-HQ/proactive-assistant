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

from ...config import get_web_settings

logger = logging.getLogger(__name__)


async def open_pool(*, dsn: str | None = None, max_size: int | None = None) -> AsyncConnectionPool:
    """Open and warm an async pool. Caller owns shutdown via `pool.close()`.

    Args:
        dsn: override connection string. Defaults to web settings supabase_db_url.
        max_size: override pool ceiling. Defaults to web settings.

    Raises RuntimeError if no DSN is configured (web won't boot without DB).
    """
    settings = get_web_settings()
    conninfo = dsn or settings.supabase_db_url
    if not conninfo:
        msg = "SUPABASE_DB_URL not set; web process needs a DB connection"
        raise RuntimeError(msg)

    pool = AsyncConnectionPool(
        conninfo=conninfo,
        min_size=settings.db_pool_min,
        max_size=max_size or settings.db_pool_max,
        kwargs={"row_factory": dict_row},
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
