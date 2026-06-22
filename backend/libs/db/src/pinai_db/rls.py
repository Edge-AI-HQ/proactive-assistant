"""Per-request RLS context.

Repository code never writes raw SQL without going through this module.
Two things make the policies in 023_pai_rls.sql actually fire:

  1. `SET LOCAL ROLE pai_app` — the app pool still connects as the
     `postgres` superuser, which has BYPASSRLS and ignores every policy
     (and even FORCE). Downgrading to the non-BYPASSRLS `pai_app` role
     (104_pai_app_role.sql) for the duration of the transaction is what
     subjects the connection to RLS at all. The role RESETs at COMMIT/
     ROLLBACK, so the pooled connection is never left downgraded.
  2. `SET LOCAL app.user_id` — selects which rows are visible via the
     per-user policy `user_id = current_setting('app.user_id')::bigint`.

Without (1) RLS is a complete no-op (BYPASSRLS); without (2) the per-user
policy matches nothing and the transaction sees zero rows — a forgotten
app.user_id now fails closed instead of leaking.

Usage pattern:

    async with user_scoped_tx(pool, user_id) as conn:
        rows = await conn.execute("SELECT * FROM pai_memory")

The context manager opens a transaction, downgrades the role, sets
app.user_id, yields the connection, and commits on success / rolls back on
error. Caller does NOT manage transactions explicitly — every request is
one logical unit.
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
    """Acquire a connection, BEGIN, downgrade role, SET LOCAL app.user_id, yield.

    On exit: COMMIT on clean exit, ROLLBACK on exception. The pool's
    connection is returned regardless. autocommit is left at psycopg's
    default (off) so SET LOCAL ROLE / SET LOCAL are scoped to this
    transaction and reset when it ends (no leak back to the pool).
    """
    _validate_user_id(user_id)
    async with pool.connection() as conn, conn.transaction():
        # Downgrade from the BYPASSRLS superuser the pool connects as to the
        # non-BYPASSRLS pai_app role (104_pai_app_role.sql) so RLS policies
        # are actually evaluated for this transaction. Role name is a fixed
        # literal (not user input) — SET ROLE can't be parameterized.
        await conn.execute("SET LOCAL ROLE pai_app")
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

    Downgrades to the `service_role` role for the transaction so the
    023_pai_rls.sql service_role fallback policies fire: those grant
    cross-user visibility precisely when app.user_id is unset, which is the
    case here. (Like user_scoped_tx, this also means we are NOT relying on
    the superuser's BYPASSRLS — the role RESETs at transaction end.) Use
    sparingly and only from code that doesn't have a user context yet
    (e.g. scheduler tick scanning all users' tasks, webhook handlers).
    """
    async with pool.connection() as conn, conn.transaction():
        # Downgrade to service_role so the fallback policies (FOR ALL TO
        # service_role, gated on app.user_id being unset) apply. Fixed
        # literal — SET ROLE can't be parameterized.
        await conn.execute("SET LOCAL ROLE service_role")
        # See user_scoped_tx — pool is row_factory=dict_row at runtime.
        yield cast("AsyncConnection[DictRow]", conn)
