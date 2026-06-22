from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from agent_engine.agents.generation_context import (
    _raw_sources_from_connections,
    build_generation_context,
    compute_context_window,
)


def test_raw_sources_prefer_server_raw_sources_over_static_map():
    connections = [
        # Generic toolkit — only discoverable via the server-provided field.
        {"toolkit": "notion", "rawSources": [{"toolkit": "notion", "entity": "pages"}]},
        # Fanout toolkit — one connection expands to several sources.
        {
            "toolkit": "googlesuper",
            "rawSources": [
                {"toolkit": "gmail", "entity": "messages"},
                {"toolkit": "gcal", "entity": "events"},
                {"toolkit": "gdrive", "entity": "files"},
                {"toolkit": "googledocs", "entity": "documents"},
                {"toolkit": "googlesheets", "entity": "spreadsheets"},
            ],
        },
        # Older payload without rawSources — static map fallback.
        {"toolkit": "github"},
        # connect_only — server sends [], static map has no entry either.
        {"toolkit": "discord", "rawSources": []},
    ]
    sources = _raw_sources_from_connections(connections)
    assert ("notion", "pages") in sources
    assert ("gdrive", "files") in sources
    assert ("googledocs", "documents") in sources
    assert ("googlesheets", "spreadsheets") in sources
    assert ("gcal", "events") in sources
    assert ("github", "issues") in sources
    assert all(tk != "discord" for tk, _ in sources)
    # No duplicates even though gmail comes from both _BASE and googlesuper.
    assert sources.count(("gmail", "messages")) == 1


def test_context_window_keeps_at_least_24h_when_last_success_is_recent():
    now = datetime(2026, 6, 4, 12, 0, tzinfo=UTC)
    last_success_at = now - timedelta(hours=6)

    window = compute_context_window(now=now, last_success_at=last_success_at)

    assert window.since == now - timedelta(hours=24)
    assert window.until == now
    assert window.reason == "min_24h"


def test_context_window_extends_to_last_success_when_cycle_is_older_than_24h():
    now = datetime(2026, 6, 4, 12, 0, tzinfo=UTC)
    last_success_at = now - timedelta(hours=30)

    window = compute_context_window(now=now, last_success_at=last_success_at)

    assert window.since == last_success_at
    assert window.until == now
    assert window.reason == "last_success"


@pytest.mark.asyncio
async def test_context_builder_pages_connected_raw_until_exhausted(monkeypatch):
    calls: list[dict[str, Any]] = []
    now = datetime(2026, 6, 4, 12, 0, tzinfo=UTC)
    since = now - timedelta(hours=24)

    async def fake_get(path: str, **params: Any) -> dict[str, Any]:
        calls.append({"path": path, "params": params})
        if path == "/api/agent/profile/get":
            return {
                "profile": {"summary": "Builds PIN AI"},
                "goals": [{"id": "goal_cards", "title": "Improve generated cards"}],
            }
        if path == "/api/agent/memory/list":
            return {"items": []}
        if path == "/api/agent/signals/recent":
            return {"items": []}
        if path == "/api/agent/cards/recent":
            return {"items": []}
        if path == "/api/agent/feedback/list":
            return {"items": []}
        if path == "/api/agent/world/recent":
            assert params["since"] == since.isoformat()
            assert params["until"] == now.isoformat()
            return {"items": []}
        if path == "/api/agent/preferences/list":
            return {"items": []}
        if path == "/api/agent/composio/connections":
            return {
                "items": [
                    {"toolkit": {"slug": "gmail"}},
                    {"toolkit": {"slug": "slack"}},
                ]
            }
        if path == "/api/agent/raw/gmail/messages":
            offset = int(params["offset"])
            if offset == 0:
                return {"items": [{"id": "gmail-0"}, {"id": "gmail-1"}]}
            if offset == 2:
                return {"items": [{"id": "gmail-2"}]}
            return {"items": []}
        if path == "/api/agent/raw/slack/messages":
            return {"_error": "ConnectError: down"}
        raise AssertionError(f"unexpected path {path}")

    from agent_engine.agents import generation_context

    monkeypatch.setattr(generation_context.http_client, "get", fake_get)

    context = await build_generation_context(
        now=now,
        context_since=since,
        raw_page_size=2,
    )

    assert [item["id"] for item in context["connected_raw"]["gmail/messages"]] == [
        "gmail-0",
        "gmail-1",
        "gmail-2",
    ]
    assert context["profile"] == {"summary": "Builds PIN AI"}
    assert context["goals"] == [{"id": "goal_cards", "title": "Improve generated cards"}]
    assert context["gmail"] == context["connected_raw"]["gmail/messages"]
    assert context["context_stats"]["connected_raw"]["gmail/messages"]["count"] == 3
    assert context["context_stats"]["connected_raw"]["slack/messages"]["error"] == (
        "ConnectError: down"
    )
    raw_calls = [call for call in calls if call["path"] == "/api/agent/raw/gmail/messages"]
    assert [call["params"]["offset"] for call in raw_calls] == [0, 2]
    assert all(call["params"]["limit"] == 2 for call in raw_calls)
    assert all(call["params"]["since"] == since.isoformat() for call in raw_calls)
    assert all(call["params"]["until"] == now.isoformat() for call in raw_calls)
