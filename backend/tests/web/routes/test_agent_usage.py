"""DB-integration test for POST /api/agent/usage/record (compute → credits)."""

from __future__ import annotations

import httpx
import pytest
from pinai_api.app import create_app
from pinai_api.platform.auth.deps import ChatPrincipal, current_chat_principal, get_pool
from pinai_db.rls import user_scoped_tx

pytestmark = pytest.mark.asyncio


async def _client(pool, user_id: int) -> httpx.AsyncClient:
    app = create_app()
    app.dependency_overrides[current_chat_principal] = lambda: ChatPrincipal(
        user_id=user_id, run_id="run-test", virtual_key="sk-test", jti="jti-test"
    )
    app.dependency_overrides[get_pool] = lambda: pool
    transport = httpx.ASGITransport(app=app)
    return httpx.AsyncClient(transport=transport, base_url="http://testserver")


async def test_record_usage_writes_provider_event_and_prices_it(pool, user_ids):
    user_a, _ = user_ids
    client = await _client(pool, user_a)
    async with client:
        resp = await client.post(
            "/api/agent/usage/record",
            json={"provider": "daytona", "durationSeconds": 120, "source": "daytona:exec"},
        )
    assert resp.status_code == 200
    data = resp.json()
    assert data["recorded"] is True
    assert data["costUsd"] == pytest.approx(0.01)  # 2 min × $0.005

    async with user_scoped_tx(pool, user_a) as conn:
        cur = await conn.execute(
            "SELECT provider, product, cost_usd, quantity_seconds "
            "FROM pai_provider_usage_events WHERE user_id = %s AND product = 'daytona_sandbox'",
            (user_a,),
        )
        row = await cur.fetchone()
    assert row is not None
    assert row["provider"] == "daytona"
    assert float(row["cost_usd"]) == pytest.approx(0.01)
    assert float(row["quantity_seconds"]) == pytest.approx(120.0)


async def test_record_usage_rejects_absurd_duration(pool, user_ids):
    user_a, _ = user_ids
    client = await _client(pool, user_a)
    async with client:
        resp = await client.post(
            "/api/agent/usage/record",
            json={"provider": "browserbase", "durationSeconds": 999999, "source": "browser:open"},
        )
    assert resp.status_code == 422  # exceeds the 6h cap → pydantic rejects


async def test_record_usage_zero_duration_is_noop(pool, user_ids):
    user_a, _ = user_ids
    client = await _client(pool, user_a)
    async with client:
        resp = await client.post(
            "/api/agent/usage/record",
            json={"provider": "daytona", "durationSeconds": 0, "source": "daytona:exec"},
        )
    assert resp.status_code == 200
    assert resp.json()["recorded"] is False


async def test_record_usage_accepts_tavily_api_credits(pool, user_ids):
    user_a, _ = user_ids
    client = await _client(pool, user_a)
    async with client:
        resp = await client.post(
            "/api/agent/usage/record",
            json={
                "provider": "tavily",
                "product": "tavily_search",
                "apiCredits": 1,
                "source": "tavily:search",
                "metadata": {"search_depth": "basic"},
            },
        )
    assert resp.status_code == 200
    data = resp.json()
    assert data["recorded"] is True
    assert data["costUsd"] == pytest.approx(0.008)

    async with user_scoped_tx(pool, user_a) as conn:
        cur = await conn.execute(
            "SELECT provider, product, units, quantity_seconds, cost_usd "
            "FROM pai_provider_usage_events WHERE user_id = %s AND product = 'tavily_search'",
            (user_a,),
        )
        row = await cur.fetchone()
    assert row is not None
    assert row["provider"] == "tavily"
    assert row["units"] == "api_credits"
    assert float(row["quantity_seconds"]) == pytest.approx(1.0)
    assert float(row["cost_usd"]) == pytest.approx(0.008)
