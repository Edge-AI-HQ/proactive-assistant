"""YouTube connector — extractor / mapper / DB round-trip.

YOUTUBE_LIST_USER_SUBSCRIPTIONS returns each subscription with the real
join key (channelId) buried under snippet.resourceId. Mapper pulls it
out so downstream can join on channel rather than subscription id.
"""

from __future__ import annotations

from datetime import UTC, datetime
from types import SimpleNamespace

import pytest

from pinai_agents.web.db.repositories.scheduled_tasks import (
    ScheduledTaskRow,
    enqueue_once,
)
from pinai_agents.web.db.rls import service_tx, user_scoped_tx
from pinai_agents.web.services import connector_ingest

# ── YouTube mapper ─────────────────────────────────────────────────────


def test_map_youtube_subscription_basic():
    raw = {
        "id": "sub-1",
        "snippet": {
            "title": "Veritasium",
            "description": "Science",
            "publishedAt": "2024-01-15T10:00:00Z",
            "resourceId": {"kind": "youtube#channel", "channelId": "UC-x"},
            "thumbnails": {"default": {"url": "https://i.ytimg.com/x.jpg"}},
        },
    }
    mapped = connector_ingest._map_youtube_subscription(raw)
    assert mapped is not None
    assert mapped["subscription_id"] == "sub-1"
    assert mapped["channel_id"] == "UC-x"
    assert mapped["channel_title"] == "Veritasium"
    assert mapped["thumbnail_url"] == "https://i.ytimg.com/x.jpg"
    assert mapped["subscribed_at"].year == 2024
    assert mapped["occurred_at"] == mapped["subscribed_at"]


def test_map_youtube_subscription_falls_back_to_flat_channel_id():
    raw = {
        "id": "sub-2",
        "snippet": {"title": "Flat", "channelId": "UC-flat"},
    }
    mapped = connector_ingest._map_youtube_subscription(raw)
    assert mapped is not None
    assert mapped["channel_id"] == "UC-flat"


def test_map_youtube_subscription_returns_none_without_channel():
    raw = {"id": "sub-3", "snippet": {"title": "noChannel"}}
    assert connector_ingest._map_youtube_subscription(raw) is None


def test_map_youtube_subscription_returns_none_without_id():
    raw = {"snippet": {"resourceId": {"channelId": "UC-x"}}}
    assert connector_ingest._map_youtube_subscription(raw) is None


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
    from pinai_agents.web.services import ingest_runner

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
            "SELECT channel_title FROM pai_raw_youtube_subscriptions WHERE user_id = %s",
            (user_a,),
        )
        rows = await cur.fetchall()
    assert len(rows) == 1
    assert rows[0]["channel_title"] == "New Name"


@pytest.mark.asyncio
async def test_youtube_registered():
    assert "youtube" in connector_ingest.supported_toolkits()
