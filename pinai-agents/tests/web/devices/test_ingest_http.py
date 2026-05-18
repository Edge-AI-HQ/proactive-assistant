"""HTTP-level contract tests for /api/devices/ingest.

These exercise the full route — body-shape negotiation, header auth,
per-item ``status`` classification (5 states), and the V2-ported
metric-aware health replace + reference_count protection.

The fixtures mirror ``test_health_and_routes.py`` (httpx + ASGITransport,
patched Supabase verify) so we can register a device via Supabase JWT
then ingest with the returned device token.
"""

from __future__ import annotations

import time
import uuid
from typing import Any

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
    monkeypatch.setenv("SUPABASE_URL", "https://test.supabase.invalid")
    monkeypatch.setenv("SUPABASE_PUBLISHABLE_KEY", "test-publishable-key")
    from pinai_agents import config
    config.get_web_settings.cache_clear()
    yield
    config.get_web_settings.cache_clear()


@pytest.fixture(autouse=True)
def _patch_supabase_verify(monkeypatch):
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
    supabase_jwt_module.reset_cache_for_tests()
    yield
    supabase_jwt_module.reset_cache_for_tests()


@pytest.fixture
def supabase_jwt():
    def _mk(sub: str, email: str | None = None) -> str:
        return pyjwt.encode(
            {
                "sub": sub, "aud": "authenticated", "role": "authenticated",
                "email": email, "exp": int(time.time()) + 3600,
                "iat": int(time.time()),
            },
            "irrelevant-secret-32-bytes-payload-ferry!", algorithm="HS256",
        )
    return _mk


@pytest_asyncio.fixture
async def client(pool, supabase_jwt):
    app = create_app()
    app.state.pool = pool
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as c:
        yield c, supabase_jwt


async def _register_device(
    c: httpx.AsyncClient,
    token: str,
    device_id: str,
    *,
    platform: str = "ios",
    display_name: str | None = None,
    model: str | None = None,
    device_fingerprint: str | None = None,
    metadata: dict[str, Any] | None = None,
) -> str:
    """Register a device and return its device_token."""
    payload: dict[str, Any] = {"deviceId": device_id, "platform": platform}
    if display_name is not None:
        payload["displayName"] = display_name
    if model is not None:
        payload["model"] = model
    if device_fingerprint is not None:
        payload["deviceFingerprint"] = device_fingerprint
    if metadata is not None:
        payload["metadata"] = metadata
    r = await c.post(
        "/api/devices/register",
        headers={"Authorization": f"Bearer {token}"},
        json=payload,
    )
    assert r.status_code == 200, r.text
    return r.json()["deviceToken"]


async def _cleanup_user(pool, sub: str) -> None:
    async with pool.connection() as conn, conn.transaction():
        await conn.execute(
            "DELETE FROM users WHERE supabase_user_id = %s", (sub,),
        )


@pytest_asyncio.fixture
async def device(client, pool):
    """Provision a user + registered device, yield (client, device_id, device_token)."""
    c, mk_jwt = client
    sub = str(uuid.uuid4())
    token = mk_jwt(sub)
    device_id = f"test-device-{uuid.uuid4().hex[:10]}"
    device_token = await _register_device(c, token, device_id)
    try:
        yield c, device_id, device_token
    finally:
        await _cleanup_user(pool, sub)


def _ingest_headers(device_id: str, device_token: str) -> dict[str, str]:
    return {"X-Device-Id": device_id, "X-Device-Token": device_token}


def _wrap(device_id: str, items: list[dict]) -> dict:
    """Wrapper body — matches the iOS plugin's older path. Equivalent to
    sending an array with `source: device:<id>` on each item; we use it in
    most tests so the items don't need to repeat the source field."""
    return {"deviceId": device_id, "items": items}


