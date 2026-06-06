"""Tests for the `/agent/chat/history` filter + cursor pagination.

Unit-level coverage of `_is_debug_only` and `_oldest_cursor` (rule
correctness without an HTTP round-trip), plus a small `TestClient`-driven
matrix on the endpoint itself (filter / cursor slice / stale cursor / empty
thread) using a fake `_get_thread_messages` so no real checkpointer or
DATABASE_URL is needed.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from langchain_core.messages import AIMessage, HumanMessage

from pinai_agents.chat.transport.routes import history as history_mod
from pinai_agents.chat.transport.routes.history import (
    _is_debug_only,
    _oldest_cursor,
)
from pinai_agents.chat.transport.routes.history import (
    router as history_router,
)

# ─── _is_debug_only ────────────────────────────────────────────────────


def test_is_debug_only_heartbeat_is_always_debug() -> None:
    assert _is_debug_only({"role": "heartbeat", "parts": [{"type": "text", "text": "[heartbeat]"}]})


def test_is_debug_only_user_message_is_never_debug() -> None:
    assert not _is_debug_only({"role": "user", "parts": [{"type": "text", "text": "hi"}]})


def test_is_debug_only_user_triggered_assistant_is_never_debug() -> None:
    assert not _is_debug_only(
        {
            "role": "assistant",
            "trigger": "user",
            "parts": [{"type": "text", "text": "reply"}],
        }
    )


def test_is_debug_only_tick_turn_without_notify_user_is_debug() -> None:
    """A heartbeat-triggered turn that only thought / called other tools
    is private scratchpad — debug-only."""
    assert _is_debug_only(
        {
            "role": "assistant",
            "trigger": "tick",
            "parts": [
                {"type": "reasoning", "text": "thinking…"},
                {"type": "tool-call", "toolName": "memory_search", "toolCallId": "x"},
            ],
        }
    )


def test_is_debug_only_tick_turn_with_notify_user_is_visible() -> None:
    """The only thing in a tick turn the user is meant to see is a
    `notify_user` outreach — turn must surface."""
    assert not _is_debug_only(
        {
            "role": "assistant",
            "trigger": "tick",
            "parts": [
                {"type": "reasoning", "text": "decided to ping"},
                {"type": "tool-call", "toolName": "notify_user", "toolCallId": "n"},
            ],
        }
    )


# ─── _oldest_cursor ────────────────────────────────────────────────────


def test_oldest_cursor_returns_first_uuid_like_id() -> None:
    assert (
        _oldest_cursor(
            [
                {"id": "a1b2c3"},
                {"id": "later"},
            ]
        )
        == "a1b2c3"
    )


def test_oldest_cursor_skips_msg_index_fallback() -> None:
    """`msg_42` ids shift when the thread grows; they're not safe cursors,
    so `_oldest_cursor` walks forward to the next stable id."""
    assert (
        _oldest_cursor(
            [
                {"id": "msg_0"},
                {"id": "msg_1"},
                {"id": "real-uuid"},
                {"id": "msg_2"},
            ]
        )
        == "real-uuid"
    )


def test_oldest_cursor_none_when_only_fallback_ids() -> None:
    assert _oldest_cursor([{"id": "msg_0"}, {"id": "msg_1"}]) is None


def test_oldest_cursor_none_when_empty() -> None:
    assert _oldest_cursor([]) is None


# ─── endpoint integration ──────────────────────────────────────────────


@pytest.fixture()
def client(monkeypatch: pytest.MonkeyPatch):
    """A `TestClient` for an app exposing only `history_router`, with
    `_get_thread_messages` patchable per-test via `monkeypatch`.

    The endpoint runs run-JWT session auth (`principal_from_header` +
    `assert_session_key_principal`); these tests cover the filter / cursor
    logic, not auth (that has its own coverage in `_session_auth`), so bypass
    both — otherwise every request 401s before reaching the logic under test.
    """
    monkeypatch.setattr(history_mod, "principal_from_header", lambda *a, **k: None)
    monkeypatch.setattr(history_mod, "assert_session_key_principal", lambda *a, **k: None)
    app = FastAPI()
    app.include_router(history_router)
    return TestClient(app)


def _hb(text: str, mid: str) -> HumanMessage:
    return HumanMessage(
        content=text,
        id=mid,
        additional_kwargs={"proactive_kind": "tick"},
    )


def _user(text: str, mid: str) -> HumanMessage:
    return HumanMessage(
        content=text,
        id=mid,
        additional_kwargs={"proactive_kind": "user"},
    )


def _notify_call(call_id: str) -> dict[str, Any]:
    return {"id": call_id, "name": "notify_user", "args": {"message": "hello"}}


def test_empty_thread_returns_clean_pagination(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_messages(_session_key: str):
        return []

    monkeypatch.setattr(history_mod, "_get_thread_messages", fake_messages)

    r = client.get("/agent/chat/history", params={"session_key": "empty"})
    assert r.status_code == 200
    assert r.json() == {
        "ok": True,
        "messages": [],
        "hasMore": False,
        "oldestCursor": None,
    }


def test_include_debug_false_filters_heartbeat_and_silent_tick_turn(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """3 heartbeats + their silent tick turns + 1 real user exchange:
    debug-off should return only the user turn."""
    raw = [
        _hb("[heartbeat] t1", "hb-1"),
        AIMessage(id="a-silent-1", content=[{"type": "reasoning", "text": "…"}]),
        _hb("[heartbeat] t2", "hb-2"),
        AIMessage(id="a-silent-2", content="thinking-only"),
        _user("hi", "u-1"),
        AIMessage(id="a-reply", content="hello!"),
    ]

    async def fake_messages(_):
        return raw

    monkeypatch.setattr(history_mod, "_get_thread_messages", fake_messages)

    r = client.get("/agent/chat/history", params={"session_key": "k"})
    data = r.json()
    roles = [(m["role"], m.get("trigger")) for m in data["messages"]]
    assert roles == [("user", None), ("assistant", "user")]
    assert data["hasMore"] is False


def test_include_debug_false_keeps_tick_turn_with_notify_user(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A heartbeat-triggered turn carrying a notify_user tool call surfaces
    even when Debug is off — the heartbeat INPUT is still filtered, but
    the reaching-out is exactly what the user wants to see."""
    raw = [
        _hb("[heartbeat] t1", "hb-1"),
        AIMessage(
            id="a-notify",
            content="",
            tool_calls=[_notify_call("tc-1")],
        ),
    ]

    async def fake_messages(_):
        return raw

    monkeypatch.setattr(history_mod, "_get_thread_messages", fake_messages)

    r = client.get("/agent/chat/history", params={"session_key": "k"})
    data = r.json()
    assert len(data["messages"]) == 1
    only = data["messages"][0]
    assert only["role"] == "assistant"
    assert only["trigger"] == "tick"
    tool_names = [p.get("toolName") for p in only["parts"] if p.get("type") == "tool-call"]
    assert "notify_user" in tool_names


