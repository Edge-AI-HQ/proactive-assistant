"""slack + notion connectors — extractor / mapper / DB round-trip.

Covers:
  * Slack search response envelope (.messages.matches[]) extraction
  * Slack timestamp ('1234567890.123456') → datetime parse
  * Slack mapper handles both nested (.channel.{id,name}) and flat shapes
  * Notion slim shape ({id, title, type}) → row
  * Notion rich shape (properties.title.title[].plain_text) fallback
  * Slack INSERT … ON CONFLICT DO NOTHING (immutable messages)
  * Notion INSERT … ON CONFLICT DO UPDATE (pages mutate)
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

# ── Slack mappers ───────────────────────────────────────────────────────


def test_extract_slack_messages_unwraps_search_envelope():
    response = {
        "data": {
            "messages": {
                "matches": [{"ts": "1.0", "text": "a"}, {"ts": "2.0", "text": "b"}],
            },
        },
    }
    msgs = connector_ingest._extract_slack_messages(response)
    assert len(msgs) == 2
    assert msgs[0]["text"] == "a"


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
    assert connector_ingest._map_slack_message(
        {"channel": {"id": "C1"}, "text": "no ts"},
    ) is None


def test_map_slack_message_returns_none_without_channel():
    assert connector_ingest._map_slack_message(
        {"ts": "1.0", "text": "no channel"},
    ) is None


# ── Notion mappers ──────────────────────────────────────────────────────


def test_extract_notion_pages_composio_shape():
    """Composio NOTION_FETCH_DATA returns under data.values."""
    response = {"data": {"values": [
        {"id": "p1", "title": "Page A"},
        {"id": "p2", "title": "Page B"},
    ]}}
    pages = connector_ingest._extract_notion_pages(response)
    assert len(pages) == 2
    assert pages[0]["title"] == "Page A"


def test_extract_notion_pages_raw_api_shape():
    """Raw Notion API uses { results: [...] }."""
    response = {"data": {"results": [{"id": "r1"}]}}
    pages = connector_ingest._extract_notion_pages(response)
    assert pages == [{"id": "r1"}]


def test_map_notion_page_slim_shape():
    raw = {"id": "abc-123", "title": "Quick notes", "type": "page"}
    mapped = connector_ingest._map_notion_page(raw)
    assert mapped is not None
    assert mapped["page_id"] == "abc-123"
    assert mapped["title"] == "Quick notes"
    assert mapped["parent_type"] == "page"
    assert mapped["archived"] is False


def test_map_notion_page_rich_shape_with_properties():
    """Raw Notion API embeds title under properties.title.title[].plain_text."""
    raw = {
        "id": "p-99",
        "url": "https://notion.so/p99",
        "properties": {
            "title": {"title": [{"plain_text": "Project plan"}]},
        },
        "parent": {"type": "page_id", "page_id": "parent-1"},
        "icon": {"emoji": "📝"},
        "last_edited_time": "2026-04-15T10:00:00Z",
        "created_time": "2026-04-01T00:00:00Z",
    }
    mapped = connector_ingest._map_notion_page(raw)
    assert mapped is not None
    assert mapped["title"] == "Project plan"
    assert mapped["parent_id"] == "parent-1"
    assert mapped["parent_type"] == "page_id"
    assert mapped["icon"] == "📝"
    assert mapped["last_edited_time"].year == 2026
    assert mapped["occurred_at"] == mapped["last_edited_time"]


def test_map_notion_page_returns_none_without_id():
    assert connector_ingest._map_notion_page({"title": "no id"}) is None


def test_map_notion_page_archived_flag():
    raw = {"id": "p1", "title": "X", "archived": True}
    mapped = connector_ingest._map_notion_page(raw)
    assert mapped is not None
    assert mapped["archived"] is True


# ── DB-backed sync round-trips with mocked fetchers ─────────────────────


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


def _patch_fetch(monkeypatch, toolkit: str, items: list[dict]):
    real = connector_ingest._ADAPTERS[toolkit]

    async def fake_fetch(api_key, cx_user_id, cid, limit, since):
        return list(items)

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
            conn, user_id=user_a, task_id="sync.slack.cidS",
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
async def test_notion_sync_updates_page_on_re_edit(pool, user_ids, monkeypatch):
    """Page title/last_edited_time changes between syncs — second sync
    UPDATES the same row (UNIQUE on user_id, page_id)."""
    user_a, _ = user_ids
    state = {"items": [
        {
            "id": "page-X",
            "title": "Draft",
            "last_edited_time": "2026-04-01T00:00:00Z",
            "url": "https://notion.so/x",
        },
    ]}

    real = connector_ingest._ADAPTERS["notion"]

    async def fake_fetch(api_key, cx_user_id, cid, limit, since):
        return list(state["items"])

    monkeypatch.setitem(
        connector_ingest._ADAPTERS, "notion",
        connector_ingest.ToolkitAdapter(
            toolkit="notion", raw_table=real.raw_table,
            fetch=fake_fetch, upsert=real.upsert,
        ),
    )
    monkeypatch.setattr(
        connector_ingest, "get_web_settings",
        lambda: SimpleNamespace(composio_api_key="test-key"),
    )

    async with user_scoped_tx(pool, user_a) as conn:
        await enqueue_once(
            conn, user_id=user_a, task_id="sync.notion.cidN",
            kind="connector.sync",
            payload={"toolkit": "notion", "connectedAccountId": "cidN"},
        )

    await connector_ingest.run(pool, _sync_task("notion", user_a, "cidN"), "rn1")

    state["items"] = [
        {
            "id": "page-X",
            "title": "Final spec",
            "last_edited_time": "2026-04-20T00:00:00Z",
            "url": "https://notion.so/x",
        },
    ]
    await connector_ingest.run(pool, _sync_task("notion", user_a, "cidN"), "rn2")

    async with service_tx(pool) as conn:
        cur = await conn.execute(
            "SELECT title, last_edited_time FROM pai_raw_notion_pages "
            "WHERE user_id = %s",
            (user_a,),
        )
        rows = await cur.fetchall()
    assert len(rows) == 1
    assert rows[0]["title"] == "Final spec"
    assert rows[0]["last_edited_time"].day == 20


@pytest.mark.asyncio
async def test_slack_and_notion_registered():
    assert "slack" in connector_ingest.supported_toolkits()
    assert "notion" in connector_ingest.supported_toolkits()
