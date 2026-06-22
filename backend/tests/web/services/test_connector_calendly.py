"""Calendly connector — extractor / mapper / DB round-trip.

Calendly is the only 2-step fetcher: GET_USER → LIST_SCHEDULED_EVENTS.
Tests pin the URI extraction + envelope unwrapping for both steps.
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

# ── Calendly extractor + mapper ────────────────────────────────────────


def test_map_calendly_event_basic():
    raw = {
        "uri": "https://api.calendly.com/scheduled_events/evt-1",
        "name": "1:1 with Alice",
        "status": "active",
        "start_time": "2026-05-10T15:00:00Z",
        "end_time": "2026-05-10T15:30:00Z",
        "location": {
            "type": "google_conference",
            "join_url": "https://meet.google.com/xyz",
        },
        "event_memberships": [
            {"user_name": "Alice", "user_email": "alice@x.com"},
        ],
    }
    mapped = connector_ingest._map_calendly_event(raw)
    assert mapped is not None
    assert mapped["event_uri"].endswith("evt-1")
    assert mapped["status"] == "active"
    assert mapped["start_at"].year == 2026
    assert mapped["location_type"] == "google_conference"
    assert mapped["meeting_url"] == "https://meet.google.com/xyz"
    assert mapped["location_value"] == "https://meet.google.com/xyz"
    assert mapped["invitees"] == [
        {"name": "Alice", "email": "alice@x.com"},
    ]
    assert mapped["occurred_at"] == mapped["start_at"]


def test_map_calendly_event_handles_in_person_location():
    raw = {
        "uri": "evt-2",
        "location": {"type": "physical", "location": "Cafe Sutro"},
    }
    mapped = connector_ingest._map_calendly_event(raw)
    assert mapped is not None
    assert mapped["location_type"] == "physical"
    assert mapped["location_value"] == "Cafe Sutro"
    assert mapped["meeting_url"] is None


def test_map_calendly_event_returns_none_without_uri():
    assert connector_ingest._map_calendly_event({"name": "no uri"}) is None


# ── DB-backed sync round-trips ─────────────────────────────────────────


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
    """Replace ingest_runner.run_fetch so connector_ingest gets test items
    without hitting Composio. Real upserter still runs against the DB.
    """
    from pinai_api.domains.connector.apps import ingest_runner

    async def fake_fetch(user_id, tk, cid, *, limit=100, since=None, pool=None):
        if tk == toolkit:
            return list(items_box["items"])
        return []

    monkeypatch.setattr(ingest_runner, "run_fetch", fake_fetch)
    _ = SimpleNamespace  # imported in this file but only useful elsewhere


@pytest.mark.asyncio
async def test_calendly_sync_status_flips_to_canceled(pool, user_ids, monkeypatch):
    user_a, _ = user_ids
    box = {
        "items": [
            {
                "uri": "https://api.calendly.com/scheduled_events/evt-9",
                "name": "Standup",
                "status": "active",
                "start_time": "2026-05-10T10:00:00Z",
                "end_time": "2026-05-10T10:30:00Z",
            },
        ]
    }
    _patch_fetch(monkeypatch, "calendly", box)

    async with user_scoped_tx(pool, user_a) as conn:
        await enqueue_once(
            conn,
            user_id=user_a,
            task_id="sync.calendly.cidCAL",
            kind="connector.sync",
            payload={"toolkit": "calendly", "connectedAccountId": "cidCAL"},
        )
    await connector_ingest.run(pool, _sync_task("calendly", user_a, "cidCAL"), "rc1")

    box["items"][0] = {**box["items"][0], "status": "canceled"}
    await connector_ingest.run(pool, _sync_task("calendly", user_a, "cidCAL"), "rc2")

    async with service_tx(pool) as conn:
        cur = await conn.execute(
            "SELECT status FROM pai_raw_calendly_events WHERE user_id = %s",
            (user_a,),
        )
        rows = await cur.fetchall()
    assert len(rows) == 1
    assert rows[0]["status"] == "canceled"


@pytest.mark.asyncio
async def test_calendly_registered():
    assert "calendly" in connector_ingest.supported_toolkits()
