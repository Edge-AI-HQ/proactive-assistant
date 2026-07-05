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
from pinai_api.app import create_app
from pinai_api.platform.auth import supabase_jwt as supabase_jwt_module

HMAC_SECRET = "test-hmac-secret-must-be-long-enough!"


@pytest.fixture(autouse=True)
def _set_env(monkeypatch):
    monkeypatch.setenv("PAI_HMAC_SECRET", HMAC_SECRET)
    # Stand-in values — never hit the network because _call_supabase is
    # patched, but the verify path does require these to be non-empty.
    monkeypatch.setenv("SUPABASE_URL", "https://test.supabase.invalid")
    monkeypatch.setenv("SUPABASE_PUBLISHABLE_KEY", "test-publishable-key")
    from pinai_api import config

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
                token,
                options={"verify_signature": False, "verify_exp": False},
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
            "irrelevant-secret-32-bytes-payload-ferry!",
            algorithm="HS256",
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
            "DELETE FROM users WHERE supabase_user_id = %s",
            (sub,),
        )


@pytest.mark.asyncio
async def test_invalid_jwt_returns_401(client):
    c, _ = client
    r = await c.get(
        "/api/health",
        headers={"Authorization": "Bearer this-is-not-a-jwt"},
    )
    assert r.status_code == 401
