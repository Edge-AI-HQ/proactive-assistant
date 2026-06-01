"""ConnectorsRepository — pai_connector_sync_cursors CRUD.

Cursor get/set is the heart of incremental sync; bugs here mean either
re-fetching everything every run (cursor never advancing) or missing
events (cursor jumping past windows). Tests pin the contract.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from pinai_agents.web.db.repositories.connectors import ConnectorsRepository
from pinai_agents.web.db.rls import user_scoped_tx


@pytest.mark.asyncio
async def test_get_cursor_returns_none_when_absent(pool, user_ids):
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        repo = ConnectorsRepository(user_a, conn)
        cursor = await repo.get_cursor(
            toolkit="github",
            connected_account_id="cid_x",
        )
    assert cursor is None


@pytest.mark.asyncio
async def test_set_then_get_cursor_roundtrip(pool, user_ids):
    user_a, _ = user_ids
    ts = datetime(2026, 5, 1, 12, 0, 0, tzinfo=UTC)

    async with user_scoped_tx(pool, user_a) as conn:
        await ConnectorsRepository(user_a, conn).set_cursor(
            toolkit="github",
            connected_account_id="cid_x",
            last_synced_at=ts,
            toolkit_cursor={"page": 3, "etag": "abc"},
        )

    async with user_scoped_tx(pool, user_a) as conn:
        cursor = await ConnectorsRepository(user_a, conn).get_cursor(
            toolkit="github",
            connected_account_id="cid_x",
        )

    assert cursor is not None
    assert cursor.toolkit == "github"
    assert cursor.connected_account_id == "cid_x"
    assert cursor.last_synced_at == ts
    assert cursor.toolkit_cursor == {"page": 3, "etag": "abc"}


@pytest.mark.asyncio
async def test_set_cursor_upserts(pool, user_ids):
    """Second set_cursor on the same key advances last_synced_at."""
    user_a, _ = user_ids
    t1 = datetime(2026, 5, 1, tzinfo=UTC)
    t2 = t1 + timedelta(hours=2)

    async with user_scoped_tx(pool, user_a) as conn:
        await ConnectorsRepository(user_a, conn).set_cursor(
            toolkit="slack",
            connected_account_id="cid_y",
            last_synced_at=t1,
        )

    async with user_scoped_tx(pool, user_a) as conn:
        await ConnectorsRepository(user_a, conn).set_cursor(
            toolkit="slack",
            connected_account_id="cid_y",
            last_synced_at=t2,
        )

    async with user_scoped_tx(pool, user_a) as conn:
        cursor = await ConnectorsRepository(user_a, conn).get_cursor(
            toolkit="slack",
            connected_account_id="cid_y",
        )
    assert cursor is not None
    assert cursor.last_synced_at == t2


@pytest.mark.asyncio
async def test_get_cursor_isolated_by_user(pool, user_ids):
    """user_a's cursor is invisible to user_b (RLS)."""
    user_a, user_b = user_ids
    ts = datetime(2026, 5, 1, tzinfo=UTC)

    async with user_scoped_tx(pool, user_a) as conn:
        await ConnectorsRepository(user_a, conn).set_cursor(
            toolkit="github",
            connected_account_id="cid_shared",
            last_synced_at=ts,
        )

    async with user_scoped_tx(pool, user_b) as conn:
        cursor = await ConnectorsRepository(user_b, conn).get_cursor(
            toolkit="github",
            connected_account_id="cid_shared",
        )
    assert cursor is None


@pytest.mark.asyncio
async def test_get_cursor_isolated_by_account(pool, user_ids):
    """Same toolkit, different connectedAccountId → distinct cursors."""
    user_a, _ = user_ids
    t1 = datetime(2026, 5, 1, tzinfo=UTC)
    t2 = t1 + timedelta(hours=4)

    async with user_scoped_tx(pool, user_a) as conn:
        repo = ConnectorsRepository(user_a, conn)
        await repo.set_cursor(
            toolkit="github",
            connected_account_id="cid_1",
            last_synced_at=t1,
        )
        await repo.set_cursor(
            toolkit="github",
            connected_account_id="cid_2",
            last_synced_at=t2,
        )

    async with user_scoped_tx(pool, user_a) as conn:
        repo = ConnectorsRepository(user_a, conn)
        c1 = await repo.get_cursor(
            toolkit="github",
            connected_account_id="cid_1",
        )
        c2 = await repo.get_cursor(
            toolkit="github",
            connected_account_id="cid_2",
        )

    assert c1 is not None and c1.last_synced_at == t1
    assert c2 is not None and c2.last_synced_at == t2
