"""Slack connector — extractor / mapper / DB round-trip.

Covers:
  * Slack search response envelope (.messages.matches[]) extraction
  * Slack timestamp ('1234567890.123456') → datetime parse
  * Slack mapper handles both nested (.channel.{id,name}) and flat shapes
  * Slack INSERT … ON CONFLICT DO NOTHING (immutable messages)
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

# ── Slack mappers ───────────────────────────────────────────────────────


def test_slack_ts_to_datetime():
    dt = connector_ingest._slack_ts_to_datetime("1714521600.123456")
    assert dt is not None
    assert dt.year == 2024
    assert connector_ingest._slack_ts_to_datetime("not-a-number") is None
    assert connector_ingest._slack_ts_to_datetime(None) is None


def test_map_slack_message_nested_channel():
    raw = {
        "ts": "1714521600.123456",
        "channel": {"id": "C123", "name": "general"},
        "user": {"id": "U999", "name": "alice"},
        "text": "hello",
        "permalink": "https://example.slack.com/archives/C123/p1714521600",
        "thread_ts": "1714521000.000000",
    }
    mapped = connector_ingest._map_slack_message(raw)
    assert mapped is not None
    assert mapped["channel_id"] == "C123"
    assert mapped["channel_name"] == "general"
    assert mapped["ts"] == "1714521600.123456"
    assert mapped["thread_ts"] == "1714521000.000000"
    assert mapped["slack_user_id"] == "U999"
    assert mapped["slack_user_name"] == "alice"
    assert mapped["text"] == "hello"
    assert mapped["occurred_at"].year == 2024


def test_map_slack_message_flat_channel_string():
    """Raw Slack API form: channel is a string, no .name available."""
    raw = {
        "ts": "1714521600.0",
        "channel": "C456",
        "user": "U001",
        "text": "yo",
        "username": "bot-user",
    }
    mapped = connector_ingest._map_slack_message(raw)
    assert mapped is not None
    assert mapped["channel_id"] == "C456"
    assert mapped["channel_name"] is None
    assert mapped["slack_user_id"] == "U001"


def test_map_slack_message_returns_none_without_ts():
    assert (
        connector_ingest._map_slack_message(
            {"channel": {"id": "C1"}, "text": "no ts"},
        )
        is None
    )


def test_map_slack_message_returns_none_without_channel():
    assert (
        connector_ingest._map_slack_message(
            {"ts": "1.0", "text": "no channel"},
        )
        is None
    )


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


def _patch_fetch(monkeypatch, toolkit: str, items: list[dict]):
    """Replace ingest_runner.run_fetch so connector_ingest gets test items
    without hitting Composio. Real upserter still runs against the DB."""
    from pinai_api.domains.connector.apps import ingest_runner

    async def fake_fetch(user_id, tk, cid, *, limit=100, since=None, pool=None):
        if tk == toolkit:
            return list(items)
        return []

    monkeypatch.setattr(ingest_runner, "run_fetch", fake_fetch)
    _ = SimpleNamespace


@pytest.mark.asyncio
async def test_slack_sync_writes_messages_immutably(pool, user_ids, monkeypatch):
    """Same (channel_id, ts) on second run must NOT create a duplicate
    row — Slack messages are immutable by ts."""
    user_a, _ = user_ids
    msg = {
        "ts": "1714521600.123456",
        "channel": {"id": "Cabc", "name": "engineering"},
        "user": {"id": "U1", "name": "alice"},
        "text": "ship the feature",
    }
    _patch_fetch(monkeypatch, "slack", [msg])

    async with user_scoped_tx(pool, user_a) as conn:
        await enqueue_once(
            conn,
            user_id=user_a,
            task_id="sync.slack.cidS",
            kind="connector.sync",
            payload={"toolkit": "slack", "connectedAccountId": "cidS"},
        )

    await connector_ingest.run(pool, _sync_task("slack", user_a, "cidS"), "rs1")
    await connector_ingest.run(pool, _sync_task("slack", user_a, "cidS"), "rs2")

    async with service_tx(pool) as conn:
        cur = await conn.execute(
            "SELECT id FROM pai_raw_slack_messages WHERE user_id = %s",
            (user_a,),
        )
        rows = await cur.fetchall()
    assert len(rows) == 1


@pytest.mark.asyncio
async def test_slack_registered():
    assert "slack" in connector_ingest.supported_toolkits()
