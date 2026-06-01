"""Per-request RLS context.

Repository code never writes raw SQL without going through this module —
the `SET LOCAL app.user_id` is what makes the policies in 023_pai_rls.sql
fire. Without it, the service_role catch-all kicks in and RLS becomes a
no-op (which is fine for ops / migrations, but defeats defense-in-depth
for normal API requests).

Usage pattern:

    async with user_scoped_tx(pool, user_id) as conn:
        rows = await conn.execute("SELECT * FROM pai_memory")

The context manager opens a transaction, sets app.user_id, yields the
connection, and commits on success / rolls back on error. Caller does
NOT manage transactions explicitly — every request is one logical unit.
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import cast

from psycopg import AsyncConnection
from psycopg.rows import DictRow
from psycopg_pool import AsyncConnectionPool

logger = logging.getLogger(__name__)


def _validate_user_id(user_id: int) -> None:
    """Defensive parse. user_id MUST be a positive int — Postgres BIGINT."""
    if not isinstance(user_id, int) or user_id <= 0:
        msg = f"user_id must be a positive int, got {user_id!r}"
        raise ValueError(msg)


@asynccontextmanager
async def user_scoped_tx(
    pool: AsyncConnectionPool,
    user_id: int,
) -> AsyncIterator[AsyncConnection[DictRow]]:
    """Acquire a connection, BEGIN, SET LOCAL app.user_id, yield.

    On exit: COMMIT on clean exit, ROLLBACK on exception. The pool's
    connection is returned regardless. autocommit is left at psycopg's
    default (off) so SET LOCAL is scoped to this transaction.
    """
    _validate_user_id(user_id)
    async with pool.connection() as conn, conn.transaction():
        # set_config(name, value, is_local=true) is parameterizable;
        # `SET LOCAL app.user_id = $1` is NOT — Postgres SET only accepts
        # literal values. set_config has identical SET LOCAL semantics
        # (reverts at transaction end, no leak to pool).
        await conn.execute(
            "SELECT set_config('app.user_id', %s, true)",
            (str(user_id),),
        )
        # The web pool is configured with row_factory=dict_row (see
        # db/pool.py), so every borrowed connection yields dict rows at
        # runtime. The pool/connection type can't carry that through, so
        # assert it once here at the single DB-access boundary — downstream
        # repositories then see correctly-typed dict cursors.
        yield cast("AsyncConnection[DictRow]", conn)


@asynccontextmanager
async def service_tx(
    pool: AsyncConnectionPool,
) -> AsyncIterator[AsyncConnection[DictRow]]:
    """Acquire a connection WITHOUT user_id scope. Use for ops / scheduler /
    migrations — caller takes responsibility for not leaking cross-user
    data.

    The 023_pai_rls.sql service_role catch-all triggers because
    app.user_id is not set, so all rows are visible. Use sparingly and
    only from code that doesn't have a user context yet (e.g. scheduler
    tick scanning all users' tasks).
    """
    async with pool.connection() as conn, conn.transaction():
        # See user_scoped_tx — pool is row_factory=dict_row at runtime.
        yield cast("AsyncConnection[DictRow]", conn)
