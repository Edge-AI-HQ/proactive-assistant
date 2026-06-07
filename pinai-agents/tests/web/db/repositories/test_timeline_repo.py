"""TimelineRepository — pai_timeline_events CRUD + windowing + RLS.

Cover the contract the agent layer depends on:
  * upsert is idempotent on dedupe_key, preserves curation state
  * `query()` window scan with default filters strips pending /
    filtered_out / predicted / superseded / low importance
  * `in_progress()` returns interval events covering `at`
  * `supersede()` creates a new row and tombstones the old
  * `get_history()` walks the chain root → current
  * RLS isolates two users
  * pending → curated state transition (no rollback)
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import pytest

from pinai_agents.web.db.repositories.timeline import (
    IngestTimelineEvent,
    TimelineRepository,
)
from pinai_agents.web.db.rls import user_scoped_tx


def _evt_id(prefix: str = "tle") -> str:
    return f"{prefix}_{uuid.uuid4().hex[:16]}"


def _now() -> datetime:
    return datetime.now(UTC)


def _make_event(
    *,
    occurred_at: datetime | None = None,
    end_at: datetime | None = None,
    source: str = "gmail",
    event_type: str = "communication",
    title: str = "Test event",
    importance: float = 0.5,
    is_predicted: bool = False,
    curation_status: str = "curated",
    dedupe_key: str | None = None,
    event_id: str | None = None,
    source_ref: dict | None = None,
) -> IngestTimelineEvent:
    return IngestTimelineEvent(
        id=event_id or _evt_id(),
        occurred_at=occurred_at or _now(),
        end_at=end_at,
        source=source,
        event_type=event_type,
        title=title,
        source_ref=source_ref or {"raw_table": "test", "raw_id": "1"},
        importance=importance,
        is_predicted=is_predicted,
        curation_status=curation_status,
        dedupe_key=dedupe_key,
    )


# ── basic ingest ───────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_upsert_inserts_new_event(pool, user_ids):
    user_a, _ = user_ids
    ev = _make_event(title="Hello", source="gmail")

    async with user_scoped_tx(pool, user_a) as conn:
        row = await TimelineRepository(user_a, conn).upsert_event(ev)

    assert row.id == ev.id
    assert row.title == "Hello"
    assert row.source == "gmail"
    assert row.curation_status == "curated"
    assert row.version == 1
    assert row.superseded_by_id is None
    assert row.supersedes_id is None
    assert row.curated_at is not None


@pytest.mark.asyncio
async def test_upsert_idempotent_on_dedupe_key(pool, user_ids):
    user_a, _ = user_ids
    dk = f"gmail:{uuid.uuid4().hex[:8]}"

    async with user_scoped_tx(pool, user_a) as conn:
        repo = TimelineRepository(user_a, conn)
        first = await repo.upsert_event(_make_event(title="v1", dedupe_key=dk))
        second = await repo.upsert_event(_make_event(title="v2", dedupe_key=dk))

    # Both calls return rows; second updates the first by dedupe_key.
    assert first.id != second.id or first.dedupe_key == second.dedupe_key
    async with user_scoped_tx(pool, user_a) as conn:
        results = await TimelineRepository(user_a, conn).query(
            window_start=_now() - timedelta(hours=1),
            window_end=_now() + timedelta(hours=1),
        )
    # Only one row (dedupe collapsed) — title is the latest.
    matching = [r for r in results if r.dedupe_key == dk]
    assert len(matching) == 1
    assert matching[0].title == "v2"


@pytest.mark.asyncio
async def test_upsert_does_not_downgrade_curated_to_pending(pool, user_ids):
    """Re-ingesting an ambient.utterance after the curator scored it
    must not roll the row back to pending."""
    user_a, _ = user_ids
    dk = f"ambient:utterance:{uuid.uuid4().hex[:8]}"

    async with user_scoped_tx(pool, user_a) as conn:
        repo = TimelineRepository(user_a, conn)
        # First write: pending (ambient ingest path)
        await repo.upsert_event(
            _make_event(
                dedupe_key=dk,
                curation_status="pending",
                importance=0.5,
            )
        )
        # Curator scores it
        row = await repo.query(
            window_start=_now() - timedelta(hours=1),
            window_end=_now() + timedelta(hours=1),
            include_pending=True,
        )
        pending_id = next(r.id for r in row if r.dedupe_key == dk)
        await repo.mark_curated(event_id=pending_id, importance=0.8)
        # Re-ingest pending (e.g. duplicate from outbox retry)
        await repo.upsert_event(
            _make_event(
                dedupe_key=dk,
                curation_status="pending",
                importance=0.5,
            )
        )

    async with user_scoped_tx(pool, user_a) as conn:
        results = await TimelineRepository(user_a, conn).query(
            window_start=_now() - timedelta(hours=1),
            window_end=_now() + timedelta(hours=1),
        )
    matching = [r for r in results if r.dedupe_key == dk]
    assert len(matching) == 1
    assert matching[0].curation_status == "curated"
    assert matching[0].importance == pytest.approx(0.8)


# ── window query ───────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_query_window_returns_chronological_asc(pool, user_ids):
    user_a, _ = user_ids
    now = _now()
    times = [now - timedelta(hours=h) for h in (1, 5, 3)]
    async with user_scoped_tx(pool, user_a) as conn:
        repo = TimelineRepository(user_a, conn)
        for t, title in zip(times, ["a", "b", "c"], strict=False):
            await repo.upsert_event(_make_event(occurred_at=t, title=title))

    async with user_scoped_tx(pool, user_a) as conn:
        rows = await TimelineRepository(user_a, conn).query(
            window_start=now - timedelta(hours=10),
            window_end=now + timedelta(hours=1),
        )
    assert [r.title for r in rows] == ["b", "c", "a"]  # 5h ago, 3h ago, 1h ago


@pytest.mark.asyncio
async def test_query_includes_pending_by_default(pool, user_ids):
    """Default now includes pending — ambient events that haven't been
    curated yet still surface to the agent. The curator's importance
    score arrives async; making pending invisible by default left
    ambient data inert when the curator wasn't running."""
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        repo = TimelineRepository(user_a, conn)
        await repo.upsert_event(_make_event(title="curated row", curation_status="curated"))
        await repo.upsert_event(_make_event(title="pending row", curation_status="pending"))

    async with user_scoped_tx(pool, user_a) as conn:
        rows = await TimelineRepository(user_a, conn).query(
            window_start=_now() - timedelta(hours=1),
            window_end=_now() + timedelta(hours=1),
        )
    titles = [r.title for r in rows]
    assert "curated row" in titles
    assert "pending row" in titles


