"""scheduled_generator_* native @tool wrappers — verify the HTTP request
each one constructs, without a real web. Patches http_client.{get, post,
post_status, delete} and asserts path / body / params. The create wrapper
gets extra coverage on the 409 `requiresConfirmation` branch because that
non-2xx is a normal business outcome, not an error.
"""

from __future__ import annotations

import pytest

from pinai_agents.chat.harness.ctx import run_context
from pinai_agents.chat.tools import http_client
from pinai_agents.chat.tools.direct import (
    scheduled_generator_create,
    scheduled_generator_delete,
    scheduled_generator_list,
    scheduled_generator_pause,
    scheduled_generator_preview,
    scheduled_generator_resume,
)


@pytest.fixture
def mock_http(monkeypatch):
    """Replace http_client.{get, post, post_status, delete} with capturing fakes."""
    calls: list[dict] = []

    async def fake_get(path, **params):
        calls.append({"method": "GET", "path": path, "params": params})
        return {"items": []}

    async def fake_post(path, body):
        calls.append({"method": "POST", "path": path, "body": body})
        return {"ok": True}

    async def fake_post_status(path, body):
        calls.append({"method": "POST_STATUS", "path": path, "body": body})
        return 201, {"task": {"id": "task_x", "status": "active"}}

    async def fake_delete(path):
        calls.append({"method": "DELETE", "path": path})
        return {"task": {"id": "task_x", "status": "archived"}}

    monkeypatch.setattr(http_client, "get", fake_get)
    monkeypatch.setattr(http_client, "post", fake_post)
    monkeypatch.setattr(http_client, "post_status", fake_post_status)
    monkeypatch.setattr(http_client, "delete", fake_delete)
    yield calls


@pytest.fixture
def jwt_ctx():
    """Set the per-run JWT ContextVar so wrappers don't fail validation."""
    with run_context(user_id=42, run_id="run_test", run_jwt="fake-jwt", virtual_key="vk-x"):
        yield


@pytest.mark.asyncio
async def test_preview_path_and_body(mock_http, jwt_ctx):
    await scheduled_generator_preview.ainvoke(
        {
            "original_request": "每天 9 点给我推一些 AI 新闻",
            "timezone": "America/Los_Angeles",
        }
    )
    call = mock_http[0]
    assert call["method"] == "POST"
    assert call["path"] == "/api/scheduled-generators/preview"
    assert call["body"]["originalRequest"] == "每天 9 点给我推一些 AI 新闻"
    assert call["body"]["timezone"] == "America/Los_Angeles"
    assert call["body"]["conversationId"] is None


@pytest.mark.asyncio
async def test_create_success_passes_camel_payload(mock_http, jwt_ctx):
    result = await scheduled_generator_create.ainvoke(
        {
            "preview_id": "pv_1",
            "semantic_signature": "sig_abc",
            "original_request": "每天 9 点给我推 AI 新闻",
            "parsed_intent": {"frequency": "daily", "local_time": "09:00", "topic": "AI 新闻"},
            "confirmed_brief": {"topic": "AI 新闻"},
            "duplicate_ack": False,
            "similar_task_ids_seen": [],
        }
    )
    call = next(c for c in mock_http if c["method"] == "POST_STATUS")
    assert call["path"] == "/api/scheduled-generators"
    assert call["body"]["previewId"] == "pv_1"
    assert call["body"]["semanticSignature"] == "sig_abc"
    assert call["body"]["parsedIntent"]["frequency"] == "daily"
    assert call["body"]["confirmedBrief"]["topic"] == "AI 新闻"
    assert call["body"]["duplicateAck"] is False
    assert call["body"]["similarTaskIdsSeen"] == []
    assert result == {"task": {"id": "task_x", "status": "active"}}


@pytest.mark.asyncio
async def test_create_surfaces_409_requires_confirmation(monkeypatch, jwt_ctx):
    """A 409 is the backend asking for one more confirmation (new similar
    tasks). The wrapper must pass the full body through — NOT collapse it
    into an opaque error — so the agent can show similarTasks and re-ask."""

    async def fake_post_status(path, body):
        return 409, {
            "requiresConfirmation": True,
            "similarTasks": [{"id": "task_old", "title": "AI 新闻"}],
        }

    monkeypatch.setattr(http_client, "post_status", fake_post_status)

    result = await scheduled_generator_create.ainvoke(
        {
            "preview_id": "pv_1",
            "semantic_signature": "sig_abc",
            "original_request": "每天 9 点给我推 AI 新闻",
            "parsed_intent": {"frequency": "daily"},
            "confirmed_brief": {"topic": "AI 新闻"},
        }
    )
    assert result["requiresConfirmation"] is True
    assert result["similarTasks"][0]["id"] == "task_old"


@pytest.mark.asyncio
async def test_create_other_4xx_is_error(monkeypatch, jwt_ctx):
    async def fake_post_status(path, body):
        return 400, {"detail": "bad timezone"}

    monkeypatch.setattr(http_client, "post_status", fake_post_status)

    result = await scheduled_generator_create.ainvoke(
        {
            "preview_id": "pv_1",
            "semantic_signature": "sig_abc",
            "original_request": "x",
            "parsed_intent": {},
            "confirmed_brief": {},
        }
    )
    assert result["error"] == "http_400"


@pytest.mark.asyncio
async def test_list_path_and_params(mock_http, jwt_ctx):
    await scheduled_generator_list.ainvoke({"include_archived": True})
    call = mock_http[0]
    assert call["method"] == "GET"
    assert call["path"] == "/api/scheduled-generators"
    assert call["params"]["includeArchived"] is True


@pytest.mark.asyncio
async def test_pause_path(mock_http, jwt_ctx):
    await scheduled_generator_pause.ainvoke({"task_id": "task_1"})
    call = mock_http[0]
    assert call["method"] == "POST"
    assert call["path"] == "/api/scheduled-generators/task_1/pause"


@pytest.mark.asyncio
async def test_resume_path(mock_http, jwt_ctx):
    await scheduled_generator_resume.ainvoke({"task_id": "task_1"})
    call = mock_http[0]
    assert call["method"] == "POST"
    assert call["path"] == "/api/scheduled-generators/task_1/resume"


@pytest.mark.asyncio
async def test_delete_path(mock_http, jwt_ctx):
    await scheduled_generator_delete.ainvoke({"task_id": "task_1"})
    call = mock_http[0]
    assert call["method"] == "DELETE"
    assert call["path"] == "/api/scheduled-generators/task_1"
