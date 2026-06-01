"""End-to-end: agent JWT → /api/agent/preferences/* + settings language.

Exercises the HTTP contract the chat-agent native @tools
(`preference_add`, `set_generation_language`) call into:

  1. POST /preferences/add under a normal run → row lands source='user'.
  2. GET  /preferences/list returns active rows newest-first.
  3. POST /profile/settings/generation-language flips
     pai_user_settings.generation_language AND re-stamps the
     generator.auto schedule payload's output_language (deterministic
     language path — not a ledger bet).

Fixture wiring matches test_agent_profile_routes.py.
"""

from __future__ import annotations

import base64
from datetime import UTC, datetime, timedelta

import httpx
import pytest
import pytest_asyncio
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from pinai_agents.web.app import create_app
from pinai_agents.web.auth.agent_jwt import sign_agent_run_jwt


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
    from pinai_agents import config

    config.get_web_settings.cache_clear()
    config.get_chat_settings.cache_clear()
    yield
    config.get_web_settings.cache_clear()
    config.get_chat_settings.cache_clear()


@pytest_asyncio.fixture
async def client(pool):
    app = create_app()
    app.state.pool = pool
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport,
        base_url="http://testserver",
    ) as c:
        yield c


def _auth(user_id: int) -> dict[str, str]:
    token, _ = sign_agent_run_jwt(user_id=user_id, virtual_key=None)
    return {"Authorization": f"Bearer {token}"}


@pytest.mark.asyncio
async def test_add_normal_run_is_source_user(client, user_ids):
    """A normal run principal (no actor claim) → server stamps
    source='user', even if the agent tried to smuggle a source in the
    body (which the request model doesn't even accept)."""
    user_a, _ = user_ids
    r = await client.post(
        "/api/agent/preferences/add",
        headers=_auth(user_a),
        json={
            "statement": "Wants more A-share market news",
            "scope": "topic",
            "polarity": "positive",
            "source": "internal_operator",  # ignored — not a model field
            "evidence": {"card_id": "card_42"},
        },
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["id"].startswith("pref_")
    assert body["source"] == "user"
    assert body["scope"] == "topic"
    assert body["polarity"] == "positive"
    assert body["weight"] == 1.0  # default high weight
    assert body["durability"] == "persistent"
    assert body["expires_at"] is None
    assert body["status"] == "active"
    assert body["evidence"] == {"card_id": "card_42"}


@pytest.mark.asyncio
async def test_add_temporary_preference_with_expiry(client, user_ids):
    user_a, _ = user_ids
    expires_at = datetime.now(tz=UTC) + timedelta(hours=2)
    r = await client.post(
        "/api/agent/preferences/add",
        headers=_auth(user_a),
        json={
            "statement": "Today show me AI news",
            "scope": "topic",
            "polarity": "positive",
            "durability": "temporary",
            "expiresAt": expires_at.isoformat(),
        },
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["durability"] == "temporary"
    assert body["expires_at"] is not None


@pytest.mark.asyncio
async def test_temporary_preference_requires_expiry(client, user_ids):
    user_a, _ = user_ids
    r = await client.post(
        "/api/agent/preferences/add",
        headers=_auth(user_a),
        json={
            "statement": "Next batch show me AI news",
            "scope": "topic",
            "polarity": "positive",
            "durability": "temporary",
        },
    )
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_persistent_preference_rejects_expiry(client, user_ids):
    user_a, _ = user_ids
    expires_at = datetime.now(tz=UTC) + timedelta(hours=2)
    r = await client.post(
        "/api/agent/preferences/add",
        headers=_auth(user_a),
        json={
            "statement": "Always show me AI news",
            "scope": "topic",
            "polarity": "positive",
            "durability": "persistent",
            "expiresAt": expires_at.isoformat(),
        },
    )
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_list_returns_active_newest_first(client, user_ids):
    user_a, _ = user_ids
    for stmt, scope in [
        ("Older topic preference", "topic"),
        ("Newer source preference", "source"),
    ]:
        r = await client.post(
            "/api/agent/preferences/add",
            headers=_auth(user_a),
            json={"statement": stmt, "scope": scope, "polarity": "positive"},
        )
        assert r.status_code == 201, r.text

    r = await client.get("/api/agent/preferences/list", headers=_auth(user_a))
    assert r.status_code == 200, r.text
    items = r.json()["items"]
    assert [i["statement"] for i in items] == [
        "Newer source preference",
        "Older topic preference",
    ]
    assert all(i["status"] == "active" for i in items)


@pytest.mark.asyncio
async def test_list_isolated_across_users(client, user_ids):
    user_a, user_b = user_ids
    r = await client.post(
        "/api/agent/preferences/add",
        headers=_auth(user_a),
        json={"statement": "A only", "scope": "topic", "polarity": "positive"},
    )
    assert r.status_code == 201
    r = await client.get("/api/agent/preferences/list", headers=_auth(user_b))
    assert r.status_code == 200
    assert r.json()["items"] == []


@pytest.mark.asyncio
async def test_set_generation_language_restamps_schedule(client, user_ids, pool):
    """Flipping generation_language via the agent route must (a) persist
    on pai_user_settings and (b) re-stamp the generator.auto schedule
    payload's output_language — the deterministic language path."""
    from pinai_agents.web.db.rls import user_scoped_tx
    from pinai_agents.web.routes.ui.profile import _auto_generate_task_id

    user_a, _ = user_ids
    r = await client.post(
        "/api/agent/profile/settings/generation-language",
        headers=_auth(user_a),
        json={"generationLanguage": "en"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["generation_language"] == "en"

    # Flip to zh-Hans and assert both the setting and the schedule payload.
    r = await client.post(
        "/api/agent/profile/settings/generation-language",
        headers=_auth(user_a),
        json={"generationLanguage": "zh-Hans"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["generation_language"] == "zh-Hans"

    task_id = _auto_generate_task_id(user_a)
    async with user_scoped_tx(pool, user_a) as conn:
        cur = await conn.execute(
            "SELECT generation_language FROM pai_user_settings WHERE user_id = %s",
            (user_a,),
        )
        settings_row = await cur.fetchone()
        cur = await conn.execute(
            "SELECT kind, status, payload FROM pai_scheduled_tasks WHERE user_id = %s AND id = %s",
            (user_a, task_id),
        )
        sched = await cur.fetchone()

    assert settings_row["generation_language"] == "zh-Hans"
    assert sched is not None, "generator.auto schedule row should exist (auto_generate default ON)"
    assert sched["kind"] == "generator.auto"
    assert sched["status"] == "active"
    assert sched["payload"]["output_language"] == "zh-Hans"
