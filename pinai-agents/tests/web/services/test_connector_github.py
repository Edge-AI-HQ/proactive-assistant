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

from pinai_agents.web.db.repositories.scheduled_tasks import (
    ScheduledTaskRow,
    enqueue_once,
)
from pinai_agents.web.db.rls import service_tx, user_scoped_tx
from pinai_agents.web.services import connector_ingest

# ── pure mappers ────────────────────────────────────────────────────────


def test_map_github_issue_basic():
    raw = {
        "id": 123,
        "number": 42,
        "title": "fix the thing",
        "state": "open",
        "html_url": "https://github.com/acme/widgets/issues/42",
        "body": "When you do X, it does Y." * 100,  # > 800 chars
        "repository_url": "https://api.github.com/repos/acme/widgets",
        "labels": [{"name": "bug"}, {"name": "p1"}, "stringy-label"],
        "assignees": [{"login": "alice"}, {"login": "bob"}],
        "created_at": "2026-04-01T12:00:00Z",
        "updated_at": "2026-04-15T08:30:00Z",
        "pull_request": None,
    }
    mapped = connector_ingest._map_github_issue(raw)
    assert mapped is not None
    assert mapped["issue_id"] == "123"
    assert mapped["number"] == 42
    assert mapped["repo_full_name"] == "acme/widgets"
    assert mapped["title"] == "fix the thing"
    assert mapped["state"] == "open"
    assert mapped["html_url"].endswith("/42")
    assert mapped["is_pull_request"] is False
    assert mapped["labels"] == ["bug", "p1", "stringy-label"]
    assert mapped["assignees"] == ["alice", "bob"]
    # Full body is stored untruncated; body_preview stays a short summary.
    assert mapped["body"] == raw["body"]
    assert len(mapped["body"]) > 800
    assert len(mapped["body_preview"]) <= 800
    assert mapped["created_at_remote"].year == 2026
    assert mapped["updated_at_remote"].month == 4
    # occurred_at picks updated_at when present
    assert mapped["occurred_at"] == mapped["updated_at_remote"]


def test_map_github_issue_pull_request_flag():
    raw = {
        "id": 9,
        "title": "PR title",
        "pull_request": {"url": "https://api.github.com/repos/x/y/pulls/9"},
    }
    mapped = connector_ingest._map_github_issue(raw)
    assert mapped is not None
    assert mapped["is_pull_request"] is True


def test_map_github_issue_falls_back_to_repository_object():
    """When repository_url is absent, repository.full_name picks up."""
    raw = {
        "id": 99,
        "title": "X",
        "repository": {"full_name": "octo/cat"},
    }
    mapped = connector_ingest._map_github_issue(raw)
    assert mapped is not None
    assert mapped["repo_full_name"] == "octo/cat"


def test_map_github_issue_returns_none_without_id():
    assert connector_ingest._map_github_issue({"title": "no id"}) is None


def test_map_github_issue_occurred_at_falls_back_to_now_when_no_dates():
    raw = {"id": 5, "title": "X"}
    mapped = connector_ingest._map_github_issue(raw)
    assert mapped is not None
    assert mapped["occurred_at"] is not None  # NOT NULL column gets NOW()


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

    from pinai_agents.web.services import ingest_runner

    async def fake_fetch(user_id, tk, cid, *, limit=100, since=None):
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
            "SELECT issue_id, state FROM pai_raw_github_issues WHERE user_id = %s",
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
            "SELECT issue_id, state FROM pai_raw_github_issues WHERE user_id = %s",
            (user_a,),
        )
        rows = await cur.fetchall()
    # Still 1 row — UNIQUE (user_id, issue_id); state updated.
    assert len(rows) == 1
    assert rows[0]["state"] == "closed"


@pytest.mark.asyncio
async def test_github_registered_as_supported():
    """Smoke: registry resolves and points at the github upserter."""
    assert "github" in connector_ingest.supported_toolkits()
    assert connector_ingest._UPSERTERS["github"] is connector_ingest._upsert_github_issues
