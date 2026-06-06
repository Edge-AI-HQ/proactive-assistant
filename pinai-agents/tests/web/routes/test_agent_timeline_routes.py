"""Agent timeline route integration tests.

Covers the HTTP surface used by `client.timeline.*`:
  * /query — window scan + filters
  * /in_progress — interval events covering `at`
  * /get/{id} + /history/{id} — drill-down + supersede chain
  * /ingest — write path
  * /supersede — reschedule chain
  * /reference — reference_count bump
"""

from __future__ import annotations

import base64
from datetime import UTC, datetime, timedelta

import httpx
import pytest
import pytest_asyncio
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from pinai_agents.web.app import create_app
from pinai_agents.web.auth.agent_jwt import sign_agent_run_jwt
from pinai_agents.web.db.repositories.timeline import (
    IngestTimelineEvent,
    TimelineEventRow,
    TimelineRepository,
)
from pinai_agents.web.db.rls import user_scoped_tx
from pinai_agents.web.routes.agent.timeline import _serialize


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
    from pinai_agents import config

    config.get_web_settings.cache_clear()
    config.get_chat_settings.cache_clear()
    yield
    config.get_web_settings.cache_clear()
    config.get_chat_settings.cache_clear()


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


def _auth(user_id: int) -> dict[str, str]:
    token, _ = sign_agent_run_jwt(user_id=user_id, virtual_key=None)
    return {"Authorization": f"Bearer {token}"}


def _iso(dt: datetime) -> str:
    return dt.isoformat()


# ── /query ────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_query_returns_events_in_window(client, pool, user_ids):
    user_a, _ = user_ids
    now = datetime.now(UTC)
    async with user_scoped_tx(pool, user_a) as conn:
        repo = TimelineRepository(user_a, conn)
        await repo.upsert_event(
            IngestTimelineEvent(
                id="tle_q1",
                occurred_at=now - timedelta(hours=2),
                source="gmail",
                event_type="communication",
                title="From boss",
                source_ref={"raw_table": "x", "raw_id": "1"},
            )
        )
        await repo.upsert_event(
            IngestTimelineEvent(
                id="tle_q2",
                occurred_at=now - timedelta(hours=20),  # outside the window
                source="gmail",
                event_type="communication",
                title="Way old",
                source_ref={"raw_table": "x", "raw_id": "2"},
            )
        )

    resp = await client.get(
        "/api/agent/timeline/query",
        params={
            "windowStart": _iso(now - timedelta(hours=6)),
            "windowEnd": _iso(now + timedelta(hours=1)),
        },
        headers=_auth(user_a),
    )
    assert resp.status_code == 200, resp.text
    items = resp.json()["items"]
    titles = [item["title"] for item in items]
    assert titles == ["From boss"]
    # camelCase fields
    assert "occurredAt" in items[0]
    assert "eventType" in items[0]


@pytest.mark.asyncio
async def test_query_rejects_invalid_window(client, user_ids):
    user_a, _ = user_ids
    now = datetime.now(UTC)
    # window_end <= window_start
    resp = await client.get(
        "/api/agent/timeline/query",
        params={
            "windowStart": _iso(now),
            "windowEnd": _iso(now - timedelta(hours=1)),
        },
        headers=_auth(user_a),
    )
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_query_filters_by_source_param(client, pool, user_ids):
    user_a, _ = user_ids
    now = datetime.now(UTC)
    async with user_scoped_tx(pool, user_a) as conn:
        repo = TimelineRepository(user_a, conn)
        await repo.upsert_event(
            IngestTimelineEvent(
                id="tle_s1",
                occurred_at=now - timedelta(hours=1),
                source="gmail",
                event_type="communication",
                title="mail",
                source_ref={"raw_table": "x", "raw_id": "1"},
            )
        )
        await repo.upsert_event(
            IngestTimelineEvent(
                id="tle_s2",
                occurred_at=now - timedelta(hours=1),
                source="gcal",
                event_type="meeting",
                title="meet",
                source_ref={"raw_table": "x", "raw_id": "2"},
            )
        )

    resp = await client.get(
        "/api/agent/timeline/query",
        params={
            "windowStart": _iso(now - timedelta(hours=6)),
            "windowEnd": _iso(now + timedelta(hours=1)),
            "sources": "gmail",
        },
        headers=_auth(user_a),
    )
    assert resp.status_code == 200
    assert [i["title"] for i in resp.json()["items"]] == ["mail"]


