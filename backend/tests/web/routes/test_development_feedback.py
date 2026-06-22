from __future__ import annotations

from unittest.mock import AsyncMock

import httpx
import pytest
from pinai_api.app import create_app
from pinai_api.domains.feedback.dev_repository import (
    DevelopmentFeedbackRepository,
)
from pinai_api.platform.auth.deps import AgentRun, current_agent_run, current_user
from pinai_api.platform.auth.user_service import User
from pinai_db.rls import user_scoped_tx


def test_development_feedback_routes_are_mounted():
    app = create_app()
    routes = {
        (route.path, method) for route in app.routes for method in getattr(route, "methods", set())
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
    agent_service: AsyncMock | None = None,
) -> httpx.AsyncClient:
    app = create_app()
    app.state.pool = pool
    if agent_service is not None:
        # /api/conversation/* posts onto the actor kernel; tests inject a
        # recording fake (the real one is wired in the lifespan).
        app.state.agent_service = agent_service
    app.dependency_overrides[current_user] = lambda: _user(user_id)
    app.dependency_overrides[current_agent_run] = lambda: (
        agent_run
        or AgentRun(
            user_id=user_id,
            run_id="run_development_feedback",
            scope="test",
        )
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
async def test_chat_send_does_not_intercept_normal_user_messages(pool, user_ids):
    """`/api/conversation/send` must always reach the agent pipeline — no
    web-side keyword fast-path silently logs the turn as dev feedback.
    Capture flows only through the agent's `development_feedback_log` tool.
    """
    user_a, _ = user_ids
    service = AsyncMock()
    client = await _client_for(pool, user_a, agent_service=service)
    session_key = f"main-{user_a}-devfeedback"

    # This message previously matched the (request marker × product noun)
    # fast-path heuristic and got silently converted to dev feedback.
    async with client:
        res = await client.post(
            "/api/conversation/send",
            json={
                "session_key": session_key,
                "message": "Can you add an export button to these cards?",
            },
        )

    assert res.status_code == 202, res.text
    # It must reach the kernel mailbox unmodified, like any other turn.
    service.post_message.assert_awaited_once()
    assert service.post_message.await_args.args == (session_key,)
    assert (
        service.post_message.await_args.kwargs["content"]
        == "Can you add an export button to these cards?"
    )
    async with user_scoped_tx(pool, user_a) as conn:
        rows = await DevelopmentFeedbackRepository(user_a, conn).list(status="new")
    # And no row is silently written by the web layer; the LLM tool path
    # is the only writer for user-sourced dev feedback.
    assert rows == []


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
