"""calendly + todoist connectors — extractor / mapper / DB round-trip.

Calendly is the only 2-step fetcher: GET_USER → LIST_SCHEDULED_EVENTS.
Tests pin the URI extraction + envelope unwrapping for both steps.

Todoist v1 (top-level array) and v2 (results-keyed) shapes are both
covered.
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

# ── Calendly extractor + mapper ────────────────────────────────────────


def test_extract_calendly_user_uri_resource_form():
    response = {"data": {"resource": {
        "uri": "https://api.calendly.com/users/abc-123",
    }}}
    uri = connector_ingest._extract_calendly_user_uri(response)
    assert uri == "https://api.calendly.com/users/abc-123"


def test_extract_calendly_user_uri_flat_form():
    response = {"data": {"uri": "https://api.calendly.com/users/x"}}
    assert (
        connector_ingest._extract_calendly_user_uri(response)
        == "https://api.calendly.com/users/x"
    )


def test_extract_calendly_user_uri_rejects_other_uris():
    """A `uri` that's not under /users/ shouldn't be picked up — we
    don't want to feed an organization URI into LIST_SCHEDULED_EVENTS
    where the API expects a user URI."""
    response = {"data": {"uri": "https://api.calendly.com/organizations/x"}}
    assert connector_ingest._extract_calendly_user_uri(response) is None


def test_extract_calendly_events_collection_key():
    response = {"data": {"collection": [{"uri": "evt-1"}, {"uri": "evt-2"}]}}
    out = connector_ingest._extract_calendly_events(response)
    assert len(out) == 2


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


# ── Todoist extractor + mapper ─────────────────────────────────────────


def test_extract_todoist_v2_results_key():
    response = {"data": {"results": [{"id": "1"}, {"id": "2"}]}}
    out = connector_ingest._extract_todoist_tasks(response)
    assert len(out) == 2


def test_extract_todoist_v1_top_level_array():
    """v1 shape: data is itself the array (some envelopes flatten)."""
    response = {"data": [{"id": "a"}]}
    out = connector_ingest._extract_todoist_tasks(response)
    assert out == [{"id": "a"}]


def test_map_todoist_task_basic():
    raw = {
        "id": 7,
        "content": "Ship Q2 review",
        "description": "Get sign-off from PM",
        "project_id": 12345,
        "parent_id": None,
        "priority": 3,
        "labels": ["work", "urgent", 99],  # int gets filtered
        "due": {"datetime": "2026-05-15T17:00:00Z"},
        "is_completed": False,
        "created_at": "2026-04-30T08:00:00Z",
    }
    mapped = connector_ingest._map_todoist_task(raw)
    assert mapped is not None
    assert mapped["task_id"] == "7"
    assert mapped["project_id"] == "12345"
    assert mapped["priority"] == 3
    assert mapped["labels"] == ["work", "urgent"]  # int filtered
    assert mapped["due_at"].year == 2026
    assert mapped["is_completed"] is False
    assert mapped["occurred_at"] == mapped["created_at_remote"]


def test_map_todoist_task_due_date_only():
    """All-day tasks: due.date is YYYY-MM-DD; no datetime."""
    raw = {"id": "8", "due": {"date": "2026-05-15"}}
    mapped = connector_ingest._map_todoist_task(raw)
    assert mapped is not None
    assert mapped["due_at"] is not None
    assert mapped["due_at"].year == 2026
    assert mapped["due_at"].day == 15


def test_map_todoist_task_returns_none_without_id():
    assert connector_ingest._map_todoist_task({"content": "no id"}) is None


def test_map_todoist_task_completion_aliases():
    """Composio surfaces `completed`; raw API uses `is_completed`."""
    assert connector_ingest._map_todoist_task(
        {"id": "1", "completed": True},
    )["is_completed"] is True
    assert connector_ingest._map_todoist_task(
        {"id": "2", "is_completed": False},
    )["is_completed"] is False


# ── DB-backed sync round-trips ─────────────────────────────────────────


def _sync_task(toolkit: str, user_id: int, cid: str) -> ScheduledTaskRow:
    return ScheduledTaskRow(
        user_id=user_id,
        id=f"sync.{toolkit}.{cid}",
        kind="connector.sync",
        name=None, prompt=None,
        trigger_kind="schedule", cron_expr="*/30 * * * *",
        interval_seconds=None, event_filter=None,
        payload={"toolkit": toolkit, "connectedAccountId": cid},
        timezone="UTC", status="active",
        next_run_at=None, last_run_at=datetime.now(UTC),
        last_run_status="dispatched", run_count=1,
        attempts=0, max_attempts=3, progress={}, last_error=None,
    )


def _patch_fetch(monkeypatch, toolkit: str, items_box: dict):
    real = connector_ingest._ADAPTERS[toolkit]

    async def fake_fetch(api_key, cx_user_id, cid, limit, since):
        return list(items_box["items"])

    monkeypatch.setitem(
        connector_ingest._ADAPTERS, toolkit,
        connector_ingest.ToolkitAdapter(
            toolkit=toolkit, raw_table=real.raw_table,
            fetch=fake_fetch, upsert=real.upsert,
        ),
    )
    monkeypatch.setattr(
        connector_ingest, "get_web_settings",
        lambda: SimpleNamespace(composio_api_key="test-key"),
    )


@pytest.mark.asyncio
async def test_calendly_sync_status_flips_to_canceled(pool, user_ids, monkeypatch):
    user_a, _ = user_ids
    box = {"items": [
        {
            "uri": "https://api.calendly.com/scheduled_events/evt-9",
            "name": "Standup",
            "status": "active",
            "start_time": "2026-05-10T10:00:00Z",
            "end_time": "2026-05-10T10:30:00Z",
        },
    ]}
    _patch_fetch(monkeypatch, "calendly", box)

    async with user_scoped_tx(pool, user_a) as conn:
        await enqueue_once(
            conn, user_id=user_a, task_id="sync.calendly.cidCAL",
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
async def test_todoist_sync_completion_flips(pool, user_ids, monkeypatch):
    """Marking a task complete updates is_completed in place."""
    user_a, _ = user_ids
    box = {"items": [
        {
            "id": "777",
            "content": "Ship feature X",
            "is_completed": False,
            "created_at": "2026-04-01T00:00:00Z",
        },
    ]}
    _patch_fetch(monkeypatch, "todoist", box)

    async with user_scoped_tx(pool, user_a) as conn:
        await enqueue_once(
            conn, user_id=user_a, task_id="sync.todoist.cidTD",
            kind="connector.sync",
            payload={"toolkit": "todoist", "connectedAccountId": "cidTD"},
        )
    await connector_ingest.run(pool, _sync_task("todoist", user_a, "cidTD"), "rt1")

    box["items"][0] = {**box["items"][0], "is_completed": True}
    await connector_ingest.run(pool, _sync_task("todoist", user_a, "cidTD"), "rt2")

    async with service_tx(pool) as conn:
        cur = await conn.execute(
            "SELECT is_completed FROM pai_raw_todoist_tasks "
            "WHERE user_id = %s",
            (user_a,),
        )
        rows = await cur.fetchall()
    assert len(rows) == 1
    assert rows[0]["is_completed"] is True


@pytest.mark.asyncio
async def test_calendly_todoist_registered():
    assert "calendly" in connector_ingest.supported_toolkits()
    assert "todoist" in connector_ingest.supported_toolkits()