@pytest.mark.asyncio
async def test_query_can_opt_out_of_pending(pool, user_ids):
    """Callers that explicitly want curated-only can still pass
    `include_pending=False`."""
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        repo = TimelineRepository(user_a, conn)
        await repo.upsert_event(_make_event(title="curated", curation_status="curated"))
        await repo.upsert_event(_make_event(title="pending", curation_status="pending"))

    async with user_scoped_tx(pool, user_a) as conn:
        rows = await TimelineRepository(user_a, conn).query(
            window_start=_now() - timedelta(hours=1),
            window_end=_now() + timedelta(hours=1),
            include_pending=False,
        )
    titles = [r.title for r in rows]
    assert "curated" in titles
    assert "pending" not in titles


@pytest.mark.asyncio
async def test_query_filters_predicted_by_default(pool, user_ids):
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        repo = TimelineRepository(user_a, conn)
        await repo.upsert_event(_make_event(title="observed", is_predicted=False))
        await repo.upsert_event(_make_event(title="predicted", is_predicted=True))

    async with user_scoped_tx(pool, user_a) as conn:
        rows = await TimelineRepository(user_a, conn).query(
            window_start=_now() - timedelta(hours=1),
            window_end=_now() + timedelta(hours=1),
        )
    titles = [r.title for r in rows]
    assert "observed" in titles
    assert "predicted" not in titles


@pytest.mark.asyncio
async def test_query_filters_by_importance_threshold(pool, user_ids):
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        repo = TimelineRepository(user_a, conn)
        await repo.upsert_event(_make_event(title="high", importance=0.7))
        await repo.upsert_event(_make_event(title="low", importance=0.1))

    async with user_scoped_tx(pool, user_a) as conn:
        rows = await TimelineRepository(user_a, conn).query(
            window_start=_now() - timedelta(hours=1),
            window_end=_now() + timedelta(hours=1),
            min_importance=0.3,
        )
    titles = [r.title for r in rows]
    assert "high" in titles
    assert "low" not in titles


