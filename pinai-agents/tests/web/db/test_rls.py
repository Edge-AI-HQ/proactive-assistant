"""user_scoped_tx + cross-user isolation through Repository.

Test that:
  * SET LOCAL app.user_id is per-transaction (no leakage to next acquire).
  * UserScopedRepository(user_a, conn) refuses to fetch user_b's rows.
"""

from __future__ import annotations

import pytest

from pinai_agents.web.db.repositories.memory import (
    AddMemoryInput,
    MemoryRepository,
)
from pinai_agents.web.db.rls import user_scoped_tx


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
        repo_a = MemoryRepository(user_a, conn)
        await repo_a.add(
            AddMemoryInput(
                id="mem_a_only",
                text="A's secret",
                source="test",
                quality=0.8,
            )
        )

    async with user_scoped_tx(pool, user_b) as conn:
        repo_b = MemoryRepository(user_b, conn)
        # B should not see A's memory (Repository WHERE user_id = self._user_id)
        got = await repo_b.get("mem_a_only")
        assert got is None
        # B's own list of active memories should not include A's row
        rows, _ = await repo_b.list_active(min_quality=0.0)
        assert all(r.id != "mem_a_only" for r in rows)


def test_repository_rejects_invalid_user_id():
    """Construction-time validation."""
    from pinai_agents.web.db.repositories.base import UserScopedRepository

    class _Stub(UserScopedRepository):
        pass

    with pytest.raises(ValueError):
        _Stub(0, conn=None)  # type: ignore[arg-type]
    with pytest.raises(ValueError):
        _Stub(-1, conn=None)  # type: ignore[arg-type]
    with pytest.raises(ValueError):
        _Stub("1", conn=None)  # type: ignore[arg-type]
