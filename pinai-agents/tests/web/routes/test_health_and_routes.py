"""HTTP route smoke via async httpx ASGITransport.

Why not TestClient: TestClient is sync (runs starlette in a separate
worker thread). Our pool fixture lives in the pytest-asyncio event loop;
TestClient handlers touching the pool from a different loop deadlock.
httpx.AsyncClient + ASGITransport keeps everything on one loop.

Auth note: production verifies Supabase JWTs by calling
`${SUPABASE_URL}/auth/v1/user` (see web/auth/supabase_jwt.py — local
HS256 verification was retired). Tests can't hit a real Supabase, so we
patch `_call_supabase` to decode our own unverified test tokens and
synthesize SupabaseClaims. The token payload format below is just a
transport for sub/email between fixture and patch.
"""

from __future__ import annotations

import time
import uuid

import httpx
import jwt as pyjwt
import pytest
import pytest_asyncio

from pinai_agents.web.app import create_app
from pinai_agents.web.auth import supabase_jwt as supabase_jwt_module

HMAC_SECRET = "test-hmac-secret-must-be-long-enough!"


@pytest.fixture(autouse=True)
def _set_env(monkeypatch):
    monkeypatch.setenv("PAI_HMAC_SECRET", HMAC_SECRET)
    # Stand-in values — never hit the network because _call_supabase is
    # patched, but the verify path does require these to be non-empty.
    monkeypatch.setenv("SUPABASE_URL", "https://test.supabase.invalid")
    monkeypatch.setenv("SUPABASE_PUBLISHABLE_KEY", "test-publishable-key")
    from pinai_agents import config
    config.get_web_settings.cache_clear()
    yield
    config.get_web_settings.cache_clear()


@pytest.fixture(autouse=True)
def _patch_supabase_verify(monkeypatch):
    """Replace the network round-trip to Supabase /auth/v1/user.

    We decode the test token without signature verification (the token's
    only purpose is to ferry sub/email from the fixture to here) and
    return a synthesized SupabaseClaims. Mirrors what the real Supabase
    response would look like for a valid bearer."""
    async def _fake(token: str) -> supabase_jwt_module.SupabaseClaims:
        try:
            claims = pyjwt.decode(
                token, options={"verify_signature": False, "verify_exp": False},
            )
        except pyjwt.InvalidTokenError as e:
            raise supabase_jwt_module.JWTVerifyError(
                f"test token decode failed: {e}",
            ) from e
        sub = claims.get("sub")
        if not isinstance(sub, str) or not sub:
            raise supabase_jwt_module.JWTVerifyError("test token missing sub")
        email = claims.get("email")
        return supabase_jwt_module.SupabaseClaims(
            sub=sub,
            email=email if isinstance(email, str) and email else None,
            role=claims.get("role", "authenticated"),
        )

    monkeypatch.setattr(supabase_jwt_module, "_call_supabase", _fake)
    # Cache is keyed on token hash; clear so each test sees a fresh
    # network round-trip → fresh _fake invocation.
    supabase_jwt_module.reset_cache_for_tests()
    yield
    supabase_jwt_module.reset_cache_for_tests()


@pytest.fixture
def supabase_jwt():
    """Mint an unsigned-payload token. Signature is irrelevant —
    `_patch_supabase_verify` decodes it without verification."""
    def _mk(sub: str, email: str | None = None) -> str:
        return pyjwt.encode(
            {
                "sub": sub,
                "aud": "authenticated",
                "role": "authenticated",
                "email": email,
                "exp": int(time.time()) + 3600,
                "iat": int(time.time()),
            },
            "irrelevant-secret-32-bytes-payload-ferry!", algorithm="HS256",
        )
    return _mk


@pytest_asyncio.fixture
async def client(pool, supabase_jwt):
    """Async httpx client over the FastAPI app's ASGI surface.

    pool is attached to app.state directly — we skip the lifespan
    (no `transport.app(...)` startup) so our pool isn't replaced
    by the production lifespan's None.
    """
    app = create_app()
    app.state.pool = pool
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as c:
        yield c, supabase_jwt