@pytest.mark.asyncio
async def test_query_filters_by_source(pool, user_ids):
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        repo = TimelineRepository(user_a, conn)
        await repo.upsert_event(_make_event(title="mail", source="gmail"))
        await repo.upsert_event(_make_event(title="meet", source="gcal"))

    async with user_scoped_tx(pool, user_a) as conn:
        rows = await TimelineRepository(user_a, conn).query(
            window_start=_now() - timedelta(hours=1),
            window_end=_now() + timedelta(hours=1),
            sources=["gmail"],
        )
    titles = [r.title for r in rows]
    assert titles == ["mail"]


@pytest.mark.asyncio
async def test_query_window_excludes_out_of_range(pool, user_ids):
    user_a, _ = user_ids
    now = _now()
    async with user_scoped_tx(pool, user_a) as conn:
        repo = TimelineRepository(user_a, conn)
        await repo.upsert_event(
            _make_event(
                occurred_at=now - timedelta(hours=10),
                title="too_old",
            )
        )
        await repo.upsert_event(
            _make_event(
                occurred_at=now - timedelta(hours=1),
                title="in_window",
            )
        )
        await repo.upsert_event(
            _make_event(
                occurred_at=now + timedelta(hours=10),
                title="too_future",
            )
        )

    async with user_scoped_tx(pool, user_a) as conn:
        rows = await TimelineRepository(user_a, conn).query(
            window_start=now - timedelta(hours=5),
            window_end=now + timedelta(hours=5),
        )
    titles = [r.title for r in rows]
    assert titles == ["in_window"]


# ── in_progress ────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_in_progress_returns_interval_events_covering_now(pool, user_ids):
    user_a, _ = user_ids
    now = _now()
    async with user_scoped_tx(pool, user_a) as conn:
        repo = TimelineRepository(user_a, conn)
        # Active meeting (started 30 min ago, ends 30 min from now)
        await repo.upsert_event(
            _make_event(
                occurred_at=now - timedelta(minutes=30),
                end_at=now + timedelta(minutes=30),
                title="active meeting",
                source="gcal",
                event_type="meeting",
            )
        )
        # Past meeting (already over)
        await repo.upsert_event(
            _make_event(
                occurred_at=now - timedelta(hours=2),
                end_at=now - timedelta(hours=1),
                title="past meeting",
            )
        )
        # Future meeting (not started)
        await repo.upsert_event(
            _make_event(
                occurred_at=now + timedelta(hours=1),
                end_at=now + timedelta(hours=2),
                title="future meeting",
            )
        )
        # Point event (no end_at, never "in progress")
        await repo.upsert_event(
            _make_event(
                occurred_at=now,
                title="point event",
            )
        )

    async with user_scoped_tx(pool, user_a) as conn:
        rows = await TimelineRepository(user_a, conn).in_progress(at=now)
    titles = [r.title for r in rows]
    assert titles == ["active meeting"]


# ── supersede / reschedule ────────────────────────────────────────────


@pytest.mark.asyncio
async def test_supersede_creates_new_row_and_tombstones_old(pool, user_ids):
    user_a, _ = user_ids
    now = _now()
    async with user_scoped_tx(pool, user_a) as conn:
        repo = TimelineRepository(user_a, conn)
        original = await repo.upsert_event(
            _make_event(
                occurred_at=now + timedelta(hours=2),
                end_at=now + timedelta(hours=3),
                title="meeting at 2pm",
                source="gcal",
                event_type="meeting",
                dedupe_key="gcal:evt1",
            )
        )
        new_row = await repo.supersede(
            old_id=original.id,
            new_event=_make_event(
                occurred_at=now + timedelta(hours=4),
                end_at=now + timedelta(hours=5),
                title="meeting at 4pm",
                source="gcal",
                event_type="meeting",
                # different dedupe_key for the new version
                dedupe_key="gcal:evt1:v2",
            ),
            changed_fields={"occurred_at": {"from": "2pm", "to": "4pm"}},
            by="rule",
        )

    assert new_row.version == 2
    assert new_row.supersedes_id == original.id
    assert len(new_row.history) == 1

    # Old row must now be marked superseded
    async with user_scoped_tx(pool, user_a) as conn:
        old = await TimelineRepository(user_a, conn).get(original.id)
    assert old is not None
    assert old.superseded_by_id == new_row.id


