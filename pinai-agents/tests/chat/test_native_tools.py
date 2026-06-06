"""Native @tool wrappers — verify they construct the right HTTP request.

Doesn't need a real web — patch http_client.{get,post} and assert the
path / params / headers our wrapper would send. tavily_search isn't
covered here because it's an instance of langchain_tavily.TavilySearch
that calls Tavily's HTTPS API directly (not our http_client) — its
behavior is the partner package's responsibility.
"""

from __future__ import annotations

import pytest

from pinai_agents.chat.harness.ctx import run_context
from pinai_agents.chat.tools import http_client
from pinai_agents.chat.tools.direct import (
    cards_recent,
    composio_get_tool_schemas,
    composio_manage_connections,
    composio_multi_execute_tool,
    composio_search_tools,
    development_feedback_log,
    feedback_list,
    memory_add,
    memory_get,
    memory_list,
    memory_search,
    profile_get,
    raw_gcal_today,
    raw_gcal_week,
    raw_gmail_recent,
    raw_list,
    signals_get,
    signals_recent,
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


@pytest.mark.asyncio
async def test_memory_list_path_and_params(mock_http, jwt_ctx):
    await memory_list.ainvoke({"min_quality": 0.8, "subject": "work", "limit": 5})
    assert len(mock_http) == 1
    call = mock_http[0]
    assert call["method"] == "GET"
    assert call["path"] == "/api/agent/memory/list"
    assert call["params"] == {"minQuality": 0.8, "subject": "work", "limit": 5}


@pytest.mark.asyncio
async def test_memory_search_path_and_params(mock_http, jwt_ctx):
    await memory_search.ainvoke({"query": "dark mode", "min_quality": 0.6, "limit": 3})
    call = mock_http[0]
    assert call["method"] == "GET"
    assert call["path"] == "/api/agent/memory/search"
    assert call["params"]["q"] == "dark mode"
    assert call["params"]["minQuality"] == 0.6
    assert call["params"]["limit"] == 3


@pytest.mark.asyncio
async def test_memory_get_path(mock_http, jwt_ctx):
    await memory_get.ainvoke({"id": "mem_x"})
    assert mock_http[0]["path"] == "/api/agent/memory/get/mem_x"


@pytest.mark.asyncio
async def test_memory_add_post_body(mock_http, jwt_ctx):
    await memory_add.ainvoke(
        {
            "text": "user prefers dark mode",
            "source": "chat",
            "subject": "ui",
            "quality": 0.7,
        }
    )
    call = mock_http[0]
    assert call["method"] == "POST"
    assert call["path"] == "/api/agent/memory/add"
    assert call["body"]["text"] == "user prefers dark mode"
    assert call["body"]["subject"] == "ui"


@pytest.mark.asyncio
async def test_signals_recent_path(mock_http, jwt_ctx):
    await signals_recent.ainvoke({"status": "open", "kind": None, "hours": 12, "limit": 5})
    call = mock_http[0]
    assert call["path"] == "/api/agent/signals/recent"
    # kind=None passes through; real http_client.get strips Nones, the
    # mock keeps them — we assert presence of the meaningful keys instead.
    assert call["params"]["status"] == "open"
    assert call["params"]["hours"] == 12
    assert call["params"]["limit"] == 5


@pytest.mark.asyncio
async def test_signals_recent_keeps_ambient_speaker_preview(monkeypatch, jwt_ctx):
    async def fake_get(path, **params):
        return {
            "items": [
                {
                    "id": "sig_ambient",
                    "kind": "ambient.candidate_window",
                    "title": "Ambient transcript",
                    "summary": 'speaker_1: "lunch?"',
                    "speakerText": 'speaker_1: "lunch?"\nself: "after the review"',
                    "selfText": "after the review",
                    "salience": 0.7,
                    "occurredAt": "2026-05-28T10:00:00Z",
                }
            ]
        }

    monkeypatch.setattr(http_client, "get", fake_get)

    result = await signals_recent.ainvoke(
        {
            "status": "open",
            "kind": "ambient.candidate_window",
            "hours": 12,
            "limit": 5,
        }
    )

    assert result == [
        {
            "id": "sig_ambient",
            "kind": "ambient.candidate_window",
            "title": "Ambient transcript",
            "summary": 'speaker_1: "lunch?"',
            "speakerText": 'speaker_1: "lunch?"\nself: "after the review"',
            "selfText": "after the review",
            "salience": 0.7,
            "occurredAt": "2026-05-28T10:00:00Z",
        }
    ]


@pytest.mark.asyncio
async def test_signals_get_path(mock_http, jwt_ctx):
    await signals_get.ainvoke({"id": "sig_abc"})
    assert mock_http[0]["path"] == "/api/agent/signals/get/sig_abc"


@pytest.mark.asyncio
async def test_profile_get_path(mock_http, jwt_ctx):
    await profile_get.ainvoke({})
    assert mock_http[0]["path"] == "/api/agent/profile/get"


@pytest.mark.asyncio
async def test_raw_gmail_recent_path(mock_http, jwt_ctx):
    await raw_gmail_recent.ainvoke({"hours": 24, "limit": 10})
    call = mock_http[0]
    assert call["path"] == "/api/agent/raw/gmail/messages"
    # Wrapper converts hours → since (ISO-8601). Backend doesn't accept
    # `hours`, so this is the contract.
    assert "since" in call["params"]
    assert call["params"]["limit"] == 10


@pytest.mark.asyncio
async def test_raw_gmail_recent_adds_connection_guidance(monkeypatch, jwt_ctx):
    calls: list[dict] = []

    async def fake_get(path, **params):
        calls.append({"method": "GET", "path": path, "params": params})
        return {
            "items": [],
            "connectionRequired": True,
            "connectorToolkit": "gmail",
        }

    async def fake_post(path, body):
        calls.append({"method": "POST", "path": path, "body": body})
        return {"ok": True, "toolkits": [{"toolkit": "gmail", "status": "PENDING"}]}

    monkeypatch.setattr(http_client, "get", fake_get)
    monkeypatch.setattr(http_client, "post", fake_post)

    result = await raw_gmail_recent.ainvoke({"hours": 24, "limit": 10})

    assert calls[1] == {
        "method": "POST",
        "path": "/api/agent/composio/meta/MANAGE_CONNECTIONS",
        "body": {"args": {"toolkits": ["gmail"]}},
    }
    assert result["connectionGuidance"]["toolkits"][0]["toolkit"] == "gmail"


@pytest.mark.asyncio
async def test_raw_gcal_today_path(mock_http, jwt_ctx):
    await raw_gcal_today.ainvoke({"hours": 48, "limit": 5})
    assert mock_http[0]["path"] == "/api/agent/raw/gcal/events"


@pytest.mark.asyncio
async def test_raw_gcal_week_path(mock_http, jwt_ctx):
    await raw_gcal_week.ainvoke({"hours": 168, "limit": 50})
    call = mock_http[0]
    assert call["path"] == "/api/agent/raw/gcal/events"
    assert "since" in call["params"]


@pytest.mark.asyncio
async def test_raw_list_path(mock_http, jwt_ctx):
    await raw_list.ainvoke(
        {
            "toolkit": "slack",
            "entity": "messages",
            "hours": 72,
            "limit": 20,
        }
    )
    call = mock_http[0]
    assert call["path"] == "/api/agent/raw/slack/messages"
    assert "since" in call["params"]
    assert call["params"]["limit"] == 20


@pytest.mark.asyncio
async def test_cards_recent_path(mock_http, jwt_ctx):
    await cards_recent.ainvoke({"limit": 30})
    call = mock_http[0]
    assert call["path"] == "/api/agent/cards/recent"
    assert call["params"]["limit"] == 30


@pytest.mark.asyncio
async def test_feedback_list_path(mock_http, jwt_ctx):
    await feedback_list.ainvoke(
        {
            "kind": "card_action",
            "action": "dismiss",
            "limit": 20,
        }
    )
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

    call = mock_http[0]
    assert call["body"]["conversationId"] == "main-42-session"


@pytest.mark.asyncio
async def test_composio_search_tools_post(mock_http, jwt_ctx):
    await composio_search_tools.ainvoke(
        {
            "queries": [{"use_case": "send a quick email to recipient"}],
        }
    )
    call = mock_http[0]
    assert call["method"] == "POST"
    assert call["path"] == "/api/agent/composio/meta/SEARCH_TOOLS"
    assert call["body"]["args"]["queries"][0]["use_case"].startswith("send")


@pytest.mark.asyncio
async def test_composio_get_tool_schemas_post(mock_http, jwt_ctx):
    await composio_get_tool_schemas.ainvoke(
        {
            "tool_slugs": ["GMAIL_CREATE_EMAIL_DRAFT"],
        }
    )
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
    # The tool maps the LLM-facing `calls` arg onto Composio's actual
    # MULTI_EXECUTE_TOOL payload shape: `tools` + sync_response_to_workbench.
    # See composio_meta.py composio_multi_execute_tool.
    assert call["body"]["args"]["tools"][0]["tool_slug"] == "GMAIL_CREATE_EMAIL_DRAFT"
    assert call["body"]["args"]["sync_response_to_workbench"] is False


@pytest.mark.asyncio
async def test_composio_manage_connections_post(mock_http, jwt_ctx):
    await composio_manage_connections.ainvoke({"toolkits": ["gmail", "gcal"]})
    call = mock_http[0]
    assert call["path"] == "/api/agent/composio/meta/MANAGE_CONNECTIONS"
    assert call["body"]["args"]["toolkits"] == ["gmail", "gcal"]