# ── /in_progress ──────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_in_progress_returns_active_meeting(client, pool, user_ids):
    user_a, _ = user_ids
    now = datetime.now(UTC)
    async with user_scoped_tx(pool, user_a) as conn:
        repo = TimelineRepository(user_a, conn)
        await repo.upsert_event(
            IngestTimelineEvent(
                id="tle_ip1",
                occurred_at=now - timedelta(minutes=15),
                end_at=now + timedelta(minutes=45),
                source="gcal",
                event_type="meeting",
                title="standup",
                source_ref={"raw_table": "x", "raw_id": "1"},
            )
        )

    resp = await client.get(
        "/api/agent/timeline/in_progress",
        headers=_auth(user_a),
    )
    assert resp.status_code == 200
    titles = [i["title"] for i in resp.json()["items"]]
    assert "standup" in titles


# ── /get + /history ───────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_get_event_returns_full_body(client, pool, user_ids):
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        await TimelineRepository(user_a, conn).upsert_event(
            IngestTimelineEvent(
                id="tle_get_test",
                occurred_at=datetime.now(UTC),
                source="ambient.utterance",
                event_type="utterance",
                title="i said hello",
                body="i said hello world this is the full transcript",
                source_ref={"device_id": "d1", "client_event_id": "u1"},
                metadata={"asr_confidence": 0.95, "language": "en"},
            )
        )

    resp = await client.get(
        "/api/agent/timeline/get/tle_get_test",
        headers=_auth(user_a),
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["title"] == "i said hello"
    assert data["body"] == "i said hello world this is the full transcript"
    assert data["metadata"]["asr_confidence"] == 0.95
    assert data["sourceRef"]["device_id"] == "d1"


@pytest.mark.asyncio
async def test_get_missing_event_returns_404(client, user_ids):
    user_a, _ = user_ids
    resp = await client.get(
        "/api/agent/timeline/get/tle_does_not_exist",
        headers=_auth(user_a),
    )
    assert resp.status_code == 404


# ── /ingest ──────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_ingest_creates_event(client, user_ids):
    user_a, _ = user_ids
    now = datetime.now(UTC)
    resp = await client.post(
        "/api/agent/timeline/ingest",
        json={
            "occurredAt": _iso(now),
            "source": "gmail",
            "eventType": "communication",
            "title": "test ingest",
            "sourceRef": {"raw_table": "pai_raw_gmail_messages", "raw_id": "m1"},
            "importance": 0.6,
            "dedupeKey": "gmail:test_ingest_1",
        },
        headers=_auth(user_a),
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["title"] == "test ingest"
    assert body["source"] == "gmail"
    assert body["importance"] == pytest.approx(0.6)
    assert body["curationStatus"] == "curated"


@pytest.mark.asyncio
async def test_ingest_validates_required_fields(client, user_ids):
    user_a, _ = user_ids
    resp = await client.post(
        "/api/agent/timeline/ingest",
        json={"title": "missing occurredAt and source"},
        headers=_auth(user_a),
    )
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_ingest_is_idempotent_by_dedupe_key(client, user_ids):
    user_a, _ = user_ids
    now = datetime.now(UTC)
    body = {
        "occurredAt": _iso(now),
        "source": "gmail",
        "eventType": "communication",
        "title": "v1",
        "sourceRef": {"raw_table": "x", "raw_id": "1"},
        "dedupeKey": "gmail:idempotent_test",
    }
    r1 = await client.post(
        "/api/agent/timeline/ingest",
        json=body,
        headers=_auth(user_a),
    )
    body["title"] = "v2"
    r2 = await client.post(
        "/api/agent/timeline/ingest",
        json=body,
        headers=_auth(user_a),
    )
    assert r1.status_code == 200
    assert r2.status_code == 200
    # Query the window — should be just one row with title="v2"
    q = await client.get(
        "/api/agent/timeline/query",
        params={
            "windowStart": _iso(now - timedelta(hours=1)),
            "windowEnd": _iso(now + timedelta(hours=1)),
        },
        headers=_auth(user_a),
    )
    rows = [i for i in q.json()["items"] if i["dedupeKey"] == "gmail:idempotent_test"]
    assert len(rows) == 1
    assert rows[0]["title"] == "v2"


# ── /supersede ───────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_supersede_creates_versioned_chain(client, user_ids):
    user_a, _ = user_ids
    now = datetime.now(UTC)
    # v1 ingest
    r1 = await client.post(
        "/api/agent/timeline/ingest",
        json={
            "id": "tle_super_v1",
            "occurredAt": _iso(now + timedelta(hours=2)),
            "source": "gcal",
            "eventType": "meeting",
            "title": "2pm meeting",
            "sourceRef": {"raw_table": "x", "raw_id": "1"},
            "dedupeKey": "gcal:super_test:v1",
        },
        headers=_auth(user_a),
    )
    assert r1.status_code == 200, r1.text

    # supersede with v2
    r2 = await client.post(
        "/api/agent/timeline/supersede",
        json={
            "oldId": "tle_super_v1",
            "newEvent": {
                "id": "tle_super_v2",
                "occurredAt": _iso(now + timedelta(hours=4)),
                "source": "gcal",
                "eventType": "meeting",
                "title": "4pm meeting (rescheduled)",
                "sourceRef": {"raw_table": "x", "raw_id": "1"},
                "dedupeKey": "gcal:super_test:v2",
            },
            "changedFields": {"occurred_at": {"from": "2pm", "to": "4pm"}},
            "by": "rule",
        },
        headers=_auth(user_a),
    )
    assert r2.status_code == 200, r2.text
    v2 = r2.json()
    assert v2["version"] == 2
    assert v2["supersedesId"] == "tle_super_v1"

    # /history walks chain
    h = await client.get(
        "/api/agent/timeline/history/tle_super_v2",
        headers=_auth(user_a),
    )
    assert h.status_code == 200
    chain_titles = [r["title"] for r in h.json()["items"]]
    assert chain_titles == ["2pm meeting", "4pm meeting (rescheduled)"]


# ── /reference ───────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_reference_bumps_count(client, pool, user_ids):
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        await TimelineRepository(user_a, conn).upsert_event(
            IngestTimelineEvent(
                id="tle_ref_route",
                occurred_at=datetime.now(UTC),
                source="gmail",
                event_type="communication",
                title="x",
                source_ref={"raw_table": "x", "raw_id": "1"},
            )
        )

    resp = await client.post(
        "/api/agent/timeline/reference",
        json={"ids": ["tle_ref_route"], "runId": "run_xyz"},
        headers=_auth(user_a),
    )
    assert resp.status_code == 204

    async with user_scoped_tx(pool, user_a) as conn:
        row = await TimelineRepository(user_a, conn).get("tle_ref_route")
    assert row is not None
    assert row.reference_count == 1


# ─────────────────────────────────────────────────────────────────────
# Speaker attribution preview (no DB — pure serialization).
#
# Ported from the retired signals route: ambient utterances store diarized
# `self_text` / `speaker_segments` in metadata, and `_serialize` surfaces a
# self/other preview inline so an agent reading the list view can weight the
# user's own speech without a per-event drill-down.
# ─────────────────────────────────────────────────────────────────────


def _ambient_row(metadata: dict, *, source: str = "ambient.utterance") -> TimelineEventRow:
    now = datetime.now(UTC)
    return TimelineEventRow.from_record(
        {
            "id": "tle_ambient",
            "occurred_at": now,
            "source": source,
            "event_type": "utterance",
            "title": "lunch chat",
            "metadata": metadata,
            "importance": 0.5,
            "confidence": 0.7,
            "is_predicted": False,
            "curation_status": "pending",
            "version": 1,
            "ingested_at": now,
            "updated_at": now,
            "reference_count": 0,
        }
    )


def test_serialize_surfaces_speaker_preview_only_for_ambient():
    meta = {
        "self_text": "ship it today",
        "speaker_segments": [{"speaker": "self", "text": "ship it today"}],
    }
    ambient = _serialize(_ambient_row(meta))
    assert ambient["selfText"] == "ship it today"
    assert ambient["speakerText"] == 'self: "ship it today"'
    # A non-ambient event with the same metadata keys must NOT leak a preview.
    gmail = _serialize(_ambient_row(meta, source="gmail"))
    assert "selfText" not in gmail
    assert "speakerText" not in gmail