@pytest.mark.asyncio
async def test_query_excludes_superseded_rows_by_default(pool, user_ids):
    user_a, _ = user_ids
    now = _now()
    async with user_scoped_tx(pool, user_a) as conn:
        repo = TimelineRepository(user_a, conn)
        original = await repo.upsert_event(
            _make_event(
                occurred_at=now + timedelta(hours=2),
                title="old version",
                dedupe_key=f"gcal:{uuid.uuid4().hex[:8]}",
            )
        )
        await repo.supersede(
            old_id=original.id,
            new_event=_make_event(
                occurred_at=now + timedelta(hours=4),
                title="new version",
                dedupe_key=f"gcal:{uuid.uuid4().hex[:8]}",
            ),
        )

    async with user_scoped_tx(pool, user_a) as conn:
        rows = await TimelineRepository(user_a, conn).query(
            window_start=now - timedelta(hours=1),
            window_end=now + timedelta(hours=10),
            include_predicted=True,
            include_pending=True,
        )
    titles = [r.title for r in rows]
    assert "old version" not in titles
    assert "new version" in titles


@pytest.mark.asyncio
async def test_get_history_walks_chain(pool, user_ids):
    user_a, _ = user_ids
    now = _now()
    async with user_scoped_tx(pool, user_a) as conn:
        repo = TimelineRepository(user_a, conn)
        v1 = await repo.upsert_event(
            _make_event(
                occurred_at=now + timedelta(hours=2),
                title="v1",
                dedupe_key=f"chain:{uuid.uuid4().hex[:8]}",
            )
        )
        v2 = await repo.supersede(
            old_id=v1.id,
            new_event=_make_event(
                occurred_at=now + timedelta(hours=4),
                title="v2",
                dedupe_key=f"chain:{uuid.uuid4().hex[:8]}",
            ),
        )
        v3 = await repo.supersede(
            old_id=v2.id,
            new_event=_make_event(
                occurred_at=now + timedelta(hours=6),
                title="v3",
                dedupe_key=f"chain:{uuid.uuid4().hex[:8]}",
            ),
        )

    async with user_scoped_tx(pool, user_a) as conn:
        chain = await TimelineRepository(user_a, conn).get_history(v3.id)

    assert [r.title for r in chain] == ["v1", "v2", "v3"]


# ── curation state transitions ────────────────────────────────────────


@pytest.mark.asyncio
async def test_mark_curated_moves_pending_to_curated(pool, user_ids):
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        repo = TimelineRepository(user_a, conn)
        await repo.upsert_event(
            _make_event(
                title="ambient utt",
                curation_status="pending",
                event_id="tle_test_curate",
            )
        )
        changed = await repo.mark_curated(
            event_id="tle_test_curate",
            importance=0.7,
        )
    assert changed is True

    async with user_scoped_tx(pool, user_a) as conn:
        row = await TimelineRepository(user_a, conn).get("tle_test_curate")
    assert row is not None
    assert row.curation_status == "curated"
    assert row.importance == pytest.approx(0.7)
    assert row.curated_at is not None


@pytest.mark.asyncio
async def test_mark_curated_filters_out_low_importance_with_reason(pool, user_ids):
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        repo = TimelineRepository(user_a, conn)
        await repo.upsert_event(
            _make_event(
                title="noise",
                curation_status="pending",
                event_id="tle_test_filter",
            )
        )
        await repo.mark_curated(
            event_id="tle_test_filter",
            importance=0.1,
            filter_reason="automated notification",
        )

    async with user_scoped_tx(pool, user_a) as conn:
        row = await TimelineRepository(user_a, conn).get("tle_test_filter")
    assert row is not None
    assert row.curation_status == "filtered_out"
    assert row.filter_reason == "automated notification"


@pytest.mark.asyncio
async def test_mark_curated_treats_empty_filter_reason_as_no_reason(pool, user_ids):
    """Sloppy LLM output ('  ' or '') must not silently flip a row to
    filtered_out with a useless reason. Empty / whitespace reasons fall
    through to plain `curated` and the column stays NULL."""
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        repo = TimelineRepository(user_a, conn)
        await repo.upsert_event(
            _make_event(
                title="ambiguous low",
                curation_status="pending",
                event_id="tle_empty_reason",
            )
        )
        await repo.mark_curated(
            event_id="tle_empty_reason",
            importance=0.05,
            filter_reason="   ",
        )

    async with user_scoped_tx(pool, user_a) as conn:
        row = await TimelineRepository(user_a, conn).get("tle_empty_reason")
    assert row is not None
    assert row.curation_status == "curated"
    assert row.filter_reason is None
    assert row.importance == pytest.approx(0.05)


