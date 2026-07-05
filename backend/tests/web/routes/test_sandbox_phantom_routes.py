"""End-to-end: chat → web phantom mint/revoke + sandbox → /api/agent/* resolve.

Validates the full security boundary the phantom-token design enforces:
  1. mint requires a chat-driving JWT (`vk` claim) — phantom can't mint.
  2. The minted token resolves on /api/agent/* routes via current_agent_run.
  3. Revoke kills the token mid-flight.
  4. JWT path still works on /api/agent/* (no regression for chat-driving).
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
from pinai_api.platform.db.repositories.sandbox_phantom_tokens import (
    PHANTOM_PREFIX,
    clear_cache_for_tests,
)


def _gen_keypair_b64() -> str:
    priv = Ed25519PrivateKey.generate()
    priv_raw = priv.private_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PrivateFormat.Raw,
        encryption_algorithm=serialization.NoEncryption(),
    )
    return base64.b64encode(priv_raw).decode()


@pytest.fixture(autouse=True)
def _set_signing_key(monkeypatch):
    monkeypatch.setenv("PAI_JWT_SIGNING_KEY", _gen_keypair_b64())
    # The audience / issuer claims default to whatever config provides;
    # we just need a consistent value across sign + verify in this test.
    from pinai_api import config

    config.get_web_settings.cache_clear()
    clear_cache_for_tests()
    yield
    config.get_web_settings.cache_clear()
    clear_cache_for_tests()


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


def _chat_jwt(user_id: int, *, virtual_key: str = "sk-test-vk") -> str:
    """Mint a chat-driving JWT (carries vk; admitted by current_chat_principal)."""
    token, _ = sign_agent_run_jwt(user_id=user_id, virtual_key=virtual_key)
    return token


def _sandbox_jwt(user_id: int) -> str:
    """Mint a JWT WITHOUT vk — sandbox-historical / scheduler shape.
    current_chat_principal must reject this for mint."""
    token, _ = sign_agent_run_jwt(user_id=user_id, virtual_key=None)
    return token


# ── mint surface ──


@pytest.mark.asyncio
async def test_mint_requires_jwt_with_vk(client, user_ids):
    user_a, _ = user_ids
    # Sandbox-shaped JWT (no vk) → 403.
    r = await client.post(
        "/api/agent/sandbox/phantom/mint",
        headers={"Authorization": f"Bearer {_sandbox_jwt(user_a)}"},
        json={"scope_label": "test"},
    )
    assert r.status_code == 403, r.text
    # Chat-driving JWT (with vk) → 200 + token.
    r = await client.post(
        "/api/agent/sandbox/phantom/mint",
        headers={"Authorization": f"Bearer {_chat_jwt(user_a)}"},
        json={"scope_label": "test"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["token"].startswith(PHANTOM_PREFIX)
    assert len(body["token_hash"]) == 64
    assert body["ttl_seconds"] == 24 * 60 * 60


@pytest.mark.asyncio
async def test_phantom_cannot_mint_phantom(client, user_ids):
    """If a phantom-bearing call could mint a fresh phantom, a compromised
    sandbox could rotate its own credentials indefinitely. The mint dep
    must reject phantom prefixes outright."""
    user_a, _ = user_ids
    r = await client.post(
        "/api/agent/sandbox/phantom/mint",
        headers={"Authorization": f"Bearer {_chat_jwt(user_a)}"},
        json={"scope_label": "phase-1"},
    )
    assert r.status_code == 200
    phantom = r.json()["token"]
    # Now try to use that phantom to mint another.
    r2 = await client.post(
        "/api/agent/sandbox/phantom/mint",
        headers={"Authorization": f"Bearer {phantom}"},
        json={"scope_label": "phase-2"},
    )
    assert r2.status_code == 403


# ── resolve on /api/agent/* (events.search as canary) ──


@pytest.mark.asyncio
async def test_phantom_resolves_on_agent_route(client, user_ids):
    user_a, _ = user_ids
    # Mint via chat-driving JWT.
    r = await client.post(
        "/api/agent/sandbox/phantom/mint",
        headers={"Authorization": f"Bearer {_chat_jwt(user_a)}"},
        json={"scope_label": "thread-resolve"},
    )
    phantom = r.json()["token"]

    # Use phantom on a sandbox-facing route.
    r = await client.get(
        "/api/agent/events/search",
        headers={"Authorization": f"Bearer {phantom}"},
    )
    # 200 even when user has zero events — endpoint returns {"items": []}.
    assert r.status_code == 200, r.text


@pytest.mark.asyncio
async def test_jwt_still_works_on_agent_route(client, user_ids):
    """No regression: chat-driving JWTs continue to authenticate /api/agent/*."""
    user_a, _ = user_ids
    r = await client.get(
        "/api/agent/events/search",
        headers={"Authorization": f"Bearer {_chat_jwt(user_a)}"},
    )
    assert r.status_code == 200, r.text


# ── revoke ──


@pytest.mark.asyncio
async def test_revoke_kills_phantom(client, user_ids):
    user_a, _ = user_ids
    chat = _chat_jwt(user_a)
    r = await client.post(
        "/api/agent/sandbox/phantom/mint",
        headers={"Authorization": f"Bearer {chat}"},
        json={"scope_label": "revoke-test"},
    )
    phantom = r.json()["token"]

    # Pre-revoke: phantom works.
    r = await client.get(
        "/api/agent/events/search",
        headers={"Authorization": f"Bearer {phantom}"},
    )
    assert r.status_code == 200

    # Revoke via raw token.
    r = await client.post(
        "/api/agent/sandbox/phantom/revoke",
        headers={"Authorization": f"Bearer {chat}"},
        json={"token": phantom, "reason": "test"},
    )
    assert r.status_code == 200
    assert r.json()["revoked"] == 1

    # Cache is invalidated by the revoke path; next call re-resolves and 401s.
    r = await client.get(
        "/api/agent/events/search",
        headers={"Authorization": f"Bearer {phantom}"},
    )
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_revoke_xor_constraint(client, user_ids):
    """Exactly-one-of {token, sandbox_id} — both / neither → 400."""
    user_a, _ = user_ids
    chat = _chat_jwt(user_a)
    # Neither
    r = await client.post(
        "/api/agent/sandbox/phantom/revoke",
        headers={"Authorization": f"Bearer {chat}"},
        json={},
    )
    assert r.status_code == 400
    # Both
    r = await client.post(
        "/api/agent/sandbox/phantom/revoke",
        headers={"Authorization": f"Bearer {chat}"},
        json={"token": "pai_sbx_x", "sandbox_id": "sbx_y"},
    )
    assert r.status_code == 400
