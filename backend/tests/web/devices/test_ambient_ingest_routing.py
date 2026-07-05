"""Ambient → pai_raw context-event ingest routing.

Since the lifelong-memory L0 unification, signal_only / dual device kinds no
longer write pai_personal_signals — every ambient / device context event lands
in pai_raw (toolkit='device', entity_type = the normalized context bucket) and
the event projector turns it into an L1 pai_events row in the same ingest tx.
These tests assert that routing: which kinds land (and under which entity_type)
vs. which are filtered-dropped.
"""

from __future__ import annotations

import time
import uuid
from datetime import UTC, datetime, timedelta

import httpx
import jwt as pyjwt
import pytest
import pytest_asyncio
from pinai_api.app import create_app
from pinai_api.platform.auth import supabase_jwt as supabase_jwt_module
from pinai_db.rls import user_scoped_tx

HMAC_SECRET = "test-hmac-secret-must-be-long-enough!"


@pytest.fixture(autouse=True)
def _set_env(monkeypatch):
    monkeypatch.setenv("PAI_HMAC_SECRET", HMAC_SECRET)
    monkeypatch.setenv("SUPABASE_URL", "https://test.supabase.invalid")
    monkeypatch.setenv("SUPABASE_PUBLISHABLE_KEY", "test-publishable-key")
    from pinai_api import config

    config.get_web_settings.cache_clear()
    yield
    config.get_web_settings.cache_clear()


@pytest.fixture(autouse=True)
def _patch_supabase_verify(monkeypatch):
    async def _fake(token: str) -> supabase_jwt_module.SupabaseClaims:
        claims = pyjwt.decode(
            token,
            options={"verify_signature": False, "verify_exp": False},
        )
        sub = claims.get("sub")
        if not isinstance(sub, str) or not sub:
            raise supabase_jwt_module.JWTVerifyError("test token missing sub")
        return supabase_jwt_module.SupabaseClaims(
            sub=sub,
            email=claims.get("email"),
            role="authenticated",
        )

    monkeypatch.setattr(supabase_jwt_module, "_call_supabase", _fake)
    supabase_jwt_module.reset_cache_for_tests()
    yield
    supabase_jwt_module.reset_cache_for_tests()


@pytest_asyncio.fixture
async def client(pool):
    app = create_app()
    app.state.pool = pool
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as c:
        yield c


def _supabase_jwt(sub: str) -> str:
    return pyjwt.encode(
        {
            "sub": sub,
            "aud": "authenticated",
            "role": "authenticated",
            "exp": int(time.time()) + 3600,
            "iat": int(time.time()),
        },
        "irrelevant",
        algorithm="HS256",
    )


@pytest_asyncio.fixture
async def device(client, pool):
    sub = str(uuid.uuid4())
    token = _supabase_jwt(sub)
    device_id = f"test-device-{uuid.uuid4().hex[:10]}"
    r = await client.post(
        "/api/devices/register",
        headers={"Authorization": f"Bearer {token}"},
        json={"deviceId": device_id, "platform": "ios"},
    )
    assert r.status_code == 200, r.text
    device_token = r.json()["deviceToken"]

    async with pool.connection() as conn:
        cur = await conn.execute(
            "SELECT id FROM users WHERE supabase_user_id = %s",
            (sub,),
        )
        row = await cur.fetchone()
    user_id = row["id"]

    try:
        yield client, device_id, device_token, user_id
    finally:
        async with pool.connection() as conn, conn.transaction():
            await conn.execute(
                "DELETE FROM users WHERE supabase_user_id = %s",
                (sub,),
            )


def _headers(device_id: str, device_token: str) -> dict[str, str]:
    return {"X-Device-Id": device_id, "X-Device-Token": device_token}


def _now() -> datetime:
    return datetime.now(UTC)


