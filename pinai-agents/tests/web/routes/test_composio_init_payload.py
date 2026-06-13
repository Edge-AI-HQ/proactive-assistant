from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import pytest

from pinai_agents.web.routes.ui import composio as composio_routes


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
