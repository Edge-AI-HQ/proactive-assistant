"""PersonalSignalsRepository — list_recent total contract.

Locks the COUNT(*) OVER () behavior so future filter additions to
list_recent don't silently desync the page slice from the total — that
desync is exactly what made `Profile → Signals N open` show the page
size (12) instead of the real count.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from pinai_agents.web.db.repositories.personal_signals import (
    IngestSignalInput,
    PersonalSignalsRepository,
)
from pinai_agents.web.db.rls import user_scoped_tx


def _now_offset(seconds: int) -> datetime:
    return datetime.now(UTC) - timedelta(seconds=seconds)


@pytest.mark.asyncio
async def test_list_recent_total_tracks_filters(pool, user_ids):
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        repo = PersonalSignalsRepository(user_a, conn)
        # 3 open + 1 consumed + 1 archived = 5 total
        for i, (status, kind) in enumerate([
            ("open", "calendar"),
            ("open", "calendar"),
            ("open", "email"),
            ("consumed", "email"),
            ("archived", "calendar"),
        ]):
            row = await repo.ingest_one(IngestSignalInput(
                id=f"sig_{i}", kind=kind,
                title=f"t{i}", summary=f"s{i}",
                occurred_at=_now_offset(i * 10),
                source="test",
            ))
            # ingest_one always writes status='open'; flip the rest by hand
            # so each test assertion has a known mix to filter against.
            if status == "consumed":
                await repo.mark_consumed(row.id, run_id="run_x")
            elif status == "archived":
                await repo.archive(row.id)

    async with user_scoped_tx(pool, user_a) as conn:
        repo = PersonalSignalsRepository(user_a, conn)

        # Default status='open' → 3 rows, total=3.
        rows, total = await repo.list_recent()
        assert len(rows) == 3
        assert total == 3

        # status='all' (None) → all 5, total=5.
        all_rows, all_total = await repo.list_recent(status=None)
        assert len(all_rows) == 5
        assert all_total == 5

        # kind filter — open + calendar = 2.
        cal_rows, cal_total = await repo.list_recent(kind="calendar")
        assert len(cal_rows) == 2
        assert cal_total == 2

        # Pagination: total stays at the filter total even when the page
        # is smaller than the result set. This is the regression that hid
        # 250+ signals behind a "12 open" UI metric.
        page, page_total = await repo.list_recent(status=None, limit=2, offset=0)
        assert len(page) == 2
        assert page_total == 5

        # Empty page → total=0 (documented edge case; frontend re-clamps).
        empty, empty_total = await repo.list_recent(status="archived", kind="email")
        assert empty == []
        assert empty_total == 0
