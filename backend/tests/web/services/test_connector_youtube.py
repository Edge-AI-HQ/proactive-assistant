"""YouTube connector — extractor / mapper / DB round-trip.

YOUTUBE_LIST_USER_SUBSCRIPTIONS returns each subscription with the real
join key (channelId) buried under snippet.resourceId. Mapper pulls it
out so downstream can join on channel rather than subscription id.
"""

from __future__ import annotations

from datetime import UTC, datetime
from types import SimpleNamespace

import pytest
from pinai_api.domains.connector.apps import connector_ingest
from pinai_api.platform.db.repositories.scheduled_tasks import (
    ScheduledTaskRow,
    enqueue_once,
)
from pinai_db.rls import service_tx, user_scoped_tx

# ── DB-backed sync round-trip ──────────────────────────────────────────


def _sync_task(toolkit: str, user_id: int, cid: str) -> ScheduledTaskRow:
    return ScheduledTaskRow(
        user_id=user_id,
        id=f"sync.{toolkit}.{cid}",
        kind="connector.sync",
        name=None,
        prompt=None,
        trigger_kind="schedule",
        cron_expr="*/30 * * * *",
        interval_seconds=None,
        event_filter=None,
        payload={"toolkit": toolkit, "connectedAccountId": cid},
        timezone="UTC",
        status="active",
        next_run_at=None,
        last_run_at=datetime.now(UTC),
        last_run_status="dispatched",
        run_count=1,
        attempts=0,
        max_attempts=3,
        progress={},
        last_error=None,
    )


def _patch_fetch(monkeypatch, toolkit: str, items_box: dict):
    from pinai_api.domains.connector.apps import ingest_runner

    async def fake_fetch(user_id, tk, cid, *, limit=100, since=None, pool=None):
        if tk == toolkit:
            return list(items_box["items"])
        return []

    monkeypatch.setattr(ingest_runner, "run_fetch", fake_fetch)
    _ = SimpleNamespace


@pytest.mark.asyncio
async def test_youtube_sync_refreshes_channel_title_in_place(
    pool,
    user_ids,
    monkeypatch,
):
    user_a, _ = user_ids
    box = {
        "items": [
            {
                "id": "sub-keep",
                "snippet": {
                    "title": "Old Name",
                    "publishedAt": "2024-01-01T00:00:00Z",
                    "resourceId": {"channelId": "UC-keep"},
                },
            },
        ]
    }
    _patch_fetch(monkeypatch, "youtube", box)

    async with user_scoped_tx(pool, user_a) as conn:
        await enqueue_once(
            conn,
            user_id=user_a,
            task_id="sync.youtube.cidYT",
            kind="connector.sync",
            payload={"toolkit": "youtube", "connectedAccountId": "cidYT"},
        )
    await connector_ingest.run(pool, _sync_task("youtube", user_a, "cidYT"), "ry1")

    box["items"][0]["snippet"] = {
        **box["items"][0]["snippet"],
        "title": "New Name",
    }
    await connector_ingest.run(pool, _sync_task("youtube", user_a, "cidYT"), "ry2")

    async with service_tx(pool) as conn:
        cur = await conn.execute(
            "SELECT title FROM pai_raw_apps "
            "WHERE user_id = %s AND toolkit = 'youtube' AND entity_type = 'subscriptions'",
            (user_a,),
        )
        rows = await cur.fetchall()
    assert len(rows) == 1
    assert rows[0]["title"] == "New Name"


@pytest.mark.asyncio
async def test_youtube_registered():
    assert "youtube" in connector_ingest.supported_toolkits()