@pytest.mark.asyncio
async def test_register_same_fingerprint_keeps_canonical_device_id(client, pool):
    """Fresh native installs can propose new UUIDs, but the backend must
    keep the existing server device_id so already-ingested evidence stays
    attached to the visible device."""
    c, mk_jwt = client
    sub = str(uuid.uuid4())
    token = mk_jwt(sub)
    first_id = f"ios-first-{uuid.uuid4().hex[:8]}"
    proposed_new_id = f"ios-second-{uuid.uuid4().hex[:8]}"
    fingerprint = f"ios-fp-{uuid.uuid4().hex}"

    await _register_device(
        c, token, first_id,
        display_name="iPhone", model="iPhone15,3",
        device_fingerprint=fingerprint,
    )
    second = await c.post(
        "/api/devices/register",
        headers={"Authorization": f"Bearer {token}"},
        json={
            "deviceId": proposed_new_id,
            "platform": "ios",
            "displayName": "iPhone",
            "model": "iPhone15,3",
            "deviceFingerprint": fingerprint,
        },
    )
    assert second.status_code == 200, second.text
    assert second.json()["deviceId"] == first_id

    async with pool.connection() as conn:
        cur = await conn.execute(
            """SELECT device_id, status FROM pai_user_devices
               WHERE user_id = (SELECT id FROM users WHERE supabase_user_id = %s)
                 AND platform = 'ios'
               ORDER BY registered_at DESC""",
            (sub,),
        )
        rows = await cur.fetchall()
    assert [(r["device_id"], r["status"]) for r in rows] == [(first_id, "active")]

    await _cleanup_user(pool, sub)


