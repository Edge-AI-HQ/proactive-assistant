"""LangGraph Postgres checkpointer.

One process-wide AsyncConnectionPool + AsyncPostgresSaver, opened on FastAPI
startup, closed on shutdown. The pool is configured with `search_path` set
to a dedicated schema (default `langgraph`) so the saver's tables
(`checkpoints`, `checkpoint_blobs`, `checkpoint_writes`, `checkpoint_migrations`)
don't pollute `public` — keeping a clean separation from Step 2's `pai_*`
tables and from existing Supabase identity/billing tables.

Lifecycle is owned by `main.lifespan` to guarantee a single pool per process.
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import Any, cast

from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
from psycopg import AsyncConnection
from psycopg.rows import DictRow, dict_row
from psycopg_pool import AsyncConnectionPool

from ...config import get_chat_settings

settings = get_chat_settings()

logger = logging.getLogger(__name__)

# Module-scoped singletons. Initialized by `init_checkpointer()` during
# FastAPI lifespan startup; closed by `close_checkpointer()` on shutdown.
_pool: AsyncConnectionPool | None = None
_checkpointer: AsyncPostgresSaver | None = None


async def _ensure_schema(pool: AsyncConnectionPool, schema: str) -> None:
    """Idempotent CREATE SCHEMA. AsyncPostgresSaver.setup() runs DDL relative
    to the search_path, so the schema must exist before setup() is called.
    """
    async with pool.connection() as conn:
        # Identifier must not be untrusted user input; we validate against a
        # conservative regex to keep this safe even if config gets reloaded.
        if not _is_safe_identifier(schema):
            msg = f"Refusing to create unsafe schema name: {schema!r}"
            raise ValueError(msg)
        await conn.execute(f'CREATE SCHEMA IF NOT EXISTS "{schema}"')


def _is_safe_identifier(name: str) -> bool:
    return bool(name) and all(c.isalnum() or c == "_" for c in name) and not name[0].isdigit()


async def init_checkpointer() -> AsyncPostgresSaver:
    """Open the pool, ensure schema, run AsyncPostgresSaver.setup().

    Idempotent: returns the existing checkpointer on subsequent calls.
    """
    global _pool, _checkpointer

    if _checkpointer is not None:
        return _checkpointer

    if not settings.database_url:
        msg = "DATABASE_URL is not set; LangGraph checkpointer disabled"
        raise RuntimeError(msg)

    schema = settings.langgraph_schema
    if not _is_safe_identifier(schema):
        msg = f"Unsafe LANGGRAPH_SCHEMA: {schema!r}"
        raise ValueError(msg)

    # search_path: <schema>,public ensures (a) AsyncPostgresSaver DDL targets
    # our schema, (b) any built-in functions resolved via public still work.
    options = f"-c search_path={schema},public"
    # Stale-connection protection — three independent layers because
    # cloud-Postgres + idle-pool combinations can each fail differently:
    #   1. TCP keepalive (kernel-level): probes start after 15s idle,
    #      socket errored within ~30s of detecting a dead peer. Without
    #      this, a borrow that hits a NAT-killed socket hangs for the
    #      full statement_timeout (10+ min) on Linux defaults.
    #   2. tcp_user_timeout: hard cap on outstanding TCP packets without
    #      ack. Any pool operation on a dead socket bubbles up as an
    #      error within 10s instead of multi-minute hangs.
    #   3. max_idle=60: proactively recycle conns idle > 60s, shorter
    #      than the typical fly-NAT idle window (~90-300s) so we never
    #      hand out stale handles in the first place. min_size=0 avoids
    #      the pool re-warming idle conns that immediately re-stale.
    # `check=` is kept as a final SELECT-1 borrow guard; under this
    # config it almost never has anything to recover from.
    _pool = AsyncConnectionPool(
        conninfo=settings.database_url,
        min_size=0,
        max_size=10,
        max_idle=60,
        kwargs={
            "autocommit": True,
            "row_factory": dict_row,
            "options": options,
            "keepalives": 1,
            "keepalives_idle": 15,
            "keepalives_interval": 5,
            "keepalives_count": 3,
            "connect_timeout": 5,
            "tcp_user_timeout": 10000,
        },
        check=AsyncConnectionPool.check_connection,
        open=False,
    )
    await _pool.open()
    await _ensure_schema(_pool, schema)

    # The pool is configured with row_factory=dict_row (kwargs above), so it
    # yields dict rows at runtime — the type AsyncPostgresSaver requires. The
    # pool type can't carry row_factory through, so assert it at this single
    # boundary (mirrors web/db/rls.py).
    _checkpointer = AsyncPostgresSaver(
        cast("AsyncConnectionPool[AsyncConnection[DictRow]]", _pool),
    )
    await _checkpointer.setup()
    logger.info("langgraph checkpointer ready (schema=%s)", schema)
    return _checkpointer


async def close_checkpointer() -> None:
    """Close the pool. Called by FastAPI lifespan shutdown."""
    global _pool, _checkpointer
    if _pool is not None:
        await _pool.close()
        logger.info("langgraph checkpointer pool closed")
    _pool = None
    _checkpointer = None


def get_checkpointer() -> AsyncPostgresSaver:
    """Return the running checkpointer. Raises if init_checkpointer() wasn't
    called (i.e. the FastAPI lifespan didn't run, or DATABASE_URL is missing).
    """
    if _checkpointer is None:
        msg = "Checkpointer not initialized; ensure FastAPI lifespan has run"
        raise RuntimeError(msg)
    return _checkpointer


@asynccontextmanager
async def lifespan_checkpointer() -> Any:
    """Convenience async context manager for app lifespan integration."""
    await init_checkpointer()
    try:
        yield
    finally:
        await close_checkpointer()
