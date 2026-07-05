"""Goal 4: internal-operator impersonation mint endpoint.

Locks the trust-boundary contract for /api/operator/impersonate/chat-token:
  1. Rejects non-internal auth (an agent-run JWT is not dashboard auth) → 401.
  2. Rejects an authenticated current_user not on the operator allowlist → 403.
  3. (Integration) an allowlisted operator mints a token bound to the target.

(The preference-write source contract — operator provenance server-stamped
into the event, NEVER from body — moved onto event_append when preferences
folded into the unified L1 write path; see test_events_agent_routes.py.)
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
from pinai_api.platform.auth.deps import User, current_user


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
async def app_and_client(pool):
    app = create_app()
    app.state.pool = pool
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport,
        base_url="http://testserver",
    ) as c:
        yield app, c


def _agent_auth(user_id: int) -> dict[str, str]:
    token, _ = sign_agent_run_jwt(user_id=user_id, virtual_key=None)
    return {"Authorization": f"Bearer {token}"}


@pytest.mark.asyncio
async def test_mint_endpoint_rejects_non_internal_auth(app_and_client, user_ids):
    """An agent-run JWT is not dashboard (Supabase) auth — current_user
    rejects it, so the mint endpoint returns 401."""
    _, client = app_and_client
    user_a, _ = user_ids
    r = await client.post(
        "/api/operator/impersonate/chat-token",
        headers=_agent_auth(user_a),
        json={"targetSupabaseUserId": "whatever"},
    )
    assert r.status_code in (401, 403), r.text


def _refresh_settings():
    from pinai_api import config

    config.get_web_settings.cache_clear()


@pytest.mark.asyncio
async def test_mint_endpoint_rejects_authenticated_non_operator(app_and_client, user_ids, pool):
    """Authenticated current_user that is NOT on the operator allowlist →
    403. current_user alone must not be enough to impersonate (the routes
    live in the shared web process)."""
    app, client = app_and_client
    operator_id, target_id = user_ids
    target_sub = await _supabase_sub(pool, target_id)

    operator_user = User(
        id=operator_id,
        supabase_user_id="not-on-the-allowlist",
        email="op@test.invalid",
        litellm_virtual_key=None,
        browserbase_context_id=None,
    )
    app.dependency_overrides[current_user] = lambda: operator_user
    _refresh_settings()  # INTERNAL_OPERATOR_SUBS unset → fail-closed
    try:
        r = await client.post(
            "/api/operator/impersonate/chat-token",
            json={"targetSupabaseUserId": target_sub},
        )
    finally:
        app.dependency_overrides.pop(current_user, None)
        _refresh_settings()
    assert r.status_code == 403, r.text


@pytest.mark.asyncio
async def test_mint_endpoint_success_for_allowlisted_operator(
    app_and_client,
    user_ids,
    pool,
    monkeypatch,
):
    """Allowlisted internal operator mints a token bound to the target."""
    app, client = app_and_client
    operator_id, target_id = user_ids
    operator_sub = await _supabase_sub(pool, operator_id)
    target_sub = await _supabase_sub(pool, target_id)

    monkeypatch.setenv("INTERNAL_OPERATOR_SUBS", f"some-other-uuid,{operator_sub}")
    _refresh_settings()

    operator_user = User(
        id=operator_id,
        supabase_user_id=operator_sub,
        email="op@test.invalid",
        litellm_virtual_key=None,
        browserbase_context_id=None,
    )
    app.dependency_overrides[current_user] = lambda: operator_user
    try:
        r = await client.post(
            "/api/operator/impersonate/chat-token",
            json={"targetSupabaseUserId": target_sub},
        )
    finally:
        app.dependency_overrides.pop(current_user, None)
        _refresh_settings()

    assert r.status_code == 200, r.text
    body = r.json()
    assert body["userId"] == target_id
    assert body["token"]
    assert body["runId"]


async def _supabase_sub(pool, user_id: int) -> str:
    async with pool.connection() as conn:
        cur = await conn.execute(
            "SELECT supabase_user_id FROM users WHERE id = %s",
            (user_id,),
        )
        row = await cur.fetchone()
    return str(row["supabase_user_id"])
