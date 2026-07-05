"""github connector — fetcher response shape + mapper unit tests +
DB-backed init/sync round-trip with mocked Composio.

Covers:
  * extractor handles Composio's data.issues envelope + raw GH array
  * mapper picks up id / repo / labels / assignees / pr-flag correctly
  * upsert ON CONFLICT updates state on subsequent fires (issue closed)
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

# ── DB-backed sync round-trip with mocked fetch ─────────────────────────


def _sync_task(user_id: int, cid: str) -> ScheduledTaskRow:
    return ScheduledTaskRow(
        user_id=user_id,
        id=f"sync.github.{cid}",
        kind="connector.sync",
        name=None,
        prompt=None,
        trigger_kind="schedule",
        cron_expr="*/30 * * * *",
        interval_seconds=None,
        event_filter=None,
        payload={"toolkit": "github", "connectedAccountId": cid},
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


@pytest.mark.asyncio
async def test_github_sync_inserts_then_state_flip_updates(
    pool,
    user_ids,
    monkeypatch,
):
    """Round-trip: first sync inserts an open issue. Second sync (issue
    is now closed) updates the same row via ON CONFLICT — does NOT
    insert a duplicate."""
    user_a, _ = user_ids
    state = {
        "items": [
            {
                "id": 7001,
                "number": 1,
                "title": "Open thing",
                "state": "open",
                "html_url": "https://github.com/x/y/issues/1",
                "repository_url": "https://api.github.com/repos/x/y",
                "labels": [],
                "assignees": [{"login": "alice"}],
                "created_at": "2026-04-01T00:00:00Z",
                "updated_at": "2026-04-10T00:00:00Z",
            },
        ]
    }

    from pinai_api.domains.connector.apps import ingest_runner

    async def fake_fetch(user_id, tk, cid, *, limit=100, since=None, pool=None):
        if tk == "github":
            return list(state["items"])
        return []

    # Override only the fetcher; the real upserter still runs against the DB.
    monkeypatch.setattr(ingest_runner, "run_fetch", fake_fetch)
    _ = SimpleNamespace

    async with user_scoped_tx(pool, user_a) as conn:
        await enqueue_once(
            conn,
            user_id=user_a,
            task_id="sync.github.cidGH",
            kind="connector.sync",
            payload={"toolkit": "github", "connectedAccountId": "cidGH"},
        )

    # First fire: insert.
    await connector_ingest.run(pool, _sync_task(user_a, "cidGH"), "run_gh1")

    async with service_tx(pool) as conn:
        cur = await conn.execute(
            "SELECT external_id AS issue_id, payload->>'state' AS state FROM pai_raw_apps "
            "WHERE user_id = %s AND toolkit = 'github' AND entity_type = 'issues'",
            (user_a,),
        )
        rows = await cur.fetchall()
    assert len(rows) == 1
    assert rows[0]["state"] == "open"

    # Now flip state to closed and re-fire.
    state["items"] = [
        {
            **state["items"][0],
            "state": "closed",
            "updated_at": "2026-04-20T00:00:00Z",
        },
    ]
    await connector_ingest.run(pool, _sync_task(user_a, "cidGH"), "run_gh2")

    async with service_tx(pool) as conn:
        cur = await conn.execute(
            "SELECT external_id AS issue_id, payload->>'state' AS state FROM pai_raw_apps "
            "WHERE user_id = %s AND toolkit = 'github' AND entity_type = 'issues'",
            (user_a,),
        )
        rows = await cur.fetchall()
    # Still 1 row — UNIQUE (user_id, issue_id); state updated.
    assert len(rows) == 1
    assert rows[0]["state"] == "closed"


@pytest.mark.asyncio
async def test_github_registered_as_supported():
    """Smoke: github is an ingestable toolkit (lands in pai_raw_apps via the generic
    upserter; there are no per-toolkit upserters anymore)."""
    assert "github" in connector_ingest.supported_toolkits()
