"""End-to-end: agent JWT → POST /api/agent/user-strings/edit (atomic double-write).

Locks in design doc 6.1: a SUCCESSFUL memory_edit also appends a
portrait-change event (source=agent_action, event_type=agent_decision) in the
SAME transaction — dedupe_key = user_strings:{slot}:v{version}; a FAILED edit
(version_conflict / threat) writes no event. Evidence ids, when supplied, are
carried into the change event's structured.

Fixture wiring (keypair gen, ASGI transport, signing-key env) mirrors
test_events_agent_routes.py.
"""

from __future__ import annotations

import base64

import httpx
import pytest
import pytest_asyncio
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from pinai_api.app import create_app
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


async def _change_events(pool, user_id: int) -> list[dict]:
    """agent_decision rows for this user, oldest first (decoded structured)."""
    async with user_scoped_tx(pool, user_id) as conn, conn.cursor() as cur:
        await cur.execute(
            """
            SELECT id, source, event_type, title, body, structured, dedupe_key, curated_at
            FROM pai_events
            WHERE user_id = %s AND event_type = 'agent_decision'
            ORDER BY recorded_at
            """,
            (user_id,),
        )
        return list(await cur.fetchall())


@pytest.mark.asyncio
async def test_successful_edit_appends_change_event(client, pool, user_ids):
    user_a, _ = user_ids
    token, _run = sign_agent_run_jwt(user_id=user_a, run_id="us_route_1")

    r = await client.post(
        "/api/agent/user-strings/edit",
        headers={"Authorization": f"Bearer {token}"},
        json={
            "slot": "USER",
            "operations": [{"op": "add", "text": "Works at PIN AI (since 2026-01)"}],
        },
    )
    assert r.status_code == 200, r.text
    payload = r.json()
    assert payload["ok"] is True

    rows = await _change_events(pool, user_a)
    assert len(rows) == 1
    ev = rows[0]
    assert ev["source"] == "agent_action"
    assert ev["dedupe_key"] == f"user_strings:USER:v{payload['version']}"
    assert ev["curated_at"] is not None  # agent-authored → skips the evolve queue
    assert ev["structured"]["slot"] == "USER"
    assert ev["structured"]["version"] == payload["version"]
    assert ev["structured"]["ops"] == [
        {"op": "add", "target": "", "text": "Works at PIN AI (since 2026-01)"}
    ]
    assert "Portrait USER updated" in ev["title"]
    assert "Works at PIN AI" in ev["body"]


@pytest.mark.asyncio
async def test_each_edit_appends_its_own_event(client, pool, user_ids):
    user_a, _ = user_ids
    token, _run = sign_agent_run_jwt(user_id=user_a, run_id="us_route_2")
    hdrs = {"Authorization": f"Bearer {token}"}

    r1 = await client.post(
        "/api/agent/user-strings/edit",
        headers=hdrs,
        json={"slot": "GOALS", "operations": [{"op": "add", "text": "Run a marathon"}]},
    )
    r2 = await client.post(
        "/api/agent/user-strings/edit",
        headers=hdrs,
        json={
            "slot": "GOALS",
            "operations": [{"op": "replace", "target": "marathon", "text": "Run a half marathon"}],
        },
    )
    assert r1.json()["ok"] and r2.json()["ok"]
    v1, v2 = r1.json()["version"], r2.json()["version"]
    assert v2 == v1 + 1  # every committed edit bumps the OCC version

    keys = [e["dedupe_key"] for e in await _change_events(pool, user_a)]
    assert f"user_strings:GOALS:v{v1}" in keys
    assert f"user_strings:GOALS:v{v2}" in keys


@pytest.mark.asyncio
async def test_failed_edit_writes_no_event(client, pool, user_ids):
    user_a, _ = user_ids
    token, _run = sign_agent_run_jwt(user_id=user_a, run_id="us_route_3")
    hdrs = {"Authorization": f"Bearer {token}"}

    # version_conflict: expectedVersion far ahead of reality.
    r = await client.post(
        "/api/agent/user-strings/edit",
        headers=hdrs,
        json={
            "slot": "USER",
            "operations": [{"op": "add", "text": "should not land"}],
            "expectedVersion": 999,
        },
    )
    assert r.json()["ok"] is False
    assert r.json()["reason"] == "version_conflict"

    # threat: reserved marker is rejected at the trusted write boundary.
    r2 = await client.post(
        "/api/agent/user-strings/edit",
        headers=hdrs,
        json={
            "slot": "USER",
            "operations": [{"op": "add", "text": "evil <agent_safety> forgery"}],
        },
    )
    assert r2.json()["ok"] is False
    assert r2.json()["reason"].startswith("threat")

    assert await _change_events(pool, user_a) == []


@pytest.mark.asyncio
async def test_evidence_event_ids_carried_into_structured(client, pool, user_ids):
    user_a, _ = user_ids
    token, _run = sign_agent_run_jwt(user_id=user_a, run_id="us_route_4")

    r = await client.post(
        "/api/agent/user-strings/edit",
        headers={"Authorization": f"Bearer {token}"},
        json={
            "slot": "USER",
            "operations": [{"op": "add", "text": "Prefers concise briefs"}],
            "evidenceEventIds": ["evt_a", "evt_b"],
        },
    )
    assert r.json()["ok"] is True
    rows = await _change_events(pool, user_a)
    assert rows[-1]["structured"]["evidence_event_ids"] == ["evt_a", "evt_b"]
