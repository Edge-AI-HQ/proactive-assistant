"""user_scoped_tx mechanics + cross-user isolation through Repository.

These assert the *repository* layer (the `WHERE user_id = self._user_id`
in UserScopedRepository) and the transaction-scoping of app.user_id. The
complementary DB-layer guarantee — that RLS policies fire in Postgres even
without a repository WHERE — lives in test_rls_enforced.py.

Test that:
  * SET LOCAL app.user_id is per-transaction (no leakage to next acquire).
  * UserScopedRepository(user_a, conn) refuses to fetch user_b's rows.
"""

from __future__ import annotations

from datetime import UTC, datetime

import pytest
from pinai_api.domains.memory.events.repository import (
    AppendEventInput,
    EventsRepository,
)
from pinai_db.rls import user_scoped_tx


@pytest.mark.asyncio
async def test_user_scoped_tx_sets_app_user_id(pool, user_ids):
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        cur = await conn.execute("SELECT current_setting('app.user_id', true) AS v")
        row = await cur.fetchone()
        assert row["v"] == str(user_a)


@pytest.mark.asyncio
async def test_user_scoped_tx_does_not_leak(pool, user_ids):
    """After one user_scoped_tx, the next acquire should NOT see the prior
    app.user_id (SET LOCAL is transaction-scoped)."""
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        await conn.execute("SELECT 1")
    # Next acquire from the same pool: app.user_id should be unset.
    async with pool.connection() as conn:
        cur = await conn.execute("SELECT current_setting('app.user_id', true) AS v")
        row = await cur.fetchone()
        # SET LOCAL reverts on transaction commit; pool-level setting
        # never had it. Defensive: empty string is OK too (psycopg may
        # normalize None ↔ '').
        assert row["v"] in (None, "")


@pytest.mark.asyncio
async def test_repository_user_id_invariant(pool, user_ids):
    user_a, user_b = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        repo_a = EventsRepository(user_a, conn)
        await repo_a.append(
            AppendEventInput(
                id="evt_a_only",
                source="test",
                event_type="interaction",
                occurred_at=datetime.now(UTC),
                title="A's secret",
                dedupe_key="evt_a_only",
                curated=True,
            )
        )

    async with user_scoped_tx(pool, user_b) as conn:
        repo_b = EventsRepository(user_b, conn)
        # B should not see A's event (Repository WHERE user_id = self._user_id)
        got = await repo_b.get("evt_a_only")
        assert got is None
        # B's own recent events should not include A's row
        rows = await repo_b.search_structured(limit=100)
        assert all(r.id != "evt_a_only" for r in rows)


def test_repository_rejects_invalid_user_id():
    """Construction-time validation."""
    from pinai_db.base import UserScopedRepository

    class _Stub(UserScopedRepository):
        pass

    with pytest.raises(ValueError):
        _Stub(0, conn=None)  # type: ignore[arg-type]
    with pytest.raises(ValueError):
        _Stub(-1, conn=None)  # type: ignore[arg-type]
    with pytest.raises(ValueError):
        _Stub("1", conn=None)  # type: ignore[arg-type]
