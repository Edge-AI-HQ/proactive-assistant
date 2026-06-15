"""Ambient → signals ingest routing + filter allowlist.

Proactive sunset (plan 2026-06-14): ambient cloud data no longer feeds a
proactive timeline. Only the voice transcript (utterance / session_summary)
is surfaced to pai_personal_signals so main chat / memory can read the user's
offline life; every other ambient/device kind is accepted but filtered (not
persisted). The client keeps reporting all kinds; the server drops the rest.
"""

from __future__ import annotations

import time
import uuid
from datetime import UTC, datetime, timedelta

import httpx
import jwt as pyjwt
import pytest
import pytest_asyncio

from pinai_agents.web.app import create_app
from pinai_agents.web.auth import supabase_jwt as supabase_jwt_module
from pinai_agents.web.db.rls import user_scoped_tx

HMAC_SECRET = "test-hmac-secret-must-be-long-enough!"


@pytest.fixture(autouse=True)
def _set_env(monkeypatch):
    monkeypatch.setenv("PAI_HMAC_SECRET", HMAC_SECRET)
    monkeypatch.setenv("SUPABASE_URL", "https://test.supabase.invalid")
    monkeypatch.setenv("SUPABASE_PUBLISHABLE_KEY", "test-publishable-key")
    from pinai_agents import config

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


async def _signal_rows(pool, user_id: int) -> list[dict]:
    async with user_scoped_tx(pool, user_id) as conn, conn.cursor() as cur:
        await cur.execute(
            "SELECT kind, title, summary FROM pai_personal_signals WHERE user_id=%s",
            (user_id,),
        )
        return list(await cur.fetchall())


# ── utterance / session_summary → signals (allowlisted) ───────────────


@pytest.mark.asyncio
async def test_ambient_utterance_lands_in_signals(device, pool):
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

    rows = await _signal_rows(pool, user_id)
    assert len(rows) == 1
    assert rows[0]["kind"] == "ambient.utterance"
    assert "call mom" in (rows[0]["summary"] or "")


@pytest.mark.asyncio
async def test_session_summary_lands_in_signals(device, pool):
    """`session_summary` is the V3 voice-transcript primary path → signals."""
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

    rows = await _signal_rows(pool, user_id)
    assert len(rows) == 1
    assert rows[0]["kind"] == "session_summary"


# ── other ambient/device kinds → filtered (no cloud sink) ─────────────


@pytest.mark.asyncio
async def test_ambient_location_is_filtered(device, pool):
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
    # Accepted but not persisted.
    assert r.json()["results"][0]["status"] == "filtered"
    assert await _signal_rows(pool, user_id) == []


@pytest.mark.asyncio
async def test_device_visit_is_filtered(device, pool):
    """`device.*` is what the V3 client actually emits — also filtered."""
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
    assert r.json()["results"][0]["status"] == "filtered"
    assert await _signal_rows(pool, user_id) == []


# ── legacy V2 signal path unchanged ───────────────────────────────────


@pytest.mark.asyncio
async def test_legacy_candidate_window_still_signal(device, pool):
    """`ambient.candidate_window` is the V2 aggregated-transcript path that
    lands in pai_personal_signals. Unchanged by the sunset — old builds keep
    working."""
    c, device_id, device_token, _user_id = device
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
