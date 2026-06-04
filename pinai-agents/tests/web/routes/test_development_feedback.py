from __future__ import annotations

import httpx
import pytest

from pinai_agents.web.app import create_app
from pinai_agents.web.auth.deps import AgentRun, current_agent_run, current_user
from pinai_agents.web.auth.user_service import User
from pinai_agents.web.db.repositories.development_feedback import DevelopmentFeedbackRepository
from pinai_agents.web.db.rls import user_scoped_tx


def test_development_feedback_routes_are_mounted():
    app = create_app()
    routes = {
        (route.path, method)
        for route in app.routes
        for method in getattr(route, "methods", set())
    }

    assert ("/api/development-feedback", "POST") in routes
    assert ("/api/agent/development-feedback/log", "POST") in routes


def _user(user_id: int) -> User:
    return User(
        id=user_id,
        supabase_user_id=f"test-sub-{user_id}",
        email=f"user-{user_id}@test.invalid",
        litellm_virtual_key="sk-test",
        browserbase_context_id=None,
    )


async def _client_for(
    pool,
    user_id: int,
    *,
    agent_run: AgentRun | None = None,
) -> httpx.AsyncClient:
    app = create_app()
    app.state.pool = pool
    app.dependency_overrides[current_user] = lambda: _user(user_id)
    app.dependency_overrides[current_agent_run] = lambda: agent_run or AgentRun(
        user_id=user_id,
        run_id="run_development_feedback",
        scope="test",
    )
    transport = httpx.ASGITransport(app=app)
    return httpx.AsyncClient(transport=transport, base_url="http://testserver")


@pytest.mark.asyncio
async def test_ui_route_logs_development_feedback(pool, user_ids):
    user_a, _ = user_ids
    client = await _client_for(pool, user_a)

    async with client:
        res = await client.post(
            "/api/development-feedback",
            json={
                "text": "Can you add an export button to these cards?",
                "summary": "User wants an export button on cards.",
                "category": "ui",
                "surface": "main_chat",
                "conversationId": "thread_main",
                "messageId": "msg_123",
                "metadata": {"requested_control": "export_button"},
            },
        )

    assert res.status_code == 201, res.text
    body = res.json()
    assert body["received"] is True
    item = body["item"]
    assert item["id"].startswith("df_")
    assert item["text"] == "Can you add an export button to these cards?"
    assert item["summary"] == "User wants an export button on cards."
    assert item["category"] == "ui"
    assert item["surface"] == "main_chat"
    assert item["status"] == "new"
    assert item["source"] == "user"
    assert item["conversationId"] == "thread_main"
    assert item["messageId"] == "msg_123"
    assert item["metadata"] == {"requested_control": "export_button"}


@pytest.mark.asyncio
async def test_agent_route_stamps_internal_operator_source(pool, user_ids):
    user_a, _ = user_ids
    client = await _client_for(
        pool,
        user_a,
        agent_run=AgentRun(
            user_id=user_a,
            run_id="run_internal_operator_feedback",
            scope="test",
            actor="internal_operator",
            operator_id="operator_1",
        ),
    )

    async with client:
        res = await client.post(
            "/api/agent/development-feedback/log",
            json={
                "text": "The card detail action buttons are too small on mobile.",
                "summary": "Action buttons are too small on mobile.",
                "category": "ui",
                "surface": "card_detail",
                "metadata": {"viewport": "iphone"},
            },
        )

    assert res.status_code == 201, res.text
    item = res.json()
    assert item["source"] == "internal_operator"
    assert item["metadata"] == {
        "viewport": "iphone",
        "operator_id": "operator_1",
        "run_id": "run_internal_operator_feedback",
    }


@pytest.mark.asyncio
async def test_chat_send_fast_path_logs_development_feedback(pool, user_ids, monkeypatch):
    user_a, _ = user_ids

    async def fake_stream_chat(**_kwargs):
        yield b"event: chat:done\ndata: {}\n\n"

    monkeypatch.setattr("pinai_agents.web.routes.ui.chat.stream_chat", fake_stream_chat)
    client = await _client_for(pool, user_a)
    session_key = f"main-{user_a}-devfeedback"

    async with client:
        res = await client.post(
            "/api/chat-stream/send",
            json={
                "sessionKey": session_key,
                "message": "Can you add an export button to these cards?",
            },
        )

    assert res.status_code == 200, res.text
    async with user_scoped_tx(pool, user_a) as conn:
        rows = await DevelopmentFeedbackRepository(user_a, conn).list(status="new")

    assert len(rows) == 1
    assert rows[0].text == "Can you add an export button to these cards?"
    assert rows[0].category == "feature"
    assert rows[0].surface == "main_chat"
    assert rows[0].conversation_id == session_key
    assert rows[0].source == "user"


@pytest.mark.asyncio
async def test_route_rejects_unknown_category():
    app = create_app()
    app.state.pool = object()
    app.dependency_overrides[current_user] = lambda: _user(1)
    transport = httpx.ASGITransport(app=app)
    client = httpx.AsyncClient(transport=transport, base_url="http://testserver")

    async with client:
        res = await client.post(
            "/api/development-feedback",
            json={
                "text": "Can you change the interface?",
                "category": "growth_hack",
                "surface": "main_chat",
            },
        )

    assert res.status_code == 422
