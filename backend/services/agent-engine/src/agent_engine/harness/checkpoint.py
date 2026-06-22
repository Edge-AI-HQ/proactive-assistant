"""LangGraph Postgres checkpointer.

TWO process-wide AsyncConnectionPools + AsyncPostgresSavers, opened on FastAPI
startup, closed on shutdown:

  * interactive — main + card chat. Larger share + a SHORT getconn timeout so a
    starved interactive turn fails fast (the user sees an error) instead of
    hanging until the worker's 600s read timeout.
  * background — proactive heartbeat (+ future batch persistent threads). The
    proactive thread's checkpoint history is large and slow to read
    (`aget_delta_channel_history` walks the delta chain), so isolating it onto
    its OWN pool means a slow proactive read can never occupy every connection
    and starve interactive chat. This is the fix for the 2026-06-07 main-chat
    hang: a single shared max_size=10 pool, proactive reads holding all 10
    connections, interactive turns blocking forever in `pool.getconn()`.

Both savers share the same `langgraph` schema (same tables); only their
connection pools differ. The pool is configured with `search_path` set to a
dedicated schema (default `langgraph`) so the saver's tables
(`checkpoints`, `checkpoint_blobs`, `checkpoint_writes`, `checkpoint_migrations`)
don't pollute `public`.

Lifecycle is owned by `main.lifespan` to guarantee a single pool-pair per
process.
"""

from __future__ import annotations

import logging
from typing import cast

from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
from psycopg import AsyncConnection
from psycopg.rows import DictRow, dict_row
from psycopg_pool import AsyncConnectionPool

from agent_engine.config import get_chat_settings

settings = get_chat_settings()

logger = logging.getLogger(__name__)

# Pool sizing. Interactive (main/card) gets the larger share + a short getconn
# timeout so a starved turn fails fast instead of hanging. Background
# (proactive) is smaller and more patient — a slow heartbeat read waiting for a
# connection is fine; it's isolated and never blocks interactive chat.
_INTERACTIVE_MAX_SIZE = 15
_INTERACTIVE_TIMEOUT = 10.0
_BACKGROUND_MAX_SIZE = 6
_BACKGROUND_TIMEOUT = 30.0

# Module-scoped singletons (one pair). Initialized by `init_checkpointer()`
# during FastAPI lifespan startup; closed by `close_checkpointer()` on shutdown.
_interactive_pool: AsyncConnectionPool | None = None
_interactive_checkpointer: AsyncPostgresSaver | None = None
_background_pool: AsyncConnectionPool | None = None
_background_checkpointer: AsyncPostgresSaver | None = None


def _is_safe_identifier(name: str) -> bool:
    return bool(name) and all(c.isalnum() or c == "_" for c in name) and not name[0].isdigit()


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


async def _open_pool(
    *, max_size: int, timeout: float, options: str, min_size: int = 0
) -> AsyncConnectionPool:
    """Open one connection pool with the shared stale-connection hardening.

    Stale-connection protection — three independent layers because
    cloud-Postgres + idle-pool combinations can each fail differently:
      1. TCP keepalive (kernel-level): probes start after 15s idle, socket
         errored within ~30s of detecting a dead peer.
      2. tcp_user_timeout: hard cap on outstanding TCP packets without ack —
         any pool op on a dead socket bubbles up within 10s, not a multi-minute
         hang.
      3. max_idle=60: proactively recycle conns idle > 60s, shorter than the
         typical fly-NAT idle window. The pool never shrinks below min_size
         (psycopg_pool ShrinkPool), so a min_size conn is NOT recycled.
    `min_size=1` (interactive) keeps one warm connection so a turn after an
    idle gap doesn't pay TLS setup (~130ms measured). That long-lived conn is
    kept alive by layer 1 (keepalive probes also refresh the NAT flow); if it
    still dies, the `check=` borrow guard below discards it and dials fresh —
    i.e. the worst case equals today's cold dial, never a hung turn.
    `min_size=0` (background) skips the always-on conn where latency doesn't
    matter.
    `timeout` caps how long getconn waits for a free connection before raising
    PoolTimeout — the fast-fail that stops a starved pool from hanging a turn.
    `check=` is a final SELECT-1 borrow guard.
    """
    assert settings.database_url
    pool = AsyncConnectionPool(
        conninfo=settings.database_url,
        min_size=min_size,
        max_size=max_size,
        max_idle=60,
        timeout=timeout,
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
    await pool.open()
    return pool


async def init_checkpointer() -> AsyncPostgresSaver:
    """Open both pools, ensure schema, run AsyncPostgresSaver.setup() once.

    Idempotent: returns the existing interactive checkpointer on subsequent
    calls. Returns the interactive saver (the default main+card one).
    """
    global _interactive_pool, _interactive_checkpointer
    global _background_pool, _background_checkpointer

    if _interactive_checkpointer is not None:
        return _interactive_checkpointer

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

    # Interactive pool first: it owns schema creation + saver.setup() (the DDL
    # that creates the shared checkpoint tables).
    _interactive_pool = await _open_pool(
        max_size=_INTERACTIVE_MAX_SIZE,
        timeout=_INTERACTIVE_TIMEOUT,
        options=options,
        min_size=1,
    )
    await _ensure_schema(_interactive_pool, schema)
    # The pool yields dict rows (kwargs row_factory=dict_row) — the type
    # AsyncPostgresSaver requires. The pool type can't carry row_factory
    # through, so assert it at this single boundary (mirrors web/db/rls.py).
    _interactive_checkpointer = AsyncPostgresSaver(
        cast("AsyncConnectionPool[AsyncConnection[DictRow]]", _interactive_pool),
    )
    await _interactive_checkpointer.setup()

    # Background pool: same schema/tables (created above), separate connections
    # so a slow proactive checkpoint read can't starve interactive chat. No
    # setup() — the tables already exist.
    _background_pool = await _open_pool(
        max_size=_BACKGROUND_MAX_SIZE, timeout=_BACKGROUND_TIMEOUT, options=options
    )
    _background_checkpointer = AsyncPostgresSaver(
        cast("AsyncConnectionPool[AsyncConnection[DictRow]]", _background_pool),
    )

    logger.info(
        "langgraph checkpointers ready (schema=%s interactive_max=%d background_max=%d)",
        schema,
        _INTERACTIVE_MAX_SIZE,
        _BACKGROUND_MAX_SIZE,
    )
    return _interactive_checkpointer


async def close_checkpointer() -> None:
    """Close both pools. Called by FastAPI lifespan shutdown."""
    global _interactive_pool, _interactive_checkpointer
    global _background_pool, _background_checkpointer
    for pool in (_interactive_pool, _background_pool):
        if pool is not None:
            await pool.close()
    logger.info("langgraph checkpointer pools closed")
    _interactive_pool = None
    _interactive_checkpointer = None
    _background_pool = None
    _background_checkpointer = None


def get_checkpointer(*, background: bool = False) -> AsyncPostgresSaver:
    """Return the running checkpointer. `background=True` selects the isolated
    proactive/batch pool; the default is the interactive (main/card) pool.

    Raises if init_checkpointer() wasn't called (i.e. the FastAPI lifespan
    didn't run, or DATABASE_URL is missing).
    """
    cp = _background_checkpointer if background else _interactive_checkpointer
    if cp is None:
        msg = "Checkpointer not initialized; ensure FastAPI lifespan has run"
        raise RuntimeError(msg)
    return cp
