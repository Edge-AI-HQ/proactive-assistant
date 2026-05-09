"""End-to-end HTTP test of /api/chat-stream/init + /threads.

Pins the route-layer contract:
  * POST /init with empty body recovers the user's most-recent main
    thread (or mints a new one if they have none).
  * POST /init with body.session_key validates ownership (rejects
    other-user prefixes with 400) and ensures metadata row exists.
  * POST /init with body.card_id derives the deterministic card thread.
  * GET  /threads filters by kind and skips archived.

Auth + chat-side network are stubbed (Supabase verify patched, chat
/exists monkeypatched to return False) so the test stays self-contained
and only exercises web's own logic + DB.
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
from pinai_agents.web.services import chat_proxy as chat_proxy_module

HMAC_SECRET = "test-hmac-secret-must-be-long-enough!"


@pytest.fixture(autouse=True)
def _set_env(monkeypatch):
    monkeypatch.setenv("PAI_HMAC_SECRET", HMAC_SECRET)
    monkeypatch.setenv("SUPABASE_URL", "https://test.supabase.invalid")
    monkeypatch.setenv("SUPABASE_ANON_KEY", "test-anon-key")
    from pinai_agents import config
    config.get_web_settings.cache_clear()
    yield
    config.get_web_settings.cache_clear()


@pytest.fixture(autouse=True)
def _patch_supabase_verify(monkeypatch):
    """Replace network call to Supabase /auth/v1/user — decode the
    fixture-minted token locally and synthesize SupabaseClaims."""
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
        return supabase_jwt_module.SupabaseClaims(
            sub=sub,
            email=claims.get("email"),
            role=claims.get("role", "authenticated"),
        )

    monkeypatch.setattr(supabase_jwt_module, "_call_supabase", _fake)
    supabase_jwt_module.reset_cache_for_tests()
    yield
    supabase_jwt_module.reset_cache_for_tests()


@pytest.fixture(autouse=True)
def _patch_chat_proxy(monkeypatch):
    """Stub chat-side `/agent/chat/exists`. Init route always treats
    response as "no existing turns" so we don't need a chat process."""
    async def _fake_exists(*, user_id: int, session_key: str) -> bool:
        return False

    monkeypatch.setattr(chat_proxy_module, "call_chat_exists", _fake_exists)
    # Also patch it where chat.py imported it from.
    from pinai_agents.web.routes.ui import chat as chat_route_module
    monkeypatch.setattr(chat_route_module, "call_chat_exists", _fake_exists)


@pytest.fixture
def supabase_jwt():
    def _mk(sub: str) -> str:
        return pyjwt.encode(
            {
                "sub": sub,
                "aud": "authenticated",
                "role": "authenticated",
                "exp": int(time.time()) + 3600,
                "iat": int(time.time()),
            },
            "irrelevant-payload-ferry-secret-32bytes!",
            algorithm="HS256",
        )
    return _mk


@pytest_asyncio.fixture
async def client(pool, supabase_jwt):
    app = create_app()
    app.state.pool = pool
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport, base_url="http://testserver",
    ) as c:
        yield c, supabase_jwt


