"""Native @tool wrappers — verify they construct the right HTTP request.

Doesn't need a real web — patch http_client.{get,post} and assert the
path / params / headers our wrapper would send. tavily_search isn't
covered here because it's an instance of langchain_tavily.TavilySearch
that calls Tavily's HTTPS API directly (not our http_client) — its
behavior is the partner package's responsibility.

The memory/signals/raw read wrappers were removed in the lifelong-memory
sunset (superseded by events_search); the L1/L2 surface is events_search /
event_append / memory_edit, covered below.
"""

from __future__ import annotations

import pytest
from agent_engine.harness.ctx import run_context
from agent_engine.tools import http_client
from agent_engine.tools.direct import (
    composio_get_tool_schemas,
    composio_manage_connections,
    composio_multi_execute_tool,
    composio_search_tools,
    development_feedback_log,
    event_append,
    events_search,
    feedback_list,
    memory_edit,
)


@pytest.fixture
def mock_http(monkeypatch):
    """Replace http_client.{get,post} with capturing fakes."""
    calls: list[dict] = []

    async def fake_get(path, **params):
        calls.append({"method": "GET", "path": path, "params": params})
        return {"items": []}

    async def fake_post(path, body):
        calls.append({"method": "POST", "path": path, "body": body})
        return {"ok": True}

    monkeypatch.setattr(http_client, "get", fake_get)
    monkeypatch.setattr(http_client, "post", fake_post)
    yield calls


@pytest.fixture
def jwt_ctx():
    """Set the per-run JWT ContextVar so wrappers don't fail validation."""
    with run_context(user_id=42, run_id="run_test", run_jwt="fake-jwt", virtual_key="vk-x"):
        yield


# ── L1 events + L2 portrait (the new unified surface) ──────────────────


@pytest.mark.asyncio
async def test_events_search_path_and_params(mock_http, jwt_ctx):
    await events_search.ainvoke({"query": "investor meeting", "event_type": "meeting", "limit": 10})
    call = mock_http[0]
    assert call["method"] == "GET"
    assert call["path"] == "/api/agent/events/search"
    assert call["params"]["q"] == "investor meeting"
    assert call["params"]["eventType"] == "meeting"
    assert call["params"]["limit"] == 10


@pytest.mark.asyncio
async def test_event_append_post_body(mock_http, jwt_ctx):
    await event_append.ainvoke(
        {
            "event_type": "interaction",
            "title": "user mentioned a trip to Tokyo",
            "body": None,
            "occurred_at": None,
        }
    )
    call = mock_http[0]
    assert call["method"] == "POST"
    assert call["path"] == "/api/agent/events/append"
    assert call["body"]["source"] == "pinai_chat"  # pipeline discriminator (Block1)
    assert call["body"]["eventType"] == "interaction"
    assert call["body"]["title"] == "user mentioned a trip to Tokyo"


@pytest.mark.asyncio
async def test_memory_edit_post_body(mock_http, jwt_ctx):
    await memory_edit.ainvoke(
        {"slot": "USER", "operations": [{"op": "add", "text": "founder @ PIN AI", "target": ""}]}
    )
    call = mock_http[0]
    assert call["method"] == "POST"
    assert call["path"] == "/api/agent/user-strings/edit"
    assert call["body"]["slot"] == "USER"
    assert call["body"]["operations"][0]["op"] == "add"
    assert call["body"]["operations"][0]["text"] == "founder @ PIN AI"


# ── retained tools (cards / feedback / dev / composio) ─────────────────


@pytest.mark.asyncio
async def test_feedback_list_path(mock_http, jwt_ctx):
    await feedback_list.ainvoke({"kind": "card_action", "action": "dismiss", "limit": 20})
    call = mock_http[0]
    assert call["path"] == "/api/agent/feedback/list"
    assert call["params"]["kind"] == "card_action"
    assert call["params"]["action"] == "dismiss"
    assert call["params"]["limit"] == 20


@pytest.mark.asyncio
async def test_development_feedback_log_post_body(mock_http, jwt_ctx):
    await development_feedback_log.ainvoke(
        {
            "text": "Can you add an export button to these cards?",
            "summary": "User wants an export button on cards.",
            "category": "ui",
            "surface": "main_chat",
            "conversation_id": "thread_main",
            "message_id": "msg_123",
            "metadata": {"requested_control": "export_button"},
        }
    )
    call = mock_http[0]
    assert call["method"] == "POST"
    assert call["path"] == "/api/agent/development-feedback/log"
    assert call["body"] == {
        "text": "Can you add an export button to these cards?",
        "summary": "User wants an export button on cards.",
        "category": "ui",
        "surface": "main_chat",
        "conversationId": "thread_main",
        "messageId": "msg_123",
        "metadata": {"requested_control": "export_button"},
    }


@pytest.mark.asyncio
async def test_development_feedback_log_defaults_conversation_id_from_session(mock_http):
    with run_context(
        user_id=42,
        run_id="run_test",
        run_jwt="fake-jwt",
        virtual_key="vk-x",
        session_key="main-42-session",
    ):
        await development_feedback_log.ainvoke(
            {
                "text": "Can you add an export button to these cards?",
                "category": "feature",
            }
        )
    assert mock_http[0]["body"]["conversationId"] == "main-42-session"


@pytest.mark.asyncio
async def test_composio_search_tools_post(mock_http, jwt_ctx):
    await composio_search_tools.ainvoke(
        {"queries": [{"use_case": "send a quick email to recipient"}]}
    )
    call = mock_http[0]
    assert call["method"] == "POST"
    assert call["path"] == "/api/agent/composio/meta/SEARCH_TOOLS"
    assert call["body"]["args"]["queries"][0]["use_case"].startswith("send")


@pytest.mark.asyncio
async def test_composio_get_tool_schemas_post(mock_http, jwt_ctx):
    await composio_get_tool_schemas.ainvoke({"tool_slugs": ["GMAIL_CREATE_EMAIL_DRAFT"]})
    call = mock_http[0]
    assert call["path"] == "/api/agent/composio/meta/GET_TOOL_SCHEMAS"
    assert call["body"]["args"]["tool_slugs"] == ["GMAIL_CREATE_EMAIL_DRAFT"]


@pytest.mark.asyncio
async def test_composio_multi_execute_post(mock_http, jwt_ctx):
    await composio_multi_execute_tool.ainvoke(
        {
            "calls": [
                {
                    "tool_slug": "GMAIL_CREATE_EMAIL_DRAFT",
                    "arguments": {"to": "x@y", "subject": "hi"},
                },
            ],
        }
    )
    call = mock_http[0]
    assert call["method"] == "POST"
    assert call["path"] == "/api/agent/composio/meta/MULTI_EXECUTE_TOOL"
    assert call["body"]["args"]["tools"][0]["tool_slug"] == "GMAIL_CREATE_EMAIL_DRAFT"
    assert call["body"]["args"]["sync_response_to_workbench"] is False


@pytest.mark.asyncio
async def test_composio_manage_connections_post(mock_http, jwt_ctx):
    await composio_manage_connections.ainvoke({"toolkits": ["gmail", "gcal"]})
    call = mock_http[0]
    assert call["path"] == "/api/agent/composio/meta/MANAGE_CONNECTIONS"
    assert call["body"]["args"]["toolkits"] == ["gmail", "gcal"]