@pytest.mark.asyncio
async def test_device_list_collapses_legacy_ios_app_rows(client, pool):
    """Historical iOS builds registered app-install rows without hardware
    metadata. The Hardware Devices panel should show one physical iPhone
    instead of every stale canonical/dev app row."""
    c, mk_jwt = client
    sub = str(uuid.uuid4())
    token = mk_jwt(sub)
    old_id = f"ios-old-{uuid.uuid4().hex[:10]}"
    mid_id = f"ios-mid-{uuid.uuid4().hex[:10]}"
    latest_id = f"ios-new-{uuid.uuid4().hex[:10]}"
    await _register_device(c, token, old_id, display_name="iPhone", model="iPhone")
    await _register_device(c, token, mid_id, display_name="Ios app")
    latest_token = await _register_device(c, token, latest_id, display_name="Ios app")

    touch = await c.post(
        "/api/devices/ingest",
        headers=_ingest_headers(latest_id, latest_token),
        json=_wrap(latest_id, []),
    )
    assert touch.status_code == 200, touch.text

    listed = await c.get(
        "/api/devices/list",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert listed.status_code == 200, listed.text
    ios_rows = [
        item for item in listed.json()["items"]
        if item["platform"] == "ios"
    ]
    assert [item["deviceId"] for item in ios_rows] == [latest_id]
    assert set(ios_rows[0]["aliasedDeviceIds"]) == {old_id, mid_id, latest_id}

    await _cleanup_user(pool, sub)


# ── auth + body shape (D-2) ──


@pytest.mark.asyncio
async def test_ingest_missing_headers_returns_401(client):
    c, _ = client
    r = await c.post("/api/devices/ingest", json={"items": []})
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_ingest_invalid_device_token_returns_401(client):
    c, _ = client
    r = await c.post(
        "/api/devices/ingest",
        headers={"X-Device-Id": "no-such-device-xyz", "X-Device-Token": "wrong"},
        json={"items": []},
    )
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_ingest_array_body_shape(device):
    """V2 plugin sends an array directly with ``source: device:<id>`` on
    each item. Server must accept it (D-2) — array body with per-item
    source is the production path."""
    c, device_id, dtoken = device
    items = [{
        "id": "evt-array-1",
        "kind": "moment",
        "title": "Array body smoke",
        "summary": "A signal from an array-body POST",
        "source": f"device:{device_id}",
    }]
    r = await c.post(
        "/api/devices/ingest", headers=_ingest_headers(device_id, dtoken),
        json=items,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True
    assert body["accepted"] == 1
    assert body["inserted"] == 1
    assert body["results"][0]["status"] == "inserted"


@pytest.mark.asyncio
async def test_ingest_wrapper_body_shape(device):
    """Wrapper { deviceId, items } shape — same outcome as array."""
    c, device_id, dtoken = device
    r = await c.post(
        "/api/devices/ingest", headers=_ingest_headers(device_id, dtoken),
        json={"deviceId": device_id, "items": [{
            "id": "evt-wrap-1", "kind": "moment",
            "title": "Wrapped body", "summary": "Same data different shape",
        }]},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["inserted"] == 1
    assert body["results"][0]["status"] == "inserted"


@pytest.mark.asyncio
async def test_ingest_all_cross_device_items_returns_item_rejected(device):
    """Cross-device dispatch is a per-item contract failure, not an
    HTTP-level malformed request. The client needs the result body so it
    can drop the bad outbox row instead of retrying forever."""
    c, device_id, dtoken = device
    r = await c.post(
        "/api/devices/ingest", headers=_ingest_headers(device_id, dtoken),
        json=[{
            "id": "evt-cross-device-1",
            "kind": "moment",
            "title": "Cross-device body",
            "summary": "A signal carrying a stale device source",
            "source": "device:stale-device-id",
        }],
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["accepted"] == 1
    assert body["inserted"] == 0
    assert body["results"][0]["status"] == "rejected"
    assert body["results"][0]["reason"].startswith(
        "cross-device dispatch not supported",
    )


@pytest.mark.asyncio
async def test_ingest_items_field_must_be_array(device):
    c, device_id, dtoken = device
    r = await c.post(
        "/api/devices/ingest", headers=_ingest_headers(device_id, dtoken),
        json={"deviceId": device_id, "items": "not-a-list"},
    )
    assert r.status_code == 400


# ── per-item 5-state status (D-3) ──


@pytest.mark.asyncio
async def test_inserted_then_duplicate_via_dedupe_key(device):
    """Health observation with explicit dedupe_key — second ingest must
    report ``duplicate`` because raw_only uses ON CONFLICT DO NOTHING."""
    c, device_id, dtoken = device
    item = {
        "id": "hlt-dup-test",
        "kind": "health.observation",
        "title": "steps",
        "summary": "8120 steps",
        "occurred_at": "2026-05-05T16:00:00Z",
        "payload": {
            "schema_version": "health_observation.v1",
            "local_date": "2026-05-05",
            "observations": [{
                "observation_type": "daily_summary",
                "metric": "steps", "value": 8120, "unit": "count",
                "local_date": "2026-05-05", "source_app": "healthkit",
                "dedupe_key": "ios:health:steps:2026-05-05",
            }],
        },
    }
    first = await c.post(
        "/api/devices/ingest", headers=_ingest_headers(device_id, dtoken),
        json=_wrap(device_id, [item]),
    )
    assert first.status_code == 200, first.text
    assert first.json()["results"][0]["status"] == "inserted"

    # Same payload, different envelope item.id so we don't trip the
    # signal-side UPSERT — what we're testing is the raw_only DO NOTHING
    # path. The observation's dedupe_key is what matters.
    second_item = dict(item, id="hlt-dup-test-2",
                       dedupe_key="device:diff:hlt-dup-test-2")
    second = await c.post(
        "/api/devices/ingest", headers=_ingest_headers(device_id, dtoken),
        json=_wrap(device_id, [second_item]),
    )
    assert second.status_code == 200, second.text
    res = second.json()["results"][0]
    assert res["status"] == "duplicate", res


@pytest.mark.asyncio
async def test_transcript_candidate_window_uses_server_canonical_latest_upsert(
    device,
    pool,
):
    c, device_id, dtoken = device
    canonical_key = (
        f"ambient:candidate_window:{device_id}:"
        "2026-05-15:transcript_session:win-transcript"
    )

    def item(item_id: str, raw_ref_count: int, content_hash: str, summary: str) -> dict:
        return {
            "id": item_id,
            "kind": "ambient.candidate_window",
            "title": "Ambient transcript_session window",
            "summary": summary,
            "occurred_at": "2026-05-15T10:00:00Z",
            "dedupe_key": f"old-client-key:{item_id}",
            "payload": {
                "schema_version": "ambient_candidate_window_upload.v1",
                "window_type": "transcript_session",
                "local_date": "2026-05-15",
                "local_window_id": "win-transcript",
                "raw_ref_count": raw_ref_count,
                "content_hash": content_hash,
                "compact_context": summary,
            },
        }

    first = await c.post(
        "/api/devices/ingest",
        headers=_ingest_headers(device_id, dtoken),
        json=_wrap(device_id, [
            item("candidate-1", 1, "hash-1", "Transcript segment: first chunk"),
        ]),
    )
    assert first.status_code == 200, first.text
    assert first.json()["results"][0]["status"] == "inserted"
    assert first.json()["results"][0]["dedupeKey"] == canonical_key

    latest = await c.post(
        "/api/devices/ingest",
        headers=_ingest_headers(device_id, dtoken),
        json=_wrap(device_id, [
            item(
                "candidate-2", 5, "hash-5",
                "Transcript segment: five chunks Transcript segment: latest",
            ),
        ]),
    )
    assert latest.status_code == 200, latest.text
    assert latest.json()["results"][0]["status"] == "inserted"
    assert latest.json()["results"][0]["dedupeKey"] == canonical_key

    stale = await c.post(
        "/api/devices/ingest",
        headers=_ingest_headers(device_id, dtoken),
        json=_wrap(device_id, [item("candidate-3", 3, "hash-3", "stale chunks")]),
    )
    assert stale.status_code == 200, stale.text
    assert stale.json()["inserted"] == 0
    assert stale.json()["results"][0]["status"] == "duplicate"

    async with pool.connection() as conn:
        cur = await conn.execute(
            """SELECT id, dedupe_key, summary, payload
               FROM pai_personal_signals
               WHERE device_id = %s AND kind = 'ambient.candidate_window'""",
            (device_id,),
        )
        rows = await cur.fetchall()

    assert len(rows) == 1
    assert rows[0]["dedupe_key"] == canonical_key
    assert rows[0]["summary"] == "five chunks latest"
    assert rows[0]["payload"]["compact_context"] == "five chunks latest"
    assert rows[0]["payload"]["raw_ref_count"] == 5
    assert "content_hash" not in rows[0]["payload"]


@pytest.mark.asyncio
async def test_parse_failed_for_unparseable_item(device):
    """An item that fails IngestItemIn validation must show up in
    ``results`` with status=parse_failed — not silently dropped."""
    c, device_id, dtoken = device
    items = [
        # Missing required fields title/summary entirely + bad types
        {"id": "bad-item", "kind": 12345},
        # Valid alongside, so the batch isn't all-bad
        {"id": "good-item", "kind": "moment", "title": "ok", "summary": "ok"},
    ]
    r = await c.post(
        "/api/devices/ingest", headers=_ingest_headers(device_id, dtoken),
        json=_wrap(device_id, items),
    )
    assert r.status_code == 200, r.text
    statuses = {x["id"]: x["status"] for x in r.json()["results"]}
    assert statuses["good-item"] == "inserted"
    assert statuses["bad-item"] == "parse_failed"


@pytest.mark.asyncio
async def test_rejected_when_required_fields_missing(device):
    """Missing kind/title/summary — IngestItemIn allows None kind so the
    item parses, but the route-level guard marks it rejected."""
    c, device_id, dtoken = device
    items = [{
        "id": "rejected-1",
        # no kind, no itemType
        "title": "...", "summary": "...",
    }]
    r = await c.post(
        "/api/devices/ingest", headers=_ingest_headers(device_id, dtoken),
        json=_wrap(device_id, items),
    )
    assert r.status_code == 200, r.text
    res = r.json()["results"][0]
    assert res["status"] == "rejected"


@pytest.mark.asyncio
async def test_cross_device_dispatch_is_rejected(device):
    """V3 MVP doesn't support fan-out; items with `source` pointing at
    a different device must surface as rejected, not silently dropped."""
    c, device_id, dtoken = device
    items = [{
        "id": "wrong-device", "kind": "moment",
        "title": "Cross-device", "summary": "should reject",
        "source": "device:other-device-elsewhere",
    }]
    r = await c.post(
        "/api/devices/ingest", headers=_ingest_headers(device_id, dtoken),
        json=_wrap(device_id, items),
    )
    assert r.status_code == 200, r.text
    assert r.json()["results"][0]["status"] == "rejected"


@pytest.mark.asyncio
async def test_unsupported_full_sync_is_rejected(device):
    """Health full-sync with ambiguous local_date (multi-date payload, no
    payload.local_date pin) can't be safely scoped — surface rejected
    so outbox drops, not retries."""
    c, device_id, dtoken = device
    items = [{
        "id": "ambiguous-full-sync",
        "kind": "health.observation",
        "sync_mode": "full",
        "title": "Ambiguous", "summary": "Multi-date payload",
        "payload": {
            "observations": [
                {"observation_type": "daily_summary", "metric": "steps",
                 "value": 1000, "local_date": "2026-05-04"},
                {"observation_type": "daily_summary", "metric": "steps",
                 "value": 2000, "local_date": "2026-05-05"},
            ],
        },
    }]
    r = await c.post(
        "/api/devices/ingest", headers=_ingest_headers(device_id, dtoken),
        json=_wrap(device_id, items),
    )
    assert r.status_code == 200, r.text
    res = r.json()["results"][0]
    assert res["status"] == "rejected"
    assert "full_sync" in res["reason"] or "unsupported" in res["reason"]


@pytest.mark.asyncio
async def test_retryable_failed_on_server_side_write_exception(device, monkeypatch):
    """Fault-injection: make the raw repo blow up. Status MUST be
    retryable_failed — NOT rejected — so the outbox keeps the item for
    later retry (reviewer's high-priority invariant)."""
    from pinai_agents.web.db.repositories import raw_device as raw_device_mod

    async def _boom(self, **_):
        msg = "synthetic db failure"
        raise RuntimeError(msg)

    monkeypatch.setattr(raw_device_mod.RawDeviceRepository, "ingest_health", _boom)
    monkeypatch.setattr(raw_device_mod.RawDeviceRepository, "replace_health", _boom)

    c, device_id, dtoken = device
    items = [{
        "id": "retryable-1", "kind": "health.observation",
        "title": "Steps", "summary": "8120",
        "payload": {
            "schema_version": "health_observation.v1",
            "local_date": "2026-05-05",
            "observations": [{
                "observation_type": "daily_summary",
                "metric": "steps", "value": 8120, "unit": "count",
                "local_date": "2026-05-05",
            }],
        },
    }]
    r = await c.post(
        "/api/devices/ingest", headers=_ingest_headers(device_id, dtoken),
        json=_wrap(device_id, items),
    )
    assert r.status_code == 200, r.text
    res = r.json()["results"][0]
    assert res["status"] == "retryable_failed", res
    assert "synthetic db failure" in (res.get("reason") or "")


# ── D-1: health metric-scoped full replace + reference_count protection ──


@pytest.mark.asyncio
async def test_health_observation_v1_lands_all_metrics_raw(device, pool):
    """v1 envelope with steps + heart_rate + sleep — all three land in
    pai_raw_device_health_observations; nothing in pai_personal_signals
    (raw_only policy)."""
    c, device_id, dtoken = device
    item = {
        "id": "ios-health-2026-05-05",
        "kind": "health.observation",
        "sync_mode": "full",
        "title": "Health 2026-05-05", "summary": "3 metrics",
        "occurred_at": "2026-05-05T16:00:00Z",
        "payload": {
            "schema_version": "health_observation.v1",
            "local_date": "2026-05-05",
            "observations": [
                {"observation_type": "daily_summary", "metric": "steps",
                 "value": 8120, "unit": "count",
                 "local_date": "2026-05-05", "source_app": "healthkit",
                 "dedupe_key": "ios:health:steps:2026-05-05"},
                {"observation_type": "sample", "metric": "heart_rate",
                 "value": 72, "unit": "bpm",
                 "local_date": "2026-05-05", "source_app": "healthkit",
                 "dedupe_key": "ios:health:hr:2026-05-05T08"},
                {"observation_type": "session", "metric": "sleep",
                 "value": 432, "unit": "minute",
                 "local_date": "2026-05-05", "source_app": "healthkit",
                 "dedupe_key": "ios:health:sleep:2026-05-05"},
            ],
        },
    }
    r = await c.post(
        "/api/devices/ingest", headers=_ingest_headers(device_id, dtoken),
        json=_wrap(device_id, [item]),
    )
    assert r.status_code == 200, r.text
    assert r.json()["results"][0]["status"] == "inserted"

    async with pool.connection() as conn:
        cur = await conn.execute(
            """SELECT metric, value, unit FROM pai_raw_device_health_observations
               WHERE device_id = %s ORDER BY metric""",
            (device_id,),
        )
        rows = await cur.fetchall()
    assert len(rows) == 3
    by_metric = {r["metric"]: r for r in rows}
    assert set(by_metric) == {"heart_rate", "sleep", "steps"}
    assert by_metric["steps"]["value"] == 8120


@pytest.mark.asyncio
async def test_health_metric_scope_preserves_siblings(device, pool):
    """A steps-only full-sync must not wipe a heart_rate row for the
    same local_date. This is the V2 089e1f94 high-priority bug fix."""
    c, device_id, dtoken = device

    # Seed steps + heart_rate (incremental, two items so the parser
    # sees each as single-metric).
    seed = await c.post(
        "/api/devices/ingest", headers=_ingest_headers(device_id, dtoken),
        json=_wrap(device_id, [
            {"id": "seed-steps", "kind": "health.observation",
             "sync_mode": "incremental",
             "title": "Seed steps", "summary": "1000",
             "payload": {
                "schema_version": "health_observation.v1",
                "local_date": "2026-05-05", "metric": "steps",
                "observations": [{
                    "observation_type": "daily_summary",
                    "metric": "steps", "value": 1000, "unit": "count",
                    "local_date": "2026-05-05",
                    "dedupe_key": "ios:health:steps:seed",
                }],
             }},
            {"id": "seed-hr", "kind": "health.observation",
             "sync_mode": "incremental",
             "title": "Seed hr", "summary": "70",
             "payload": {
                "schema_version": "health_observation.v1",
                "local_date": "2026-05-05", "metric": "heart_rate",
                "observations": [{
                    "observation_type": "sample",
                    "metric": "heart_rate", "value": 70, "unit": "bpm",
                    "local_date": "2026-05-05",
                    "dedupe_key": "ios:health:hr:seed",
                }],
             }},
        ]),
    )
    assert seed.status_code == 200, seed.text

    # Replace steps for the same local_date with a fresh value.
    replace = await c.post(
        "/api/devices/ingest", headers=_ingest_headers(device_id, dtoken),
        json=_wrap(device_id, [{
            "id": "replace-steps", "kind": "health.observation",
            "sync_mode": "full",
            "title": "Replace steps", "summary": "8120",
            "payload": {
                "schema_version": "health_observation.v1",
                "local_date": "2026-05-05", "metric": "steps",
                "observations": [{
                    "observation_type": "daily_summary",
                    "metric": "steps", "value": 8120, "unit": "count",
                    "local_date": "2026-05-05",
                    "dedupe_key": "ios:health:steps:fresh",
                }],
            },
        }]),
    )
    assert replace.status_code == 200, replace.text

    async with pool.connection() as conn:
        cur = await conn.execute(
            """SELECT metric, value FROM pai_raw_device_health_observations
               WHERE device_id = %s ORDER BY metric""",
            (device_id,),
        )
        rows = await cur.fetchall()
    by_metric = {r["metric"]: r["value"] for r in rows}
    assert "heart_rate" in by_metric, "sibling heart_rate row was wiped"
    assert by_metric["heart_rate"] == 70.0
    assert by_metric["steps"] == 8120.0


# ── D-4: unified timeline endpoint ──


@pytest.mark.asyncio
async def test_timeline_empty_for_new_device(client, pool):
    """A freshly-registered device with no ingest yet — timeline returns
    an empty page and ``has_more=False``."""
    c, mk_jwt = client
    sub = str(uuid.uuid4())
    token = mk_jwt(sub)
    device_id = f"empty-dev-{uuid.uuid4().hex[:8]}"
    await _register_device(c, token, device_id)

    r = await c.get(
        f"/api/devices/{device_id}/timeline",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True
    assert body["items"] == []
    assert body["has_more"] is False
    assert body["next_cursor"] is None

    await _cleanup_user(pool, sub)


@pytest.mark.asyncio
async def test_timeline_interleaves_signal_and_health_by_occurred_at(client, pool):
    """Mint health + signal items with known occurred_at, verify they
    come back in occurred_at DESC order with correct ``type`` tags."""
    c, mk_jwt = client
    sub = str(uuid.uuid4())
    token = mk_jwt(sub)
    device_id = f"tl-mix-{uuid.uuid4().hex[:8]}"
    dtoken = await _register_device(c, token, device_id)

    # 3 events at distinct timestamps — 2 health, 1 signal, interleaved.
    items = [
        {"id": "tl-moment-1", "kind": "moment",
         "title": "Lunch", "summary": "Pho",
         "occurred_at": "2026-05-05T12:00:00Z"},
        {"id": "tl-hlt-1", "kind": "health.observation",
         "title": "steps", "summary": "5000",
         "occurred_at": "2026-05-05T10:00:00Z",
         "payload": {
            "schema_version": "health_observation.v1",
            "local_date": "2026-05-05",
            "observations": [{
                "observation_type": "daily_summary",
                "metric": "steps", "value": 5000,
                "local_date": "2026-05-05",
                "dedupe_key": "ios:health:steps:tl-1",
            }],
         }},
        {"id": "tl-hlt-2", "kind": "health.observation",
         "title": "steps", "summary": "8120",
         "occurred_at": "2026-05-05T16:00:00Z",
         "payload": {
            "schema_version": "health_observation.v1",
            "local_date": "2026-05-05",
            "observations": [{
                "observation_type": "daily_summary",
                "metric": "steps", "value": 8120,
                "local_date": "2026-05-05",
                "dedupe_key": "ios:health:steps:tl-2",
            }],
         }},
    ]
    r_ingest = await c.post(
        "/api/devices/ingest", headers=_ingest_headers(device_id, dtoken),
        json=_wrap(device_id, items),
    )
    assert r_ingest.status_code == 200, r_ingest.text

    r = await c.get(
        f"/api/devices/{device_id}/timeline",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    timeline = body["items"]
    types_in_order = [t["type"] for t in timeline]
    occurred = [t["occurred_at"] for t in timeline]
    # Newest first: health@16:00, signal@12:00, health@10:00
    assert types_in_order == ["health", "signal", "health"], types_in_order
    assert occurred == sorted(occurred, reverse=True)

    await _cleanup_user(pool, sub)


@pytest.mark.asyncio
async def test_timeline_cursor_paginates_in_descending_order(client, pool):
    """Insert N+1 events, fetch with limit=N, verify next_cursor returns
    the last older item on the second call."""
    c, mk_jwt = client
    sub = str(uuid.uuid4())
    token = mk_jwt(sub)
    device_id = f"tl-cur-{uuid.uuid4().hex[:8]}"
    dtoken = await _register_device(c, token, device_id)

    items = [
        {"id": f"tl-m-{i}", "kind": "moment",
         "title": f"M{i}", "summary": f"event {i}",
         "occurred_at": f"2026-05-05T{i:02d}:00:00Z"}
        for i in range(5)
    ]
    r_ingest = await c.post(
        "/api/devices/ingest", headers=_ingest_headers(device_id, dtoken),
        json=_wrap(device_id, items),
    )
    assert r_ingest.status_code == 200, r_ingest.text

    page1 = await c.get(
        f"/api/devices/{device_id}/timeline",
        headers={"Authorization": f"Bearer {token}"},
        params={"limit": 3},
    )
    assert page1.status_code == 200
    p1 = page1.json()
    assert len(p1["items"]) == 3
    assert p1["has_more"] is True
    assert p1["next_cursor"] is not None

    page2 = await c.get(
        f"/api/devices/{device_id}/timeline",
        headers={"Authorization": f"Bearer {token}"},
        params={"limit": 3, "before": p1["next_cursor"]},
    )
    assert page2.status_code == 200
    p2 = page2.json()
    assert len(p2["items"]) == 2
    assert p2["has_more"] is False

    await _cleanup_user(pool, sub)


@pytest.mark.asyncio
async def test_health_replace_preserves_reference_count_rows(device, pool):
    """Rows with reference_count > 0 are immutable raw evidence — a
    full-sync DELETE must skip them."""
    c, device_id, dtoken = device

    seed = await c.post(
        "/api/devices/ingest", headers=_ingest_headers(device_id, dtoken),
        json=_wrap(device_id, [{
            "id": "seed-steps-ref", "kind": "health.observation",
            "sync_mode": "incremental",
            "title": "Seed steps", "summary": "1000",
            "payload": {
                "schema_version": "health_observation.v1",
                "local_date": "2026-05-05", "metric": "steps",
                "observations": [{
                    "observation_type": "daily_summary",
                    "metric": "steps", "value": 1000, "unit": "count",
                    "local_date": "2026-05-05",
                    "dedupe_key": "ios:health:steps:refseed",
                }],
            },
        }]),
    )
    assert seed.status_code == 200

    # Simulate downstream memory/run pinning this row.
    async with pool.connection() as conn, conn.transaction():
        await conn.execute(
            """UPDATE pai_raw_device_health_observations
               SET reference_count = 1, last_referenced_at = NOW()
               WHERE device_id = %s AND metric = 'steps'""",
            (device_id,),
        )

    # Full-sync replace — pinned row must survive.
    replace = await c.post(
        "/api/devices/ingest", headers=_ingest_headers(device_id, dtoken),
        json=_wrap(device_id, [{
            "id": "replace-steps-ref", "kind": "health.observation",
            "sync_mode": "full",
            "title": "Replace steps", "summary": "8120",
            "payload": {
                "schema_version": "health_observation.v1",
                "local_date": "2026-05-05", "metric": "steps",
                "observations": [{
                    "observation_type": "daily_summary",
                    "metric": "steps", "value": 8120, "unit": "count",
                    "local_date": "2026-05-05",
                    "dedupe_key": "ios:health:steps:reffresh",
                }],
            },
        }]),
    )
    assert replace.status_code == 200, replace.text

    async with pool.connection() as conn:
        cur = await conn.execute(
            """SELECT value, reference_count
               FROM pai_raw_device_health_observations
               WHERE device_id = %s AND metric = 'steps'
               ORDER BY value""",
            (device_id,),
        )
        rows: list[dict[str, Any]] = await cur.fetchall()
    # Both rows present: the pinned 1000 and the new 8120.
    values = sorted(float(r["value"]) for r in rows)
    assert values == [1000.0, 8120.0], (
        "pinned row must survive full-sync replace"
    )
