"""Google Drive connector — extractor / mapper / DB round-trip.

Drive metadata semantics (owners[].emailAddress, modifiedTime,
mime/web links).
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


def test_flatten_drive_owners_prefers_email():
    raw = {"owners": [
        {"emailAddress": "alice@x.com", "displayName": "Alice"},
        {"displayName": "Bob"},
        {"emailAddress": ""},  # empty email skipped
        {},
    ]}
    out = connector_ingest._flatten_drive_owners(raw)
    assert out == ["alice@x.com", "Bob"]


def test_flatten_drive_last_modifying_user():
    assert connector_ingest._flatten_drive_last_modifying_user(
        {"lastModifyingUser": {"emailAddress": "u@x.com"}},
    ) == "u@x.com"
    assert connector_ingest._flatten_drive_last_modifying_user(
        {"lastModifyingUser": {"displayName": "Carol"}},
    ) == "Carol"
    assert connector_ingest._flatten_drive_last_modifying_user({}) is None


# ── gdrive mapper ───────────────────────────────────────────────────────


def test_map_gdrive_file_basic():
    raw = {
        "id": "1abc",
        "name": "design.pdf",
        "mimeType": "application/pdf",
        "modifiedTime": "2026-04-15T10:00:00Z",
        "createdTime": "2026-04-01T00:00:00Z",
        "size": "12345",  # Drive returns size as string
        "webViewLink": "https://drive.google.com/file/d/1abc",
        "owners": [{"emailAddress": "alice@x.com"}],
    }
    mapped = connector_ingest._map_gdrive_file(raw)
    assert mapped is not None
    assert mapped["file_id"] == "1abc"
    assert mapped["name"] == "design.pdf"
    assert mapped["mime_type"] == "application/pdf"
    assert mapped["size_bytes"] == 12345
    assert mapped["owners"] == ["alice@x.com"]
    assert mapped["modified_time"].year == 2026
    assert mapped["occurred_at"] == mapped["modified_time"]


def test_map_gdrive_file_handles_int_size():
    mapped = connector_ingest._map_gdrive_file({"id": "x", "size": 99})
    assert mapped is not None
    assert mapped["size_bytes"] == 99


def test_map_gdrive_file_unparseable_size_is_none():
    mapped = connector_ingest._map_gdrive_file({"id": "x", "size": "abc"})
    assert mapped is not None
    assert mapped["size_bytes"] is None


def test_map_gdrive_file_returns_none_without_id():
    assert connector_ingest._map_gdrive_file({"name": "no id"}) is None


# ── DB round-trip: gdrive sync mutates row on second fire ──────────────


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
    """Replace ingest_runner.run_fetch so connector_ingest gets test items
    without hitting Composio. Real upserter still runs against the DB."""
    from pinai_agents.web.services import ingest_runner

    async def fake_fetch(user_id, tk, cid, *, limit=100, since=None):
        if tk == toolkit:
            return list(items_box["items"])
        return []

    monkeypatch.setattr(ingest_runner, "run_fetch", fake_fetch)
    _ = SimpleNamespace


@pytest.mark.asyncio
async def test_gdrive_sync_renames_file_in_place(pool, user_ids, monkeypatch):
    user_a, _ = user_ids
    box = {"items": [
        {
            "id": "f-X",
            "name": "draft.pdf",
            "modifiedTime": "2026-04-01T00:00:00Z",
            "owners": [{"emailAddress": "a@x.com"}],
        },
    ]}
    _patch_fetch(monkeypatch, "googledrive", box)

    async with user_scoped_tx(pool, user_a) as conn:
        await enqueue_once(
            conn, user_id=user_a, task_id="sync.googledrive.cidGD",
            kind="connector.sync",
            payload={"toolkit": "googledrive", "connectedAccountId": "cidGD"},
        )

    await connector_ingest.run(pool, _sync_task("googledrive", user_a, "cidGD"), "rd1")

    box["items"] = [
        {
            "id": "f-X",
            "name": "final.pdf",  # renamed
            "modifiedTime": "2026-04-20T00:00:00Z",
            "owners": [{"emailAddress": "a@x.com"}],
        },
    ]
    await connector_ingest.run(pool, _sync_task("googledrive", user_a, "cidGD"), "rd2")

    async with service_tx(pool) as conn:
        cur = await conn.execute(
            "SELECT name FROM pai_raw_gdrive_files WHERE user_id = %s",
            (user_a,),
        )
        rows = await cur.fetchall()
    assert len(rows) == 1
    assert rows[0]["name"] == "final.pdf"


@pytest.mark.asyncio
async def test_gdrive_registered():
    assert "googledrive" in connector_ingest.supported_toolkits()
