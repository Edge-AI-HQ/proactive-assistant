"""Google Drive connector — extractor / mapper / DB round-trip.

Drive metadata semantics (owners[].emailAddress, modifiedTime,
mime/web links).
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

# ── DB round-trip: gdrive sync mutates row on second fire ──────────────


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
    without hitting Composio. Real upserter still runs against the DB."""
    from pinai_api.domains.connector.apps import ingest_runner

    async def fake_fetch(user_id, tk, cid, *, limit=100, since=None, pool=None):
        if tk == toolkit:
            return list(items_box["items"])
        return []

    monkeypatch.setattr(ingest_runner, "run_fetch", fake_fetch)
    _ = SimpleNamespace


@pytest.mark.asyncio
async def test_gdrive_sync_renames_file_in_place(pool, user_ids, monkeypatch):
    user_a, _ = user_ids
    box = {
        "items": [
            {
                "id": "f-X",
                "name": "draft.pdf",
                "modifiedTime": "2026-04-01T00:00:00Z",
                "owners": [{"emailAddress": "a@x.com"}],
            },
        ]
    }
    _patch_fetch(monkeypatch, "googledrive", box)

    async with user_scoped_tx(pool, user_a) as conn:
        await enqueue_once(
            conn,
            user_id=user_a,
            task_id="sync.googledrive.cidGD",
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
            "SELECT title FROM pai_raw_apps "
            "WHERE user_id = %s AND toolkit = 'googledrive' AND entity_type = 'files'",
            (user_a,),
        )
        rows = await cur.fetchall()
    assert len(rows) == 1
    assert rows[0]["title"] == "final.pdf"


@pytest.mark.asyncio
async def test_gdrive_registered():
    assert "googledrive" in connector_ingest.supported_toolkits()
