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


def _transcript_candidate_input(
    *,
    signal_id: str,
    raw_ref_count: int,
    content_hash: str,
    summary: str,
    dedupe_key: str | None = None,
) -> IngestSignalInput:
    canonical_key = (
        "ambient:candidate_window:device-1:"
        "2026-05-15:transcript_session:win-transcript"
    )
    return IngestSignalInput(
        id=signal_id,
        kind="ambient.candidate_window",
        title="Ambient transcript_session window",
        summary=summary,
        occurred_at=_now_offset(0),
        payload={
            "window_type": "transcript_session",
            "local_date": "2026-05-15",
            "local_window_id": "win-transcript",
            "raw_ref_count": raw_ref_count,
            "content_hash": content_hash,
        },
        salience=0.5,
        confidence=0.5,
        dedupe_key=dedupe_key or canonical_key,
        source="device",
        device_id="device-1",
    )


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


@pytest.mark.asyncio
async def test_transcript_candidate_window_latest_upsert_preserves_consumed_on_noop(
    pool,
    user_ids,
):
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        repo = PersonalSignalsRepository(user_a, conn)
        inserted = await repo.ingest_transcript_candidate_window_latest(
            _transcript_candidate_input(
                signal_id="candidate-first",
                raw_ref_count=5,
                content_hash="hash-5",
                summary="five chunks",
            ),
        )
        assert inserted.changed is True
        assert inserted.row.status == "open"
        assert await repo.mark_consumed(inserted.row.id, run_id="run-a") is True

        exact = await repo.ingest_transcript_candidate_window_latest(
            _transcript_candidate_input(
                signal_id="candidate-exact",
                raw_ref_count=5,
                content_hash="hash-5",
                summary="exact duplicate should not reopen",
            ),
        )
        assert exact.changed is False
        assert exact.row.status == "consumed"
        assert exact.row.summary == "five chunks"

        stale = await repo.ingest_transcript_candidate_window_latest(
            _transcript_candidate_input(
                signal_id="candidate-stale",
                raw_ref_count=3,
                content_hash="hash-3",
                summary="stale duplicate should not overwrite",
            ),
        )
        assert stale.changed is False
        assert stale.row.status == "consumed"
        assert stale.row.summary == "five chunks"

        changed_hash = await repo.ingest_transcript_candidate_window_latest(
            _transcript_candidate_input(
                signal_id="candidate-hash",
                raw_ref_count=5,
                content_hash="hash-5b",
                summary="same count but new content hash",
            ),
        )
        assert changed_hash.changed is True
        assert changed_hash.row.status == "open"
        assert changed_hash.row.consumed_by_run_id is None
        assert changed_hash.row.summary == "same count but new content hash"


@pytest.mark.asyncio
async def test_transcript_candidate_window_same_id_duplicate_is_idempotent(
    pool,
    user_ids,
):
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        repo = PersonalSignalsRepository(user_a, conn)
        old = await repo.ingest_one(
            _transcript_candidate_input(
                signal_id="candidate-same-id",
                raw_ref_count=5,
                content_hash="hash-5",
                summary="already stored",
                dedupe_key="old-client-key:candidate-same-id",
            ),
        )
        assert await repo.mark_consumed(old.id, run_id="run-a") is True

        exact = await repo.ingest_transcript_candidate_window_latest(
            _transcript_candidate_input(
                signal_id="candidate-same-id",
                raw_ref_count=5,
                content_hash="hash-5",
                summary="retry should not reopen",
            ),
        )

        assert exact.changed is False
        assert exact.row.status == "consumed"
        assert exact.row.summary == "already stored"
        assert exact.row.dedupe_key == (
            "ambient:candidate_window:device-1:"
            "2026-05-15:transcript_session:win-transcript"
        )


@pytest.mark.asyncio
async def test_transcript_candidate_window_same_id_fresher_retry_updates(
    pool,
    user_ids,
):
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        repo = PersonalSignalsRepository(user_a, conn)
        old = await repo.ingest_one(
            _transcript_candidate_input(
                signal_id="candidate-same-id-fresh",
                raw_ref_count=2,
                content_hash="hash-2",
                summary="two chunks",
                dedupe_key="old-client-key:candidate-same-id-fresh",
            ),
        )
        assert await repo.mark_consumed(old.id, run_id="run-a") is True

        latest = await repo.ingest_transcript_candidate_window_latest(
            _transcript_candidate_input(
                signal_id="candidate-same-id-fresh",
                raw_ref_count=5,
                content_hash="hash-5",
                summary="five chunks",
            ),
        )

        assert latest.changed is True
        assert latest.row.status == "open"
        assert latest.row.consumed_by_run_id is None
        assert latest.row.summary == "five chunks"
        assert latest.row.dedupe_key == (
            "ambient:candidate_window:device-1:"
            "2026-05-15:transcript_session:win-transcript"
        )
