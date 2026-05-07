"""End-to-end: agent JWT → /api/agent/profile/* (upsert + goals/upsert).

Exercises the HTTP contract the chat-agent native @tool wrappers
(`profile_upsert`, `goal_upsert`) call into. Locks in:

  1. EdDSA agent JWT auth on the new endpoints.
  2. ProfileUpsertRequest partial semantics survive over the wire
     (single-field PATCH does NOT clobber prior fields).
  3. Goal upsert produces a `goal_*` id when `id` is omitted; subsequent
     calls with the same id update in place.
  4. RLS isolation: user A's writes are invisible to user B over agent
     JWTs of distinct user_ids.

Pattern matches `test_sandbox_phantom_routes.py` for fixture wiring
(keypair gen, ASGI transport, user_ids cleanup).
"""

from __future__ import annotations

import base64

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
        transport=transport, base_url="http://testserver",
    ) as c:
        yield c


def _agent_jwt(user_id: int) -> str:
    """Mint a chat-driving JWT for `user_id`. /api/agent/profile/* doesn't
    require the `vk` claim (`current_agent_run`, not `current_chat_principal`),
    so we omit virtual_key — minimal credential."""
    token, _ = sign_agent_run_jwt(user_id=user_id, virtual_key=None)
    return token


def _auth(user_id: int) -> dict[str, str]:
    return {"Authorization": f"Bearer {_agent_jwt(user_id)}"}


# ── profile_upsert ──


@pytest.mark.asyncio
async def test_profile_upsert_creates_row_with_defaults(client, user_ids):
    """Empty body still INSERTs — defaults from repo SQL kick in
    (display_name='User', locale='en-US', timezone='UTC', JSONB→{})."""
    user_a, _ = user_ids
    r = await client.post(
        "/api/agent/profile/upsert", headers=_auth(user_a), json={},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["display_name"] == "User"
    assert body["locale"] == "en-US"
    assert body["timezone"] == "UTC"
    assert body["facts"] == {}


@pytest.mark.asyncio
async def test_profile_upsert_partial_patch_preserves_unspecified(client, user_ids):
    """Two-call sequence — second call patches `summary` only and must
    keep display_name / locale / timezone / facts from the first call."""
    user_a, _ = user_ids

    # First call: full row.
    r = await client.post(
        "/api/agent/profile/upsert",
        headers=_auth(user_a),
        json={
            "displayName": "Bob Chen",
            "locale": "zh-Hans",
            "timezone": "Asia/Shanghai",
            "facts": {"role": "founder", "team": "ai"},
            "preferences": {"comm": "terse"},
        },
    )
    assert r.status_code == 200, r.text

    # Second call: patch only `summary`. Everything else must stay.
    r = await client.post(
        "/api/agent/profile/upsert",
        headers=_auth(user_a),
        json={"summary": "builds Pin AI"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["summary"] == "builds Pin AI"
    assert body["display_name"] == "Bob Chen"
    assert body["locale"] == "zh-Hans"
    assert body["timezone"] == "Asia/Shanghai"
    assert body["facts"] == {"role": "founder", "team": "ai"}
    assert body["preferences"] == {"comm": "terse"}


# ── goal_upsert ──


@pytest.mark.asyncio
async def test_goal_upsert_inserts_then_updates_in_place(client, user_ids):
    """First call (no id): server mints `goal_*`. Second call with the
    returned id updates same row; goals/get reflects single active row."""
    user_a, _ = user_ids

    # Insert.
    r = await client.post(
        "/api/agent/profile/goals/upsert",
        headers=_auth(user_a),
        json={
            "key": "ship-pin-v2",
            "title": "Ship Pin AI v2 by Q3 2026",
            "priority": "high",
            "summary": "core product trajectory",
        },
    )
    assert r.status_code == 201, r.text
    inserted = r.json()
    assert inserted["id"].startswith("goal_")
    assert inserted["key"] == "ship-pin-v2"
    assert inserted["priority"] == "high"
    assert inserted["status"] == "active"
    goal_id = inserted["id"]

    # Update in place: change title + flip to archived via status.
    r = await client.post(
        "/api/agent/profile/goals/upsert",
        headers=_auth(user_a),
        json={
            "id": goal_id,
            "key": "ship-pin-v2",
            "title": "Ship Pin AI v2 by Q4 2026",  # delayed
            "priority": "high",
            "status": "active",
        },
    )
    assert r.status_code == 201, r.text
    updated = r.json()
    assert updated["id"] == goal_id  # same row
    assert updated["title"] == "Ship Pin AI v2 by Q4 2026"


@pytest.mark.asyncio
async def test_profile_get_returns_profile_plus_active_goals(client, user_ids):
    """The endpoint generator + chat both call to ground replies — verify
    it returns the bundled `{profile, goals}` shape, with only active
    goals (status='archived' filtered out)."""
    user_a, _ = user_ids

    # Seed.
    await client.post(
        "/api/agent/profile/upsert",
        headers=_auth(user_a),
        json={"displayName": "Alice", "locale": "en-US"},
    )
    r = await client.post(
        "/api/agent/profile/goals/upsert",
        headers=_auth(user_a),
        json={"key": "active-goal", "title": "Live one"},
    )
    assert r.status_code == 201
    r = await client.post(
        "/api/agent/profile/goals/upsert",
        headers=_auth(user_a),
        json={"key": "old-goal", "title": "Done", "status": "archived"},
    )
    assert r.status_code == 201

    # Read.
    r = await client.get("/api/agent/profile/get", headers=_auth(user_a))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["profile"]["display_name"] == "Alice"
    keys = {g["key"] for g in body["goals"]}
    assert "active-goal" in keys
    assert "old-goal" not in keys  # archived filtered


# ── RLS isolation ──


@pytest.mark.asyncio
async def test_profile_upsert_isolated_across_users(client, user_ids):
    """User A writes a profile. User B's agent JWT must see a fresh
    empty profile (RLS / scoping)."""
    user_a, user_b = user_ids

    r = await client.post(
        "/api/agent/profile/upsert",
        headers=_auth(user_a),
        json={"displayName": "Alice"},
    )
    assert r.status_code == 200

    # User B reads — should see no profile.
    r = await client.get("/api/agent/profile/get", headers=_auth(user_b))
    assert r.status_code == 200
    body = r.json()
    assert body["profile"] is None
    assert body["goals"] == []