def test_include_debug_true_returns_unfiltered_history(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    raw = [
        _hb("[heartbeat] t1", "hb-1"),
        AIMessage(id="a-silent-1", content="silent thinking"),
        _user("hi", "u-1"),
        AIMessage(id="a-reply", content="hello!"),
    ]

    async def fake_messages(_):
        return raw

    monkeypatch.setattr(history_mod, "_get_thread_messages", fake_messages)

    r = client.get(
        "/agent/chat/history",
        params={"session_key": "k", "include_debug": 1},
    )
    roles = [m["role"] for m in r.json()["messages"]]
    assert roles == ["heartbeat", "assistant", "user", "assistant"]


def test_limit_returns_newest_page_and_advertises_has_more(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """4 user turns; limit=2 returns the latest two and says hasMore=true."""
    raw = []
    for i in range(4):
        raw.append(_user(f"msg-{i}", f"u-{i}"))
        raw.append(AIMessage(id=f"a-{i}", content=f"reply-{i}"))

    async def fake_messages(_):
        return raw

    monkeypatch.setattr(history_mod, "_get_thread_messages", fake_messages)

    r = client.get(
        "/agent/chat/history",
        params={"session_key": "k", "limit": 2},
    )
    data = r.json()
    assert [m["id"] for m in data["messages"]] == ["u-3", "a-3"]
    assert data["hasMore"] is True
    assert data["oldestCursor"] == "u-3"


def test_before_cursor_returns_previous_page(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    raw = []
    for i in range(4):
        raw.append(_user(f"msg-{i}", f"u-{i}"))
        raw.append(AIMessage(id=f"a-{i}", content=f"reply-{i}"))

    async def fake_messages(_):
        return raw

    monkeypatch.setattr(history_mod, "_get_thread_messages", fake_messages)

    r = client.get(
        "/agent/chat/history",
        params={"session_key": "k", "limit": 2, "before": "u-3"},
    )
    data = r.json()
    assert [m["id"] for m in data["messages"]] == ["u-2", "a-2"]
    assert data["hasMore"] is True
    assert data["oldestCursor"] == "u-2"


def test_stale_cursor_returns_400(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    raw = [_user("hi", "u-1"), AIMessage(id="a-1", content="hello")]

    async def fake_messages(_):
        return raw

    monkeypatch.setattr(history_mod, "_get_thread_messages", fake_messages)

    r = client.get(
        "/agent/chat/history",
        params={"session_key": "k", "before": "not-a-real-id"},
    )
    assert r.status_code == 400
    assert "stale cursor" in r.json()["detail"]


def test_omitting_limit_returns_full_history_for_backfill(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`call_chat_history` (main-chat backfill) sends no `limit`; the endpoint
    must return the FULL thread, not a 200/500-capped page — otherwise a long
    pre-existing thread loses its oldest turns when web /chat-stream/history
    seeds pai_chat_messages from the checkpoint on first read."""
    raw = [_user(f"m{i}", f"u-{i}") for i in range(600)]

    async def fake_messages(_):
        return raw

    monkeypatch.setattr(history_mod, "_get_thread_messages", fake_messages)

    r = client.get("/agent/chat/history", params={"session_key": "k"})
    data = r.json()
    # Uncapped: not 200 (old default) nor 500 (_MAX_LIMIT).
    assert len(data["messages"]) == 600
    assert data["hasMore"] is False
    assert data["oldestCursor"] == "u-0"