@pytest.mark.asyncio
async def test_health_open(client):
    c, _ = client
    r = await c.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert body["service"] == "pinai-agents-web"
    assert body["db"] == "ok"


@pytest.mark.asyncio
async def test_api_health_requires_auth(client):
    c, _ = client
    r = await c.get("/api/health")
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_api_health_with_jwt(client, pool):
    c, mk_jwt = client
    sub = str(uuid.uuid4())
    token = mk_jwt(sub, email=f"u-{uuid.uuid4().hex[:6]}@test.invalid")
    r = await c.get("/api/health", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert isinstance(body["userId"], int)
    assert body["userId"] > 0
    async with pool.connection() as conn, conn.transaction():
        await conn.execute(
            "DELETE FROM users WHERE supabase_user_id = %s", (sub,),
        )


@pytest.mark.asyncio
async def test_invalid_jwt_returns_401(client):
    c, _ = client
    r = await c.get(
        "/api/health",
        headers={"Authorization": "Bearer this-is-not-a-jwt"},
    )
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_memory_list_empty_for_new_user(client, pool):
    c, mk_jwt = client
    sub = str(uuid.uuid4())
    token = mk_jwt(sub)
    r = await c.get(
        "/api/memory",
        headers={"Authorization": f"Bearer {token}"},
        params={"limit": 10},
    )
    assert r.status_code == 200
    body = r.json()
    # UI wire shape: `{ok, memories, total}` (memory.py:73-77 — explicit
    # divergence from /api/agent/memory/list which uses `{items}`).
    assert body["ok"] is True
    assert body["memories"] == []
    assert body["total"] == 0
    async with pool.connection() as conn, conn.transaction():
        await conn.execute(
            "DELETE FROM users WHERE supabase_user_id = %s", (sub,),
        )


@pytest.mark.asyncio
async def test_memory_add_and_list_roundtrip(client, pool):
    """End-to-end: add memory via /api/memory POST, list it back."""
    c, mk_jwt = client
    sub = str(uuid.uuid4())
    token = mk_jwt(sub)
    headers = {"Authorization": f"Bearer {token}"}

    add_resp = await c.post(
        "/api/memory",
        headers=headers,
        json={
            "text": "user prefers dark mode",
            "source": "test",
            "subject": "ui",
            "quality": 0.9,
        },
    )
    assert add_resp.status_code == 201
    added = add_resp.json()
    assert added["text"] == "user prefers dark mode"
    assert added["status"] == "active"

    list_resp = await c.get(
        "/api/memory",
        headers=headers,
        params={"minQuality": 0.5},
    )
    assert list_resp.status_code == 200
    body = list_resp.json()
    memories = body["memories"]
    assert len(memories) == 1
    assert memories[0]["text"] == "user prefers dark mode"
    assert body["total"] == 1

    async with pool.connection() as conn, conn.transaction():
        await conn.execute(
            "DELETE FROM users WHERE supabase_user_id = %s", (sub,),
        )


@pytest.mark.asyncio
async def test_cross_user_memory_isolation(client, pool):
    """Two users hit /api/memory with different JWTs — each only sees own."""
    c, mk_jwt = client
    sub_a = str(uuid.uuid4())
    sub_b = str(uuid.uuid4())
    token_a = mk_jwt(sub_a)
    token_b = mk_jwt(sub_b)

    # User A adds a memory
    r = await c.post(
        "/api/memory",
        headers={"Authorization": f"Bearer {token_a}"},
        json={"text": "A's secret", "source": "test", "quality": 0.8},
    )
    assert r.status_code == 201

    # User B sees zero
    r = await c.get(
        "/api/memory", headers={"Authorization": f"Bearer {token_b}"},
    )
    assert r.status_code == 200
    assert r.json()["memories"] == []

    # User A still sees their own
    r = await c.get(
        "/api/memory", headers={"Authorization": f"Bearer {token_a}"},
    )
    assert len(r.json()["memories"]) == 1

    async with pool.connection() as conn, conn.transaction():
        await conn.execute(
            "DELETE FROM users WHERE supabase_user_id IN (%s, %s)",
            (sub_a, sub_b),
        )
