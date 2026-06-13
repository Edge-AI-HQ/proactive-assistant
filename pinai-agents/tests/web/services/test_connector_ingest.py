"""Unit tests for connector_ingest mappers + the unsupported-toolkit
skipped path.

The Composio-fetch + raw-upsert paths are exercised end-to-end in a
DB-backed test (gmail) so we verify the SQL placeholders + jsonb shapes
match the schema.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from types import SimpleNamespace

import pytest

from pinai_agents.web import composio_service
from pinai_agents.web.auth.user_service import User
from pinai_agents.web.db.repositories.scheduled_tasks import (
    ScheduledTaskRow,
    enqueue_once,
)
from pinai_agents.web.db.rls import service_tx, user_scoped_tx
from pinai_agents.web.routes.ui import onboarding as onboarding_routes
from pinai_agents.web.services import connector_ingest


def _make_task(
    user_id: int,
    payload: dict,
    *,
    task_id: str = "init.t.cid",
    kind: str = "connector.init",
) -> ScheduledTaskRow:
    """Synthesize a row matching what claim_due_tasks would return."""
    return ScheduledTaskRow(
        user_id=user_id,
        id=task_id,
        kind=kind,
        name=None,
        prompt=None,
        trigger_kind="once",
        cron_expr=None,
        interval_seconds=None,
        event_filter=None,
        payload=payload,
        timezone="UTC",
        status="archived",
        next_run_at=None,
        last_run_at=datetime.now(UTC),
        last_run_status="dispatched",
        run_count=1,
        attempts=0,
        max_attempts=3,
        progress={},
        last_error=None,
    )


# ── pure mappers ────────────────────────────────────────────────────────


def test_clamp_limit_defaults_and_bounds():
    assert connector_ingest._clamp_limit(None) == 100
    assert connector_ingest._clamp_limit("not-a-number") == 100
    assert connector_ingest._clamp_limit(0) == 1
    assert connector_ingest._clamp_limit(-50) == 1
    assert connector_ingest._clamp_limit(99999) == 500
    assert connector_ingest._clamp_limit(42) == 42


def test_map_gmail_message_basic():
    raw = {
        "id": "abc123",
        "threadId": "thread-1",
        "subject": "Hi",
        "sender": "alice@example.com",
        "to": "bob@example.com, carol@example.com",
        "messageText": "Hello there",
        "messageTimestamp": "2026-04-24T00:50:54Z",
        "labelIds": ["INBOX", "UNREAD"],
    }
    mapped = connector_ingest._map_gmail_message(raw)
    assert mapped is not None
    assert mapped["message_id"] == "abc123"
    assert mapped["thread_id"] == "thread-1"
    assert mapped["from_addr"] == "alice@example.com"
    assert mapped["to_addrs"] == ["bob@example.com", "carol@example.com"]
    assert mapped["subject"] == "Hi"
    assert mapped["body"] == "Hello there"
    assert mapped["label_ids"] == ["INBOX", "UNREAD"]
    assert mapped["occurred_at"].year == 2026


def test_map_gmail_message_returns_none_without_id():
    # Caller (_upsert_gmail) is the boundary that filters non-dicts,
    # so the mapper trusts the input is a dict.
    assert connector_ingest._map_gmail_message({"subject": "no id"}) is None


def test_map_gcal_event_basic():
    raw = {
        "id": "evt-9",
        "summary": "Lunch",
        "location": "Cafe",
        "start": {"dateTime": "2026-05-10T12:00:00Z"},
        "end": {"dateTime": "2026-05-10T13:00:00Z"},
        "attendees": [
            {"email": "alice@example.com"},
            {"email": "bob@example.com"},
        ],
        "status": "confirmed",
    }
    mapped = connector_ingest._map_gcal_event(raw)
    assert mapped is not None
    assert mapped["event_id"] == "evt-9"
    assert mapped["calendar_id"] == "primary"  # falls back when missing
    assert mapped["title"] == "Lunch"
    assert mapped["attendees"] == ["alice@example.com", "bob@example.com"]
    assert mapped["start_at"] is not None
    assert mapped["end_at"] is not None


def test_map_gcal_event_returns_none_without_id():
    assert connector_ingest._map_gcal_event({"summary": "no id"}) is None


# ── unsupported toolkit short-circuits ─────────────────────────────────


@pytest.mark.asyncio
async def test_run_skips_unsupported_toolkit(pool, user_ids):
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        await enqueue_once(
            conn,
            user_id=user_a,
            task_id="init.dropbox.cidX",
            kind="connector.init",
            payload={"toolkit": "dropbox", "connectedAccountId": "cidX"},
            max_attempts=3,
        )
    task = _make_task(
        user_a,
        {"toolkit": "dropbox", "connectedAccountId": "cidX", "limit": 50},
        task_id="init.dropbox.cidX",
    )
    # Should return cleanly without hitting Composio.
    await connector_ingest.run(pool, task, run_id="run_abc")
    async with service_tx(pool) as conn:
        cur = await conn.execute(
            "SELECT progress FROM pai_scheduled_tasks WHERE user_id=%s AND id=%s",
            (user_a, "init.dropbox.cidX"),
        )
        row = await cur.fetchone()
    assert row is not None
    assert row["progress"]["stage"] == "skipped"
    assert row["progress"]["reason"] == "unsupported_v0"


@pytest.mark.asyncio
async def test_preview_skips_inactive_connection_without_retrying(monkeypatch):
    progress_updates: list[dict] = []

    @asynccontextmanager
    async def fake_user_scoped_tx(_pool, _user_id: int) -> AsyncIterator[object]:
        yield object()

    async def fake_update_progress(_conn, **kwargs):
        progress_updates.append(kwargs["progress"])

    async def fake_wait_active(_cid: str):
        raise composio_service.ComposioError(
            400,
            "Timeout while waiting for connection cid-timeout to be active",
        )

    monkeypatch.setattr(connector_ingest, "user_scoped_tx", fake_user_scoped_tx)
    monkeypatch.setattr(connector_ingest, "update_progress", fake_update_progress)
    monkeypatch.setattr(composio_service, "wait_active", fake_wait_active)

    task = _make_task(
        123,
        {"toolkit": "gmail", "connectedAccountId": "cid-timeout", "limit": 50},
        task_id="preview.gmail.cid-timeout",
        kind="connector.preview",
    )
    await connector_ingest.run(object(), task, run_id="run_preview_timeout")

    assert progress_updates[-1]["stage"] == "skipped"
    assert progress_updates[-1]["reason"] == "connection_not_active"
    assert progress_updates[-1]["status"] == "TIMEOUT"


@pytest.mark.asyncio
async def test_preview_enqueues_full_init_after_summary(monkeypatch):
    events: list[str] = []

    @asynccontextmanager
    async def fake_user_scoped_tx(_pool, _user_id: int) -> AsyncIterator[object]:
        yield object()

    async def fake_update_progress(*_args, **_kwargs):
        return None

    async def fake_wait_active(_cid: str):
        return SimpleNamespace(status="ACTIVE", toolkit="gmail")

    async def fake_load_user_by_id(_pool, user_id: int):
        return User(
            id=user_id,
            supabase_user_id=f"test-sub-{user_id}",
            email=f"user-{user_id}@test.invalid",
            litellm_virtual_key="sk-test",
            browserbase_context_id=None,
        )

    async def fake_run_fetch(*_args, **_kwargs):
        events.append("fetch")
        return [{"id": "gmail-1"}]

    async def fake_upsert(_conn, _user_id: int, _items: list[dict]):
        events.append("raw")
        return 1

    async def fake_build_summary(*_args, **_kwargs):
        events.append("summary")
        return SimpleNamespace(source=SimpleNamespace(item_count=50))

    async def fake_enqueue_full_init(_conn, **_kwargs):
        events.append("init")
        return "init.gmail.cid-active"

    monkeypatch.setattr(connector_ingest, "user_scoped_tx", fake_user_scoped_tx)
    monkeypatch.setattr(connector_ingest, "update_progress", fake_update_progress)
    monkeypatch.setattr(composio_service, "wait_active", fake_wait_active)
    monkeypatch.setattr(connector_ingest, "load_user_by_id", fake_load_user_by_id)
    monkeypatch.setattr(
        connector_ingest.ingest_runner,
        "load_recipe",
        lambda _toolkit: SimpleNamespace(is_ingestable=lambda: True),
    )
    monkeypatch.setattr(
        connector_ingest, "_resolve_subs", lambda *_args: [("gmail", None, fake_upsert)]
    )
    monkeypatch.setattr(connector_ingest.ingest_runner, "run_fetch", fake_run_fetch)
    monkeypatch.setattr(
        onboarding_routes,
        "build_connector_summary_for_onboarding",
        fake_build_summary,
    )
    monkeypatch.setattr(
        connector_ingest, "_enqueue_full_init_after_preview", fake_enqueue_full_init
    )

    task = _make_task(
        123,
        {"toolkit": "gmail", "connectedAccountId": "cid-active", "limit": 50},
        task_id="preview.gmail.cid-active",
        kind="connector.preview",
    )
    await connector_ingest.run(object(), task, run_id="run_preview_active")

    assert events == ["fetch", "raw", "summary", "init"]


@pytest.mark.asyncio
async def test_run_validates_payload(pool, user_ids):
    user_a, _ = user_ids
    bad = _make_task(user_a, {"toolkit": ""}, task_id="init.bad.cid")
    with pytest.raises(ValueError, match="toolkit"):
        await connector_ingest.run(pool, bad, run_id="run_x")
    bad2 = _make_task(user_a, {"toolkit": "gmail"}, task_id="init.bad.cid")
    with pytest.raises(ValueError, match="connectedAccountId"):
        await connector_ingest.run(pool, bad2, run_id="run_y")