async def _raw_rows(pool, user_id: int) -> list[dict]:
    """Device context events land in pai_raw_device (kind = the normalized
    context bucket). title / snippet are the display projections; the original
    source ``kind`` is carried in payload — aliased ``payload_kind`` here to
    avoid clashing with the table's own ``kind`` column — so it's still
    assertable."""
    async with user_scoped_tx(pool, user_id) as conn, conn.cursor() as cur:
        await cur.execute(
            """
            SELECT kind, title, snippet, payload->>'kind' AS payload_kind
            FROM pai_raw_device
            WHERE user_id = %s
            ORDER BY occurred_at DESC
            """,
            (user_id,),
        )
        return list(await cur.fetchall())


async def _event_types(pool, user_id: int) -> list[str]:
    """L1 event_types projected from this user's device raw rows (newest
    first) — proves the synchronous projector ran inside the ingest tx."""
    async with user_scoped_tx(pool, user_id) as conn, conn.cursor() as cur:
        await cur.execute(
            "SELECT event_type FROM pai_events WHERE user_id = %s ORDER BY occurred_at DESC",
            (user_id,),
        )
        return [r["event_type"] for r in await cur.fetchall()]


# ── utterance / session_summary → pai_raw (entity=utterance) ──────────


@pytest.mark.asyncio
async def test_ambient_utterance_lands_in_raw(device, pool):
    c, device_id, device_token, user_id = device
    occurred = _now() - timedelta(seconds=10)
    item = {
        "id": f"utt_{uuid.uuid4().hex[:12]}",
        "kind": "ambient.utterance",
        "title": "i need to call mom tomorrow",
        "summary": "i need to call mom tomorrow",
        "occurredAt": occurred.isoformat(),
        "salience": 0.0,
        "confidence": 0.95,
        "syncMode": "incremental",
        "source": f"device:{device_id}",
        "payload": {"text": "i need to call mom tomorrow", "language": "en"},
    }
    r = await c.post(
        "/api/devices/ingest",
        headers=_headers(device_id, device_token),
        json={"deviceId": device_id, "items": [item]},
    )
    assert r.status_code == 200, r.text
    assert r.json()["results"][0]["status"] == "inserted"

    rows = await _raw_rows(pool, user_id)
    assert len(rows) == 1
    assert rows[0]["kind"] == "utterance"
    assert rows[0]["payload_kind"] == "ambient.utterance"
    assert "call mom" in (rows[0]["snippet"] or "")
    # utterance (session_summary / ambient.utterance = 一次会话的成品转写) 从 2026-06-30
    # 起走 off/1→1:rollup_policy 把 utterance 移出 semantic,projector 实时投成 utterance
    # event(只 transcript_window 仍走 daily rollup)。raw 落库 + L1 event 立即出。
    assert await _event_types(pool, user_id) == ["utterance"]


@pytest.mark.asyncio
async def test_session_summary_lands_in_raw(device, pool):
    """`session_summary` is the V3 voice-transcript primary path → pai_raw
    entity=utterance (the projector maps it to an `utterance` event)."""
    c, device_id, device_token, user_id = device
    occurred = _now() - timedelta(seconds=10)
    item = {
        "id": f"sess_{uuid.uuid4().hex[:12]}",
        "kind": "session_summary",
        "title": "Morning standup",
        "summary": "self: shipped the sunset PR. teammate: reviewing now.",
        "occurredAt": occurred.isoformat(),
        "salience": 0.0,
        "confidence": 0.9,
        "syncMode": "incremental",
        "source": f"device:{device_id}",
        "payload": {"language": "en", "speaker_segments": [{"speaker": "self"}]},
    }
    r = await c.post(
        "/api/devices/ingest",
        headers=_headers(device_id, device_token),
        json={"deviceId": device_id, "items": [item]},
    )
    assert r.status_code == 200, r.text
    assert r.json()["results"][0]["status"] == "inserted"

    rows = await _raw_rows(pool, user_id)
    assert len(rows) == 1
    assert rows[0]["kind"] == "utterance"
    assert rows[0]["payload_kind"] == "session_summary"


# ── high-value aggregate ambient/device kinds → pai_raw ──────────────