@pytest.mark.asyncio
async def test_get_history_handles_self_referential_supersedes_id(pool, user_ids):
    """Defensive: a corrupted row whose `supersedes_id` points back at
    itself shouldn't make get_history loop forever. The seen-set bails
    on revisits."""
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn, conn.cursor() as cur:
        # Bypass the repo to manufacture the impossible row.
        await cur.execute(
            """
            INSERT INTO pai_timeline_events
              (user_id, id, occurred_at, source, event_type, title,
               source_ref, supersedes_id)
            VALUES (%s, %s, NOW(), 'gmail', 'communication', 'self-loop',
                    '{}'::jsonb, %s)
            """,
            (user_a, "tle_self_loop", "tle_self_loop"),
        )

    async with user_scoped_tx(pool, user_a) as conn:
        chain = await TimelineRepository(user_a, conn).get_history("tle_self_loop")
    # The cycle is broken at the first revisit — chain has at most one entry.
    assert len(chain) <= 1


@pytest.mark.asyncio
async def test_supersede_is_atomic_when_old_id_missing(pool, user_ids):
    """If `supersede` is called with a missing old_id, it raises before
    writing the new row — no orphans land in pai_timeline_events."""
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        repo = TimelineRepository(user_a, conn)
        with pytest.raises(ValueError, match="supersede"):
            await repo.supersede(
                old_id="tle_does_not_exist",
                new_event=_make_event(
                    occurred_at=_now() + timedelta(hours=1),
                    title="orphan candidate",
                    event_id="tle_orphan_attempt",
                ),
            )

    async with user_scoped_tx(pool, user_a) as conn:
        orphan = await TimelineRepository(user_a, conn).get("tle_orphan_attempt")
    assert orphan is None


@pytest.mark.asyncio
async def test_list_pending_returns_only_pending_rows(pool, user_ids):
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        repo = TimelineRepository(user_a, conn)
        await repo.upsert_event(_make_event(title="p1", curation_status="pending"))
        await repo.upsert_event(_make_event(title="p2", curation_status="pending"))
        await repo.upsert_event(_make_event(title="curated", curation_status="curated"))

    async with user_scoped_tx(pool, user_a) as conn:
        pending = await TimelineRepository(user_a, conn).list_pending(limit=10)
    titles = sorted(r.title for r in pending)
    assert titles == ["p1", "p2"]


# ── reference tracking ────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_increment_references_bumps_count_and_appends_run(pool, user_ids):
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        repo = TimelineRepository(user_a, conn)
        ev = await repo.upsert_event(_make_event(event_id="tle_ref_test"))
        await repo.increment_references(event_ids=[ev.id], run_id="run_abc")

    async with user_scoped_tx(pool, user_a) as conn:
        row = await TimelineRepository(user_a, conn).get("tle_ref_test")
    assert row is not None
    assert row.reference_count == 1
    assert row.last_referenced_at is not None


# ── RLS isolation ────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_rls_isolates_users(pool, user_ids):
    user_a, user_b = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        await TimelineRepository(user_a, conn).upsert_event(
            _make_event(title="for a"),
        )
    async with user_scoped_tx(pool, user_b) as conn:
        await TimelineRepository(user_b, conn).upsert_event(
            _make_event(title="for b"),
        )

    async with user_scoped_tx(pool, user_a) as conn:
        a_rows = await TimelineRepository(user_a, conn).query(
            window_start=_now() - timedelta(hours=1),
            window_end=_now() + timedelta(hours=1),
        )
    async with user_scoped_tx(pool, user_b) as conn:
        b_rows = await TimelineRepository(user_b, conn).query(
            window_start=_now() - timedelta(hours=1),
            window_end=_now() + timedelta(hours=1),
        )
    assert {r.title for r in a_rows} == {"for a"}
    assert {r.title for r in b_rows} == {"for b"}


# ── CHECK constraints ────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_end_at_before_occurred_at_rejected(pool, user_ids):
    """CHECK constraint: end_at >= occurred_at."""
    user_a, _ = user_ids
    now = _now()
    bad = _make_event(
        occurred_at=now,
        end_at=now - timedelta(minutes=5),  # end before start
    )
    async with user_scoped_tx(pool, user_a) as conn:
        with pytest.raises(Exception) as exc:
            await TimelineRepository(user_a, conn).upsert_event(bad)
    assert "check" in str(exc.value).lower() or "constraint" in str(exc.value).lower()
