"""RLS is actually enforced at the DB layer — not just repository WHEREs.

This is the test the old test_rls.py could never be: it asserts the
023_pai_rls.sql policies *fire in Postgres*, independent of any repository's
`WHERE user_id`. The key is connecting as a role that does NOT have
BYPASSRLS.

The app pool (conftest `pool`) connects as the `postgres` superuser, which
bypasses RLS — so a superuser SELECT is the "today, isolation is only the
repository WHERE" baseline and MUST still see everyone's rows (regression
guard against someone assuming this is already fixed). The enforced behavior
is only visible after `SET LOCAL ROLE pai_app` (the non-BYPASSRLS role from
104_pai_app_role.sql) + setting app.user_id, which is exactly what
`user_scoped_tx` does in production.

All assertions use raw SQL with NO user_id filter, so the only thing that
can scope the result is the RLS policy itself.
"""

from __future__ import annotations

import uuid

import pytest
from psycopg.errors import InsufficientPrivilege


async def _insert_event(conn, user_id: int, event_id: str) -> None:
    """Insert one pai_events row as the superuser (bypasses RLS for setup).

    pai_events replaced the retired pai_memory; it carries the same
    `app.user_id` RLS policy (111_pai_events.sql), so it's the equivalent
    user-scoped carrier for asserting isolation fires in Postgres.
    """
    await conn.execute(
        """
        INSERT INTO pai_events
          (user_id, id, source, event_type, occurred_at, dedupe_key)
        VALUES (%s, %s, %s, %s, NOW(), %s)
        """,
        (user_id, event_id, "test", "fact", f"dk_{event_id}"),
    )


@pytest.mark.asyncio
async def test_pai_app_role_scopes_select_to_app_user_id(pool, user_ids):
    """SET ROLE pai_app + app.user_id=A → raw SELECT returns only A's rows."""
    user_a, user_b = user_ids
    ev_a = f"ev_a_{uuid.uuid4().hex[:8]}"
    ev_b = f"ev_b_{uuid.uuid4().hex[:8]}"

    async with pool.connection() as conn:
        # Setup as superuser (RLS bypassed) — give A and B one row each.
        async with conn.transaction():
            await _insert_event(conn, user_a, ev_a)
            await _insert_event(conn, user_b, ev_b)

        # Enforced path: pai_app + app.user_id=A. Raw SELECT, no WHERE.
        async with conn.transaction():
            await conn.execute("SET LOCAL ROLE pai_app")
            await conn.execute("SELECT set_config('app.user_id', %s, true)", (str(user_a),))
            cur = await conn.execute(
                "SELECT id FROM pai_events WHERE id IN (%s, %s)",
                (ev_a, ev_b),
            )
            ids = {r["id"] for r in await cur.fetchall()}
        assert ids == {ev_a}, "RLS must hide B's row from A's pai_app context"


@pytest.mark.asyncio
async def test_pai_app_role_without_user_id_sees_nothing(pool, user_ids):
    """SET ROLE pai_app but NO app.user_id → fail closed (0 rows), not leak.

    This is the defense-in-depth payoff: a code path that forgets to set
    app.user_id under pai_app reads nobody's data instead of everybody's.
    """
    user_a, user_b = user_ids
    ev_a = f"ev_a_{uuid.uuid4().hex[:8]}"
    ev_b = f"ev_b_{uuid.uuid4().hex[:8]}"

    async with pool.connection() as conn:
        async with conn.transaction():
            await _insert_event(conn, user_a, ev_a)
            await _insert_event(conn, user_b, ev_b)

        async with conn.transaction():
            await conn.execute("SET LOCAL ROLE pai_app")
            # Deliberately do NOT set app.user_id.
            cur = await conn.execute(
                "SELECT id FROM pai_events WHERE id IN (%s, %s)",
                (ev_a, ev_b),
            )
            ids = {r["id"] for r in await cur.fetchall()}
        assert ids == set(), "missing app.user_id under pai_app must fail closed"


@pytest.mark.asyncio
async def test_pai_app_role_insert_for_other_user_rejected(pool, user_ids):
    """SET ROLE pai_app + app.user_id=A, INSERT a row for B → WITH CHECK denies."""
    user_a, user_b = user_ids
    ev_x = f"ev_x_{uuid.uuid4().hex[:8]}"

    async with pool.connection() as conn:
        with pytest.raises(InsufficientPrivilege):
            async with conn.transaction():
                await conn.execute("SET LOCAL ROLE pai_app")
                await conn.execute("SELECT set_config('app.user_id', %s, true)", (str(user_a),))
                # user_id=B while app.user_id=A → violates WITH CHECK.
                await _insert_event(conn, user_b, ev_x)


@pytest.mark.asyncio
async def test_superuser_still_sees_all_rows(pool, user_ids):
    """Regression guard: WITHOUT SET ROLE, the superuser sees BOTH rows.

    Proves today's isolation is only the repository WHERE — RLS does nothing
    on a BYPASSRLS connection. If this ever starts returning one row, someone
    changed the pool to connect as a non-superuser and this whole file's
    assumptions (and the conftest `pool`) need revisiting.
    """
    user_a, user_b = user_ids
    ev_a = f"ev_a_{uuid.uuid4().hex[:8]}"
    ev_b = f"ev_b_{uuid.uuid4().hex[:8]}"

    async with pool.connection() as conn:
        async with conn.transaction():
            await _insert_event(conn, user_a, ev_a)
            await _insert_event(conn, user_b, ev_b)

        async with conn.transaction():
            # No SET ROLE: still the superuser. app.user_id set to A to show
            # it is ignored under BYPASSRLS.
            await conn.execute("SELECT set_config('app.user_id', %s, true)", (str(user_a),))
            cur = await conn.execute(
                "SELECT id FROM pai_events WHERE id IN (%s, %s)",
                (ev_a, ev_b),
            )
            ids = {r["id"] for r in await cur.fetchall()}
        assert ids == {ev_a, ev_b}, "superuser must bypass RLS (BYPASSRLS baseline)"
