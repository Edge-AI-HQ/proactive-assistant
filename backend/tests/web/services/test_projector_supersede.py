"""Supersede producer end-to-end (design doc §6.3): re-ingested content changes
become append-only revisions in L1.

Full chain under test — upsert_generic's conditional content_updated_at touch
(124) → project_unprojected's supersede pass → the events chain:

  * reschedule: new revision supersedes the old event (old stays, chained)
  * identical re-sync: no touch, no revision (no churn)
  * cancellation: tombstone revision ([cancelled] title, structured.status)
  * already-cancelled new raw: never first-projected (the 21-untitled lesson)

Uses the real googlecalendar recipe + upsert_generic, so the test breaks if
any stage of the pipeline stops cooperating.
"""

from __future__ import annotations

from typing import Any

import pytest
from pinai_api.domains.connector.apps.generic_ingest import upsert_generic
from pinai_api.domains.connector.apps.ingest_runner import load_recipe
from pinai_api.domains.memory.projection import project_unprojected
from pinai_db.rls import user_scoped_tx


def _gcal_item(
    *,
    id: str,
    summary: str | None = "Team standup",
    start: str = "2026-07-02T10:00:00Z",
    status: str = "confirmed",
) -> dict[str, Any]:
    item: dict[str, Any] = {"id": id, "status": status}
    if summary is not None:
        item["summary"] = summary
    if start is not None:
        item["start"] = {"dateTime": start}
    return item


async def _ingest_and_project(pool, user_id: int, items: list[dict[str, Any]]) -> int:
    recipe = load_recipe("googlecalendar")
    async with user_scoped_tx(pool, user_id) as conn:
        await upsert_generic(conn, user_id, "googlecalendar", "events", recipe, items)
        return await project_unprojected(conn, user_id)


async def _events_for(pool, user_id: int) -> list[dict[str, Any]]:
    async with user_scoped_tx(pool, user_id) as conn, conn.cursor() as cur:
        await cur.execute(
            """
            SELECT id, event_type, occurred_at, title, structured, dedupe_key,
                   supersedes_id, superseded_by_id
            FROM pai_events
            WHERE user_id = %s AND source = 'composio'
            ORDER BY recorded_at
            """,
            (user_id,),
        )
        return list(await cur.fetchall())


@pytest.mark.asyncio
async def test_reschedule_appends_supersede_revision(pool, user_ids):
    user_a, _ = user_ids
    await _ingest_and_project(pool, user_a, [_gcal_item(id="resched_1")])
    (v1,) = await _events_for(pool, user_a)
    assert v1["superseded_by_id"] is None

    # Reschedule: same external id, new start → content change → revision.
    appended = await _ingest_and_project(
        pool, user_a, [_gcal_item(id="resched_1", start="2026-07-02T14:00:00Z")]
    )
    assert appended == 1
    v1_after, v2 = await _events_for(pool, user_a)
    assert v1_after["superseded_by_id"] == v2["id"]
    assert v2["supersedes_id"] == v1_after["id"]
    assert v2["superseded_by_id"] is None
    assert v2["occurred_at"].isoformat().startswith("2026-07-02T14:00")
    assert ":u" in v2["dedupe_key"]  # revision key carries the change instant

    # Replay with the same content: no touch, no new revision.
    assert (
        await _ingest_and_project(
            pool, user_a, [_gcal_item(id="resched_1", start="2026-07-02T14:00:00Z")]
        )
        == 0
    )
    assert len(await _events_for(pool, user_a)) == 2


@pytest.mark.asyncio
async def test_second_change_extends_the_chain(pool, user_ids):
    user_a, _ = user_ids
    await _ingest_and_project(pool, user_a, [_gcal_item(id="chain_1")])
    await _ingest_and_project(
        pool, user_a, [_gcal_item(id="chain_1", start="2026-07-02T15:00:00Z")]
    )
    await _ingest_and_project(
        pool, user_a, [_gcal_item(id="chain_1", start="2026-07-03T09:00:00Z")]
    )
    v1, v2, v3 = await _events_for(pool, user_a)
    assert v1["superseded_by_id"] == v2["id"]
    assert v2["superseded_by_id"] == v3["id"]
    assert v3["superseded_by_id"] is None  # single current head
    assert v3["occurred_at"].isoformat().startswith("2026-07-03T09:00")


@pytest.mark.asyncio
async def test_cancellation_becomes_tombstone_revision(pool, user_ids):
    user_a, _ = user_ids
    await _ingest_and_project(pool, user_a, [_gcal_item(id="cxl_1", summary="Board review")])

    # A cancelled gcal instance loses its human fields (no summary) — the
    # tombstone must fall back to the superseded event's title.
    appended = await _ingest_and_project(
        pool, user_a, [_gcal_item(id="cxl_1", summary=None, status="cancelled")]
    )
    assert appended == 1
    v1, tomb = await _events_for(pool, user_a)
    assert v1["superseded_by_id"] == tomb["id"]
    assert tomb["title"] == "[cancelled] Board review"
    assert tomb["structured"]["status"] == "cancelled"
    assert tomb["event_type"] == "meeting"  # semantic type kept


@pytest.mark.asyncio
async def test_already_cancelled_raw_is_never_first_projected(pool, user_ids):
    user_a, _ = user_ids
    # init/backfill pulls an old cancelled item (showDeleted=true) that was
    # never projected — it must NOT become an orphan "(untitled)" event.
    appended = await _ingest_and_project(
        pool, user_a, [_gcal_item(id="ghost_1", summary=None, status="cancelled")]
    )
    assert appended == 0
    assert await _events_for(pool, user_a) == []
    # The L0 record is still there (archive keeps the verbatim row).
    async with user_scoped_tx(pool, user_a) as conn, conn.cursor() as cur:
        await cur.execute(
            "SELECT count(*) AS n FROM pai_raw_apps WHERE user_id = %s AND external_id = 'ghost_1'",
            (user_a,),
        )
        assert (await cur.fetchone())["n"] == 1
