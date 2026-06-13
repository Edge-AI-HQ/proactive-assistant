from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from types import SimpleNamespace

import httpx
import pytest

from pinai_agents.web.app import create_app
from pinai_agents.web.auth.deps import current_user, get_pool
from pinai_agents.web.auth.user_service import User
from pinai_agents.web.routes.ui import composio as composio_routes


def _user(user_id: int = 123) -> User:
    return User(
        id=user_id,
        supabase_user_id=f"test-sub-{user_id}",
        email=f"user-{user_id}@test.invalid",
        litellm_virtual_key=None,
        browserbase_context_id=None,
    )


@pytest.mark.asyncio
async def test_connect_enqueues_onboarding_preview_without_waiting(monkeypatch):
    captured: dict[str, object] = {}
    pool = object()

    async def fake_connect(user: User, toolkit: str):
        captured["connect_user_id"] = user.id
        captured["connect_toolkit"] = toolkit
        return SimpleNamespace(
            toolkit=toolkit,
            status="INITIATED",
            connected_account_id="gmail-account",
            redirect_url="https://oauth.local",
        )

    async def fake_enqueue_preview(_pool, user_id: int, toolkit: str, connected_account_id: str):
        captured["preview_pool"] = _pool
        captured["preview_user_id"] = user_id
        captured["preview_toolkit"] = toolkit
        captured["preview_connected_account_id"] = connected_account_id
        return f"preview.{toolkit}.{connected_account_id}"

    monkeypatch.setattr(composio_routes, "connect", fake_connect)
    monkeypatch.setattr(
        composio_routes, "_enqueue_connector_preview", fake_enqueue_preview, raising=False
    )

    app = create_app()
    app.dependency_overrides[current_user] = lambda: _user()
    app.dependency_overrides[get_pool] = lambda: pool
    transport = httpx.ASGITransport(app=app)

    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        response = await client.post("/api/composio/connect", json={"toolkit": "gmail"})

    assert response.status_code == 200
    assert response.json()["redirectUrl"] == "https://oauth.local"
    assert captured == {
        "connect_user_id": 123,
        "connect_toolkit": "gmail",
        "preview_pool": pool,
        "preview_user_id": 123,
        "preview_toolkit": "gmail",
        "preview_connected_account_id": "gmail-account",
    }


@pytest.mark.asyncio
async def test_connect_preview_task_uses_fast_50_item_limit(monkeypatch):
    captured: dict[str, object] = {}

    @asynccontextmanager
    async def fake_user_scoped_tx(_pool, _user_id: int) -> AsyncIterator[object]:
        yield object()

    async def fake_enqueue_once(_conn, **kwargs):
        captured.update(kwargs)

    monkeypatch.setattr(composio_routes, "user_scoped_tx", fake_user_scoped_tx)
    monkeypatch.setattr(composio_routes, "enqueue_once", fake_enqueue_once)

    task_id = await composio_routes._enqueue_connector_preview(
        object(),
        user_id=123,
        toolkit="googlesuper",
        connected_account_id="google-workspace-account",
    )

    assert task_id == "preview.googlesuper.google-workspace-account"
    assert captured["kind"] == "connector.preview"
    assert captured["payload"] == {
        "toolkit": "googlesuper",
        "connectedAccountId": "google-workspace-account",
        "reason": "composio_connect",
        "limit": 50,
    }


@pytest.mark.asyncio
async def test_wait_does_not_enqueue_init_when_preview_owns_it(monkeypatch):
    async def fake_wait_active(_cid: str):
        return SimpleNamespace(status="ACTIVE", toolkit="gmail")

    async def fake_preview_owns_init(_pool, user_id: int, toolkit: str, connected_account_id: str):
        assert user_id == 123
        assert toolkit == "gmail"
        assert connected_account_id == "gmail-account"
        return True

    async def fail_enqueue_init(*_args, **_kwargs):
        raise AssertionError("/wait should not enqueue init while preview owns init")

    async def fake_resolve_label(*_args, **_kwargs):
        return None

    monkeypatch.setattr(composio_routes, "wait_active", fake_wait_active)
    monkeypatch.setattr(composio_routes, "_preview_owns_connector_init", fake_preview_owns_init)
    monkeypatch.setattr(composio_routes, "_enqueue_connector_init", fail_enqueue_init)
    monkeypatch.setattr(composio_routes, "resolve_and_persist_label", fake_resolve_label)

    app = create_app()
    app.dependency_overrides[current_user] = lambda: _user()
    app.dependency_overrides[get_pool] = lambda: object()
    transport = httpx.ASGITransport(app=app)

    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        response = await client.post(
            "/api/composio/wait",
            json={"connectedAccountId": "gmail-account"},
        )

    assert response.status_code == 200
    assert response.json() == {
        "status": "ACTIVE",
        "connectedAccountId": "gmail-account",
    }


@pytest.mark.asyncio
async def test_wait_connector_init_keeps_full_bootstrap_limit(monkeypatch):
    captured: dict[str, object] = {}

    @asynccontextmanager
    async def fake_user_scoped_tx(_pool, _user_id: int) -> AsyncIterator[object]:
        yield object()

    async def fake_enqueue_once(_conn, **kwargs):
        captured.update(kwargs)

    monkeypatch.setattr(composio_routes, "user_scoped_tx", fake_user_scoped_tx)
    monkeypatch.setattr(composio_routes, "enqueue_once", fake_enqueue_once)

    task_id = await composio_routes._enqueue_connector_init(
        object(),
        user_id=123,
        toolkit="gmail",
        connected_account_id="gmail-account",
    )

    assert task_id == "init.gmail.gmail-account"
    assert captured["kind"] == "connector.init"
    assert captured["payload"] == {
        "toolkit": "gmail",
        "connectedAccountId": "gmail-account",
        "reason": "composio_wait",
        "limit": 100,
    }
