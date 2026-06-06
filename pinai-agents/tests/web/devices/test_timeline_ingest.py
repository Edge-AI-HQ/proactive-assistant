"""Ambient → timeline ingest path.

Cover the new `timeline_only` policy mode: per-utterance ambient events
go straight to pai_timeline_events with curation_status='pending'.
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
from pinai_agents.web.db.repositories.timeline import TimelineRepository
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

    # Resolve user_id for downstream DB inspection.
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


# ── ambient.utterance ─────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_ambient_utterance_lands_in_timeline_as_pending(device, pool):
    c, device_id, device_token, user_id = device
    occurred = _now() - timedelta(seconds=10)
    end_at = occurred + timedelta(seconds=6)

    item = {
        "id": f"utt_{uuid.uuid4().hex[:12]}",
        "kind": "ambient.utterance",
        "title": "i need to call mom tomorrow",
        "summary": "user utterance captured by ambient mic",
        "occurredAt": occurred.isoformat(),
        "salience": 0.0,
        "confidence": 0.95,
        "syncMode": "incremental",
        "source": f"device:{device_id}",
        "payload": {
            "text": "i need to call mom tomorrow",
            "language": "en",
            "asr_confidence": 0.95,
            "endAt": end_at.isoformat(),
            "session_id": "sess_abc",
        },
    }

    r = await c.post(
        "/api/devices/ingest",
        headers=_headers(device_id, device_token),
        json={"deviceId": device_id, "items": [item]},
    )
    assert r.status_code == 200, r.text
    payload = r.json()
    assert payload["inserted"] == 1
    assert payload["results"][0]["status"] == "inserted"

    async with user_scoped_tx(pool, user_id) as conn:
        # Include pending — the row is fresh and not yet curated.
        rows = await TimelineRepository(user_id, conn).query(
            window_start=occurred - timedelta(minutes=1),
            window_end=occurred + timedelta(minutes=1),
            include_pending=True,
        )

    assert len(rows) == 1
    row = rows[0]
    assert row.source == "ambient.utterance"
    assert row.event_type == "utterance"
    assert row.title == "i need to call mom tomorrow"
    assert row.body == "i need to call mom tomorrow"
    assert row.curation_status == "pending"
    assert row.importance == pytest.approx(0.5)
    assert row.end_at is not None
    # Source ref reflects the device origin
    assert row.source_ref["device_id"] == device_id
    assert row.source_ref["sensor"] == "utterance"


@pytest.mark.asyncio
async def test_ambient_utterance_dedupe_idempotent(device, pool):
    """Re-uploading the same utterance from a retry doesn't duplicate."""
    c, device_id, device_token, user_id = device
    occurred = _now() - timedelta(seconds=10)
    item_id = f"utt_{uuid.uuid4().hex[:12]}"

    item = {
        "id": item_id,
        "kind": "ambient.utterance",
        "title": "duplicate test",
        "summary": "x",
        "occurredAt": occurred.isoformat(),
        "salience": 0.0,
        "confidence": 0.9,
        "syncMode": "incremental",
        "source": f"device:{device_id}",
        "dedupeKey": f"ambient:utterance:{device_id}:{item_id}",
        "payload": {"text": "duplicate test", "language": "en"},
    }

    r1 = await c.post(
        "/api/devices/ingest",
        headers=_headers(device_id, device_token),
        json={"deviceId": device_id, "items": [item]},
    )
    r2 = await c.post(
        "/api/devices/ingest",
        headers=_headers(device_id, device_token),
        json={"deviceId": device_id, "items": [item]},
    )
    assert r1.status_code == 200
    assert r2.status_code == 200

    async with user_scoped_tx(pool, user_id) as conn:
        rows = await TimelineRepository(user_id, conn).query(
            window_start=occurred - timedelta(minutes=1),
            window_end=occurred + timedelta(minutes=1),
            include_pending=True,
        )
    assert len(rows) == 1


@pytest.mark.asyncio
async def test_ambient_location_lands_as_state_change(device, pool):
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
        "payload": {
            "location": {
                "lat": 37.7749,
                "lng": -122.4194,
                "place_name": "Office",
                "accuracy_m": 10,
            },
        },
    }

    r = await c.post(
        "/api/devices/ingest",
        headers=_headers(device_id, device_token),
        json={"deviceId": device_id, "items": [item]},
    )
    assert r.status_code == 200, r.text
    assert r.json()["results"][0]["status"] == "inserted"

    async with user_scoped_tx(pool, user_id) as conn:
        rows = await TimelineRepository(user_id, conn).query(
            window_start=occurred - timedelta(minutes=1),
            window_end=occurred + timedelta(minutes=1),
            include_pending=True,
        )
    assert len(rows) == 1
    row = rows[0]
    assert row.source == "ambient.location"
    assert row.event_type == "state_change"
    assert row.location is not None
    assert row.location["place_name"] == "Office"


@pytest.mark.asyncio
async def test_legacy_candidate_window_still_signal(device, pool):
    """`ambient.candidate_window` is the V2 aggregated-transcript path that
    lands in pai_personal_signals. This migration is ADDITIVE: the timeline
    sink is added alongside the signal/raw path rather than replacing it, so
    the legacy kind is still accepted via signal_only (old builds keep
    working) — NOT rejected. The V3 ambient frontend simply stops emitting
    it; nothing on the backend removes the route."""
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
    body = r.json()
    assert body["results"][0]["status"] == "inserted"
