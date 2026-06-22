"""Composio agent routes should record paid tool-call usage."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import httpx
import pytest
from pinai_api.app import create_app
from pinai_api.domains.connector.apps import composio_service as cs
from pinai_api.platform.auth.deps import AgentRun, current_agent_run, get_pool
from pinai_db.rls import user_scoped_tx

pytestmark = pytest.mark.asyncio


async def _client(pool, user_id: int) -> httpx.AsyncClient:
    app = create_app()
    app.dependency_overrides[current_agent_run] = lambda: AgentRun(
        user_id=user_id,
        run_id="run-test",
        scope="chat",
    )
    app.dependency_overrides[get_pool] = lambda: pool
    transport = httpx.ASGITransport(app=app)
    return httpx.AsyncClient(transport=transport, base_url="http://testserver")


@dataclass(frozen=True)
class _Result:
    slug: str
    successful: bool
    data: dict[str, Any] | None = None
    error: str | None = None

    def model_dump(self) -> dict[str, Any]:
        return {
            "slug": self.slug,
            "successful": self.successful,
            "data": self.data,
            "error": self.error,
        }


async def test_agent_composio_execute_records_tool_call_usage(monkeypatch, pool, user_ids):
    user_a, _ = user_ids

    async def fake_execute(*_args: Any, **_kwargs: Any) -> _Result:
        return _Result(slug="GMAIL_FETCH_EMAILS", successful=True, data={"ok": True})

    monkeypatch.setattr(cs, "execute", fake_execute)

    client = await _client(pool, user_a)
    async with client:
        resp = await client.post(
            "/api/agent/composio/execute",
            json={"slug": "GMAIL_FETCH_EMAILS", "args": {"limit": 1}},
        )

    assert resp.status_code == 200
    assert resp.json()["successful"] is True

    async with user_scoped_tx(pool, user_a) as conn:
        cur = await conn.execute(
            "SELECT provider, product, units, quantity_seconds, cost_usd, source "
            "FROM pai_provider_usage_events WHERE user_id = %s AND provider = 'composio'",
            (user_a,),
        )
        row = await cur.fetchone()

    assert row is not None
    assert row["product"] == "composio_tool_call"
    assert row["units"] == "tool_calls"
    assert float(row["quantity_seconds"]) == pytest.approx(1.0)
    assert float(row["cost_usd"]) == pytest.approx(0.000299)
    assert row["source"] == "composio:agent_execute"
