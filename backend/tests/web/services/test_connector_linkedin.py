"""LinkedIn connector — extractor / mapper / DB round-trip.

Composio normalizes LINKEDIN_GET_MY_INFO across two known shapes:
flat (`firstName`/`lastName` strings) and nested (`name: {first_name,
last_name, localized}`). Mapper pins both. Profile is a singleton so
the runner wraps the response object in `[obj]` before our upserter.
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

# ── LinkedIn mapper ────────────────────────────────────────────────────


def test_map_linkedin_profile_flat_shape():
    raw = {
        "id": "lid-1",
        "firstName": "Alice",
        "lastName": "Lee",
        "headline": "Eng @ X",
        "vanityName": "alice-lee",
    }
    mapped = connector_ingest._map_linkedin_profile(raw)
    assert mapped is not None
    assert mapped["linkedin_id"] == "lid-1"
    assert mapped["first_name"] == "Alice"
    assert mapped["last_name"] == "Lee"
    assert mapped["localized_name"] == "Alice Lee"
    assert mapped["headline"] == "Eng @ X"
    assert mapped["vanity_name"] == "alice-lee"
    assert mapped["profile_url"] == "https://www.linkedin.com/in/alice-lee"


def test_map_linkedin_profile_nested_name_shape():
    raw = {
        "id": "lid-2",
        "name": {"first_name": "Bob", "last_name": "Wu", "localized": "Bob Wu"},
        "headline": "PM",
    }
    mapped = connector_ingest._map_linkedin_profile(raw)
    assert mapped is not None
    assert mapped["first_name"] == "Bob"
    assert mapped["last_name"] == "Wu"
    assert mapped["localized_name"] == "Bob Wu"
    assert mapped["profile_url"] is None  # no vanity → no URL fallback


def test_map_linkedin_profile_picture_from_displayimage():
    raw = {
        "id": "lid-3",
        "profilePicture": {
            "displayImage~": {
                "elements": [
                    {"identifiers": [{"identifier": "https://media/large.jpg"}]},
                ],
            },
        },
    }
    mapped = connector_ingest._map_linkedin_profile(raw)
    assert mapped is not None
    assert mapped["picture_url"] == "https://media/large.jpg"


def test_map_linkedin_profile_returns_none_without_id():
    assert connector_ingest._map_linkedin_profile({"headline": "x"}) is None


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
async def test_linkedin_sync_refreshes_headline_in_place(
    pool,
    user_ids,
    monkeypatch,
):
    user_a, _ = user_ids
    box = {
        "items": [
            {"id": "lid-99", "firstName": "Alice", "lastName": "Lee", "headline": "Eng"},
        ]
    }
    _patch_fetch(monkeypatch, "linkedin", box)

    async with user_scoped_tx(pool, user_a) as conn:
        await enqueue_once(
            conn,
            user_id=user_a,
            task_id="sync.linkedin.cidLI",
            kind="connector.sync",
            payload={"toolkit": "linkedin", "connectedAccountId": "cidLI"},
        )
    await connector_ingest.run(pool, _sync_task("linkedin", user_a, "cidLI"), "rl1")

    box["items"][0] = {**box["items"][0], "headline": "Staff Eng"}
    await connector_ingest.run(pool, _sync_task("linkedin", user_a, "cidLI"), "rl2")

    async with service_tx(pool) as conn:
        cur = await conn.execute(
            "SELECT headline FROM pai_raw_linkedin_profile WHERE user_id = %s",
            (user_a,),
        )
        rows = await cur.fetchall()
    assert len(rows) == 1
    assert rows[0]["headline"] == "Staff Eng"


@pytest.mark.asyncio
async def test_linkedin_registered():
    assert "linkedin" in connector_ingest.supported_toolkits()