@pytest.mark.asyncio
async def test_ambient_location_lands_in_raw(device, pool):
    """location was _FILTERED_POLICY (accepted-but-dropped). DATA-FLOW OPEN
    (2026-06-30) flipped it to signal_only so every ambient sensor lands in
    pai_raw. No _CONTEXT_ENTITY_TYPE mapping → normalized kind 'context'."""
    c, device_id, device_token, user_id = device
    occurred = _now() - timedelta(seconds=30)
    item = {
        "id": f"loc_{uuid.uuid4().hex[:12]}",
        "kind": "ambient.location",
        "title": "Arrived at Office",
        "summary": "Location: SF Mission",
        "occurredAt": occurred.isoformat(),
        "salience": 0.0,
        "confidence": 0.9,
        "syncMode": "incremental",
        "source": f"device:{device_id}",
        "payload": {"location": {"lat": 37.7749, "lng": -122.4194}},
    }
    r = await c.post(
        "/api/devices/ingest",
        headers=_headers(device_id, device_token),
        json={"deviceId": device_id, "items": [item]},
    )
    assert r.status_code == 200, r.text
    assert r.json()["results"][0]["status"] == "inserted"
    rows = await _raw_rows(pool, user_id)
    assert len(rows) == 1
    assert rows[0]["kind"] == "context"
    assert rows[0]["payload_kind"] == "ambient.location"


@pytest.mark.asyncio
async def test_device_visit_lands_in_raw(device, pool):
    """`device.*` is what the Expo/RN client actually emits."""
    c, device_id, device_token, user_id = device
    occurred = _now() - timedelta(seconds=30)
    item = {
        "id": f"vis_{uuid.uuid4().hex[:12]}",
        "kind": "device.visit",
        "title": "Visit: Cafe",
        "summary": "30 min at Cafe",
        "occurredAt": occurred.isoformat(),
        "salience": 0.0,
        "confidence": 0.9,
        "syncMode": "incremental",
        "source": f"device:{device_id}",
        "payload": {"place_name": "Cafe"},
    }
    r = await c.post(
        "/api/devices/ingest",
        headers=_headers(device_id, device_token),
        json={"deviceId": device_id, "items": [item]},
    )
    assert r.status_code == 200, r.text
    assert r.json()["results"][0]["status"] == "inserted"
    rows = await _raw_rows(pool, user_id)
    assert len(rows) == 1
    assert rows[0]["kind"] == "visit"
    assert rows[0]["payload_kind"] == "device.visit"
    assert rows[0]["snippet"] == "30 min at Cafe"
    # entity=visit projects to a `movement` L1 event.
    assert await _event_types(pool, user_id) == ["movement"]


# ── transcript candidate window → pai_raw (entity=transcript_window) ──


@pytest.mark.asyncio
async def test_candidate_window_lands_in_transcript_window_raw(device, pool):
    """`ambient.candidate_window` (V2 aggregated-transcript path) now lands in
    pai_raw entity=transcript_window via the latest-wins upsert; the projector
    maps it to an `utterance` event."""
    c, device_id, device_token, user_id = device
    occurred = _now() - timedelta(seconds=30)
    item = {
        "id": f"cand_{uuid.uuid4().hex[:12]}",
        "kind": "ambient.candidate_window",
        "title": "Session 2026-05-21 morning",
        "summary": "i said hello world",
        "occurredAt": occurred.isoformat(),
        "salience": 0.5,
        "confidence": 0.9,
        "syncMode": "incremental",
        "source": f"device:{device_id}",
        "payload": {
            "window_type": "transcript_session",
            "local_date": "2026-05-21",
            "local_window_id": "win_001",
            "raw_ref_count": 3,
            "compact_context": "i said hello world",
            "content_hash": "abc123",
        },
    }
    r = await c.post(
        "/api/devices/ingest",
        headers=_headers(device_id, device_token),
        json={"deviceId": device_id, "items": [item]},
    )
    assert r.status_code == 200, r.text
    assert r.json()["results"][0]["status"] == "inserted"

    rows = await _raw_rows(pool, user_id)
    assert len(rows) == 1
    assert rows[0]["kind"] == "transcript_window"
    assert rows[0]["payload_kind"] == "ambient.candidate_window"
    # transcript_window is a semantic-rollup firehose source — projector skips
    # it (evolve collapses into an episode event), so no L1 event here (§4.2).
    assert await _event_types(pool, user_id) == []
