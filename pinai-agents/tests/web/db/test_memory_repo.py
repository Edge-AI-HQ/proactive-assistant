"""MemoryRepository CRUD + state machine."""

from __future__ import annotations

import pytest

from pinai_agents.web.db.repositories.memory import (
    AddMemoryInput,
    MemoryRepository,
)
from pinai_agents.web.db.rls import user_scoped_tx


@pytest.mark.asyncio
async def test_add_get_roundtrip(pool, user_ids):
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        repo = MemoryRepository(user_a, conn)
        added = await repo.add(
            AddMemoryInput(
                id="mem_1",
                text="hello world",
                source="test",
                subject="work",
                quality=0.7,
                tags=["foo", "bar"],
            )
        )
    assert added.id == "mem_1"
    assert added.status == "active"
    assert added.tags == ["foo", "bar"]

    async with user_scoped_tx(pool, user_a) as conn:
        repo = MemoryRepository(user_a, conn)
        got = await repo.get("mem_1")
        assert got is not None
        assert got.text == "hello world"
        assert got.subject == "work"


@pytest.mark.asyncio
async def test_list_active_filters(pool, user_ids):
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        repo = MemoryRepository(user_a, conn)
        await repo.add(AddMemoryInput(id="m_hi", text="hi q", source="t", quality=0.9))
        await repo.add(AddMemoryInput(id="m_lo", text="lo q", source="t", quality=0.2))
        await repo.add(
            AddMemoryInput(id="m_work", text="work item", source="t", subject="work", quality=0.5)
        )

    async with user_scoped_tx(pool, user_a) as conn:
        repo = MemoryRepository(user_a, conn)

        # min_quality filters out m_lo
        high, total_high = await repo.list_active(min_quality=0.5)
        ids_high = {m.id for m in high}
        assert "m_hi" in ids_high
        assert "m_work" in ids_high
        assert "m_lo" not in ids_high
        # total tracks the filter, not the page slice — locks down the
        # COUNT(*) OVER() contract so future filter additions don't
        # silently desync.
        assert total_high == len(high) == 2

        # subject filter
        only_work, total_work = await repo.list_active(subject="work")
        assert {m.id for m in only_work} == {"m_work"}
        assert total_work == 1

        # pagination: total stays at the filter total even when limited.
        page1, total_all = await repo.list_active(min_quality=0.0, limit=1, offset=0)
        assert len(page1) == 1
        assert total_all == 3


@pytest.mark.asyncio
async def test_archive_and_supersede_state_machine(pool, user_ids):
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        repo = MemoryRepository(user_a, conn)
        await repo.add(AddMemoryInput(id="m_old", text="old", source="t"))
        await repo.add(AddMemoryInput(id="m_new", text="new", source="t"))
        await repo.add(AddMemoryInput(id="m_dead", text="dead", source="t"))

    # archive m_dead
    async with user_scoped_tx(pool, user_a) as conn:
        repo = MemoryRepository(user_a, conn)
        archived = await repo.archive("m_dead")
        assert archived is not None
        assert archived.status == "archived"
        # second archive: no-op (already archived)
        again = await repo.archive("m_dead")
        assert again is None

    # supersede m_old by m_new
    async with user_scoped_tx(pool, user_a) as conn:
        repo = MemoryRepository(user_a, conn)
        sup = await repo.supersede(old_id="m_old", new_id="m_new")
        assert sup is not None
        assert sup.status == "superseded"
        assert sup.superseded_by == "m_new"

    # active list should now contain only m_new
    async with user_scoped_tx(pool, user_a) as conn:
        repo = MemoryRepository(user_a, conn)
        active, _ = await repo.list_active(min_quality=0.0)
        assert {m.id for m in active} == {"m_new"}


@pytest.mark.asyncio
async def test_bump_reference_appends_run_id_uniquely(pool, user_ids):
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        repo = MemoryRepository(user_a, conn)
        await repo.add(AddMemoryInput(id="m_ref", text="x", source="t"))

    # First bump: count 0 → 1
    async with user_scoped_tx(pool, user_a) as conn:
        repo = MemoryRepository(user_a, conn)
        n = await repo.bump_reference(["m_ref"], "run_one")
        assert n == 1
        got = await repo.get("m_ref")
        assert got is not None
        assert got.reference_count == 1
        assert got.referenced_by_runs == ["run_one"]

    # Second bump same run_id: count goes up but list is dedup'd
    async with user_scoped_tx(pool, user_a) as conn:
        repo = MemoryRepository(user_a, conn)
        await repo.bump_reference(["m_ref"], "run_one")
        got = await repo.get("m_ref")
        assert got is not None
        assert got.reference_count == 2
        assert got.referenced_by_runs == ["run_one"]  # dedup'd

    # Third bump different run_id: count up, list grows
    async with user_scoped_tx(pool, user_a) as conn:
        repo = MemoryRepository(user_a, conn)
        await repo.bump_reference(["m_ref"], "run_two")
        got = await repo.get("m_ref")
        assert got is not None
        assert got.reference_count == 3
        assert set(got.referenced_by_runs) == {"run_one", "run_two"}
