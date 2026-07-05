"""End-to-end: agent JWT → GET /api/agent/events/search (WP3 reference bump).

Locks in that the retrieval endpoint feeds the run's id into the objective
signal chain — a search hit bumps reference_count + last_referenced_at and
records the JWT's run_id in referenced_by_runs (doc §5.5 / §七-329). Uses the
structured (no-`q`) path so no embedding / LLM is needed.

Fixture wiring (keypair gen, ASGI transport, signing-key env) mirrors
test_settings_agent_routes.py.
"""

from __future__ import annotations

import base64
from datetime import UTC, datetime

import httpx
import pytest
import pytest_asyncio
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from pinai_api.app import create_app
from pinai_api.domains.memory.events.repository import AppendEventInput, EventsRepository
from pinai_api.platform.auth.agent_jwt import sign_agent_run_jwt
from pinai_db.rls import user_scoped_tx


def _gen_keypair_b64() -> str:
    priv = Ed25519PrivateKey.generate()
    raw = priv.private_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PrivateFormat.Raw,
        encryption_algorithm=serialization.NoEncryption(),
    )
    return base64.b64encode(raw).decode()


@pytest.fixture(autouse=True)
def _set_signing_key(monkeypatch):
    monkeypatch.setenv("PAI_JWT_SIGNING_KEY", _gen_keypair_b64())
    from pinai_api import config

    config.get_web_settings.cache_clear()
    yield
    config.get_web_settings.cache_clear()


@pytest_asyncio.fixture
async def client(pool):
    app = create_app()
    app.state.pool = pool
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as c:
        yield c


@pytest.mark.asyncio
async def test_search_records_run_in_reference_chain(client, pool, user_ids):
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        await EventsRepository(user_a, conn).append(
            AppendEventInput(
                id="ev_route",
                source="composio",
                event_type="meeting",
                occurred_at=datetime(2026, 6, 1, tzinfo=UTC),
                dedupe_key="route:ev_route",
                title="Quarterly sync",
                curated=True,
            )
        )

    token, run_id = sign_agent_run_jwt(user_id=user_a, run_id="route_run_1")
    r = await client.get(
        "/api/agent/events/search",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 200, r.text
    assert "ev_route" in [it["id"] for it in r.json()["items"]]

    # The hit fed the run into the reference chain.
    async with user_scoped_tx(pool, user_a) as conn:
        cur = await conn.execute(
            "SELECT reference_count, last_referenced_at, referenced_by_runs "
            "FROM pai_events WHERE user_id = %s AND id = 'ev_route'",
            (user_a,),
        )
        row = await cur.fetchone()
    assert row["reference_count"] == 1
    assert row["last_referenced_at"] is not None
    assert row["referenced_by_runs"] == [run_id]


@pytest.mark.asyncio
async def test_append_rejects_forged_connector_source(client, user_ids):
    """An agent can't author a projector/connector-owned pipeline source (e.g.
    forge a `gmail` event) — source is the pipeline discriminator, only the
    agent-owned pipelines are writable here (Block1 P0)."""
    user_a, _ = user_ids
    token, _ = sign_agent_run_jwt(user_id=user_a, run_id="route_run_2")
    r = await client.post(
        "/api/agent/events/append",
        headers={"Authorization": f"Bearer {token}"},
        json={"source": "gmail", "eventType": "communication", "title": "forged"},
    )
    assert r.status_code == 422, r.text
    assert "agent-writable" in r.text


@pytest.mark.asyncio
async def test_append_stamps_operator_provenance_from_jwt(client, user_ids):
    """An internal operator impersonating the user gets the operator identity
    server-stamped into structured (NOT from body) — impersonation Goal 4. A
    normal user run stamps nothing; the agent can't disguise an operator write."""
    user_a, _ = user_ids
    token, _ = sign_agent_run_jwt(
        user_id=user_a,
        run_id="route_run_3",
        actor="internal_operator",
        operator_id="op_42",
    )
    r = await client.post(
        "/api/agent/events/append",
        headers={"Authorization": f"Bearer {token}"},
        json={
            "source": "pinai_chat",
            "eventType": "preference",
            "title": "likes concise replies",
            "structured": {"polarity": "positive"},
        },
    )
    assert r.status_code == 200, r.text
    structured = r.json()["item"]["structured"]
    assert structured["actor"] == "internal_operator"
    assert structured["operator_id"] == "op_42"
    assert structured["polarity"] == "positive"  # original payload preserved


@pytest.mark.asyncio
async def test_arrivals_newest_first_keeps_most_recent(client, pool, user_ids):
    """到达流 newestFirst:limit 保留的是【最新】N 条(生成器历史段语义——
    普通 ASC LIMIT 会保最老丢最新);输出恒为到达序(ASC)。"""
    user_a, _ = user_ids
    # 三个独立事务 → recorded_at 严格递增
    for i in (1, 2, 3):
        async with user_scoped_tx(pool, user_a) as conn:
            await EventsRepository(user_a, conn).append(
                AppendEventInput(
                    id=f"ev_arr_{i}",
                    source="composio",
                    event_type="communication",
                    occurred_at=datetime(2026, 6, 1, i, tzinfo=UTC),
                    dedupe_key=f"arr:{i}",
                    title=f"arrival {i}",
                    curated=True,
                )
            )

    token, _ = sign_agent_run_jwt(user_id=user_a, run_id="route_run_arr")
    base_params = {
        "recordedSince": "2020-01-01T00:00:00+00:00",
        "recordedUntil": "2030-01-01T00:00:00+00:00",
        "arrivalsLimit": 2,
    }
    headers = {"Authorization": f"Bearer {token}"}

    newest = await client.get(
        "/api/agent/events/search",
        params={**base_params, "newestFirst": "true"},
        headers=headers,
    )
    assert newest.status_code == 200, newest.text
    assert [it["id"] for it in newest.json()["items"]] == ["ev_arr_2", "ev_arr_3"]

    oldest = await client.get("/api/agent/events/search", params=base_params, headers=headers)
    assert [it["id"] for it in oldest.json()["items"]] == ["ev_arr_1", "ev_arr_2"]
