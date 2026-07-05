"""End-to-end: agent JWT → /api/agent/settings/generation-language.

Exercises the HTTP contract the chat-agent native @tool wrapper
(`set_generation_language`) calls into. Locks in:

  1. EdDSA agent JWT auth on the endpoint.
  2. The flip persists to pai_user_settings and the route returns the
     updated settings row (snake_case dict).
  3. RLS isolation: user A's write is invisible to user B over agent
     JWTs of distinct user_ids.

Profile/goals agent endpoints (the retired pai_profile/pai_goals) were
removed in the lifelong-memory sunset — they moved to memory_edit
(USER/GOALS portrait slots) + event_append (preferences).

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
from pinai_api.app import create_app
from pinai_api.platform.auth.agent_jwt import sign_agent_run_jwt


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
    async with httpx.AsyncClient(
        transport=transport,
        base_url="http://testserver",
    ) as c:
        yield c


def _agent_jwt(user_id: int) -> str:
    """Mint a chat-driving JWT for `user_id`. The settings endpoint doesn't
    require the `vk` claim (`current_agent_run`, not `current_chat_principal`),
    so we omit virtual_key — minimal credential."""
    token, _ = sign_agent_run_jwt(user_id=user_id, virtual_key=None)
    return token


def _auth(user_id: int) -> dict[str, str]:
    return {"Authorization": f"Bearer {_agent_jwt(user_id)}"}


# ── set_generation_language ──


@pytest.mark.asyncio
async def test_set_generation_language_persists_and_returns_settings(client, user_ids):
    """Empty/default settings row is lazy-created, the language flips, and
    the route echoes back the full settings row (snake_case)."""
    user_a, _ = user_ids
    r = await client.post(
        "/api/agent/settings/generation-language",
        headers=_auth(user_a),
        json={"generationLanguage": "zh-Hans"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["generation_language"] == "zh-Hans"
    assert body["timezone"] == "UTC"  # default row, untouched by this write

    # A second flip on the same row updates in place.
    r = await client.post(
        "/api/agent/settings/generation-language",
        headers=_auth(user_a),
        json={"generationLanguage": "en"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["generation_language"] == "en"


@pytest.mark.asyncio
async def test_set_generation_language_isolated_across_users(client, user_ids):
    """User A flips their language. User B's agent JWT must see the column
    default (RLS / scoping) when it reads via its own write."""
    user_a, user_b = user_ids

    r = await client.post(
        "/api/agent/settings/generation-language",
        headers=_auth(user_a),
        json={"generationLanguage": "zh-Hans"},
    )
    assert r.status_code == 200, r.text

    # User B's own no-op-ish write lazy-creates B's row at the default.
    r = await client.post(
        "/api/agent/settings/generation-language",
        headers=_auth(user_b),
        json={"generationLanguage": "ja"},
    )
    assert r.status_code == 200, r.text
    # B's value is B's own — never A's.
    assert r.json()["generation_language"] == "ja"