async def _bootstrap_user(c: httpx.AsyncClient, mk_jwt) -> tuple[int, str]:
    """Hit any authenticated route to upsert a user row, return (user_id, token)."""
    sub = str(uuid.uuid4())
    token = mk_jwt(sub)
    r = await c.get("/api/health", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200
    return r.json()["userId"], token


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def _cleanup(pool, supabase_user_id: str) -> None:
    """Delete the synthetic user row + cascade their threads / langgraph
    state via FK ON DELETE CASCADE."""
    async with pool.connection() as conn, conn.transaction():
        await conn.execute(
            "DELETE FROM users WHERE supabase_user_id = %s", (supabase_user_id,),
        )


# ── /init three-way resolution ─────────────────────────────────────────────


@pytest.mark.asyncio
async def test_init_empty_body_mints_new_thread_for_fresh_user(client, pool):
    c, mk_jwt = client
    sub = str(uuid.uuid4())
    token = mk_jwt(sub)
    try:
        r = await c.post("/api/chat-stream/init", headers=_auth(token), json={})
        assert r.status_code == 200, r.text
        body = r.json()
        assert "sessionKey" in body
        sk = body["sessionKey"]
        # Backend uses internal user_id (an int, not the supabase sub).
        # Just verify the shape is right.
        assert sk.startswith("main-") and "-" in sk[5:]
        assert body["existing"] is False  # call_chat_exists stub returns False
    finally:
        await _cleanup(pool, sub)


@pytest.mark.asyncio
async def test_init_empty_body_returns_existing_thread_when_user_has_one(client, pool):
    """The bug fix: cache miss should NOT mint a new thread when the
    user already has one in pai_chat_threads."""
    c, mk_jwt = client
    sub = str(uuid.uuid4())
    token = mk_jwt(sub)
    try:
        # First /init → mints thread X
        r = await c.post("/api/chat-stream/init", headers=_auth(token), json={})
        first_sk = r.json()["sessionKey"]

        # Second /init with empty body → should return SAME thread X
        # (recovered from pai_chat_threads, NOT minted fresh)
        r2 = await c.post("/api/chat-stream/init", headers=_auth(token), json={})
        assert r2.status_code == 200
        assert r2.json()["sessionKey"] == first_sk
    finally:
        await _cleanup(pool, sub)


@pytest.mark.asyncio
async def test_init_with_card_id_derives_card_thread(client, pool):
    c, mk_jwt = client
    sub = str(uuid.uuid4())
    token = mk_jwt(sub)
    card_id = "gen.run42.cardZ_card_03"
    try:
        r = await c.post(
            "/api/chat-stream/init", headers=_auth(token),
            json={"cardId": card_id},
        )
        assert r.status_code == 200
        assert r.json()["sessionKey"] == f"card-thread-{card_id}"
    finally:
        await _cleanup(pool, sub)


@pytest.mark.asyncio
async def test_init_with_explicit_session_key_round_trips(client, pool):
    """FE sends cached sessionKey from localStorage. Backend validates it
    matches the user, ensures metadata row exists, returns same key."""
    c, mk_jwt = client
    sub = str(uuid.uuid4())
    token = mk_jwt(sub)
    try:
        # First init to learn user_id
        r0 = await c.post("/api/chat-stream/init", headers=_auth(token), json={})
        first_sk = r0.json()["sessionKey"]

        # Now send back the same sessionKey explicitly
        r = await c.post(
            "/api/chat-stream/init", headers=_auth(token),
            json={"sessionKey": first_sk},
        )
        assert r.status_code == 200
        assert r.json()["sessionKey"] == first_sk
    finally:
        await _cleanup(pool, sub)


@pytest.mark.asyncio
async def test_init_rejects_session_key_for_different_user(client, pool):
    """Security: session_key claiming to belong to user_b can't be used
    by user_a — the validator checks the user_id prefix matches."""
    c, mk_jwt = client
    sub_a = str(uuid.uuid4())
    sub_b = str(uuid.uuid4())
    token_a = mk_jwt(sub_a)
    token_b = mk_jwt(sub_b)
    try:
        # Bootstrap both users to assign internal IDs.
        ra = await c.get("/api/health", headers=_auth(token_a))
        rb = await c.get("/api/health", headers=_auth(token_b))
        user_a_id = ra.json()["userId"]
        user_b_id = rb.json()["userId"]
        assert user_a_id != user_b_id

        # user_a tries to claim a session_key shaped for user_b.
        forged = f"main-{user_b_id}-deadbeef0000"
        r = await c.post(
            "/api/chat-stream/init", headers=_auth(token_a),
            json={"sessionKey": forged},
        )
        assert r.status_code == 400
        assert "session_key" in r.text.lower()
    finally:
        await _cleanup(pool, sub_a)
        await _cleanup(pool, sub_b)


@pytest.mark.asyncio
async def test_init_rejects_garbage_session_key(client, pool):
    c, mk_jwt = client
    sub = str(uuid.uuid4())
    token = mk_jwt(sub)
    try:
        r = await c.post(
            "/api/chat-stream/init", headers=_auth(token),
            json={"sessionKey": "totally-bogus-shape"},
        )
        assert r.status_code == 400
    finally:
        await _cleanup(pool, sub)


# ── /threads list endpoint ─────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_threads_list_starts_empty(client, pool):
    c, mk_jwt = client
    sub = str(uuid.uuid4())
    token = mk_jwt(sub)
    try:
        r = await c.get("/api/chat-stream/threads", headers=_auth(token))
        assert r.status_code == 200
        assert r.json() == {"threads": []}
    finally:
        await _cleanup(pool, sub)


@pytest.mark.asyncio
async def test_threads_list_returns_main_and_card_threads(client, pool):
    c, mk_jwt = client
    sub = str(uuid.uuid4())
    token = mk_jwt(sub)
    try:
        # Create a main thread
        await c.post("/api/chat-stream/init", headers=_auth(token), json={})
        # Create a card thread
        await c.post(
            "/api/chat-stream/init", headers=_auth(token),
            json={"cardId": "gen.r1.c0_card_00"},
        )

        r = await c.get("/api/chat-stream/threads", headers=_auth(token))
        assert r.status_code == 200
        threads = r.json()["threads"]
        assert len(threads) == 2
        kinds = {t["kind"] for t in threads}
        assert kinds == {"main", "card"}

        # Filter by kind
        r_main = await c.get(
            "/api/chat-stream/threads?kind=main", headers=_auth(token),
        )
        assert {t["kind"] for t in r_main.json()["threads"]} == {"main"}

        r_card = await c.get(
            "/api/chat-stream/threads?kind=card", headers=_auth(token),
        )
        assert {t["kind"] for t in r_card.json()["threads"]} == {"card"}
        card_thread = r_card.json()["threads"][0]
        assert card_thread["cardId"] == "gen.r1.c0_card_00"
        assert card_thread["threadId"] == "card-thread-gen.r1.c0_card_00"
    finally:
        await _cleanup(pool, sub)


@pytest.mark.asyncio
async def test_threads_list_isolates_users(client, pool):
    c, mk_jwt = client
    sub_a = str(uuid.uuid4())
    sub_b = str(uuid.uuid4())
    token_a = mk_jwt(sub_a)
    token_b = mk_jwt(sub_b)
    try:
        await c.post("/api/chat-stream/init", headers=_auth(token_a), json={})
        await c.post("/api/chat-stream/init", headers=_auth(token_b), json={})

        ra = await c.get("/api/chat-stream/threads", headers=_auth(token_a))
        rb = await c.get("/api/chat-stream/threads", headers=_auth(token_b))
        a_keys = {t["threadId"] for t in ra.json()["threads"]}
        b_keys = {t["threadId"] for t in rb.json()["threads"]}
        assert len(a_keys) == 1
        assert len(b_keys) == 1
        assert a_keys.isdisjoint(b_keys)  # No leakage
    finally:
        await _cleanup(pool, sub_a)
        await _cleanup(pool, sub_b)


@pytest.mark.asyncio
async def test_threads_list_requires_auth(client):
    c, _ = client
    r = await c.get("/api/chat-stream/threads")
    assert r.status_code == 401
