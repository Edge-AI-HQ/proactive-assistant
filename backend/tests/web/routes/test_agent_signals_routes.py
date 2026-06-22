"""Agent signals route regressions.

`hours=N` must mean the past N hours. A missing upper bound once let
future calendar-derived signals occupy the whole recent page, so the
generator could miss fresh ambient voice summaries and return zero cards.
"""

from __future__ import annotations

import base64
from datetime import UTC, datetime, timedelta

import httpx
import pytest
import pytest_asyncio
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from pinai_api.app import create_app
from pinai_api.domains.connector.apps import raw_agent as agent_raw
from pinai_api.domains.user_model.personal_signals import (
    IngestSignalInput,
    PersonalSignalsRepository,
)
from pinai_api.platform.auth.agent_jwt import sign_agent_run_jwt
from pinai_db.rls import service_tx, user_scoped_tx


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


@pytest.mark.asyncio
async def test_kinds_route_lists_distinct_kinds_for_caller(client, pool, user_ids):
    user_a, user_b = user_ids
    now = datetime.now(UTC)
    async with user_scoped_tx(pool, user_a) as conn:
        repo = PersonalSignalsRepository(user_a, conn)
        await repo.ingest_one(
            IngestSignalInput(
                id="sig_kinds_gmail_1",
                kind="gmail.message",
                title="g1",
                summary="g1 body",
                occurred_at=now - timedelta(minutes=15),
                source="test",
            )
        )
        await repo.ingest_one(
            IngestSignalInput(
                id="sig_kinds_gmail_2",
                kind="gmail.message",
                title="g2",
                summary="g2 body",
                occurred_at=now - timedelta(minutes=5),
                source="test",
            )
        )
        await repo.ingest_one(
            IngestSignalInput(
                id="sig_kinds_ambient",
                kind="ambient.candidate_window",
                title="ambient win",
                summary="transcript preview",
                occurred_at=now - timedelta(hours=1),
                source="device",
            )
        )

    async with user_scoped_tx(pool, user_b) as conn:
        repo_b = PersonalSignalsRepository(user_b, conn)
        await repo_b.ingest_one(
            IngestSignalInput(
                id="sig_kinds_other_user",
                kind="other.kind",
                title="leak",
                summary="should not appear for user_a",
                occurred_at=now,
                source="test",
            )
        )

    r = await client.get(
        "/api/agent/signals/kinds",
        headers=_auth(user_a),
    )
    assert r.status_code == 200, r.text
    items = r.json()["items"]
    by_kind = {it["kind"]: it for it in items}
    assert set(by_kind.keys()) == {"gmail.message", "ambient.candidate_window"}
    assert by_kind["gmail.message"]["count"] == 2
    assert by_kind["gmail.message"]["latestTitle"] == "g2"
    # Ordering: gmail (5min) is more recent than ambient (1h).
    assert items[0]["kind"] == "gmail.message"


@pytest.mark.asyncio
async def test_recent_hours_excludes_future_signals(client, pool, user_ids):
    user_a, _ = user_ids
    now = datetime.now(UTC)
    async with user_scoped_tx(pool, user_a) as conn:
        repo = PersonalSignalsRepository(user_a, conn)
        await repo.ingest_one(
            IngestSignalInput(
                id="sig_future_home",
                kind="connector.gcal.event",
                title="Future Home",
                summary="Future calendar event should not fill recent page",
                occurred_at=now + timedelta(days=30),
                source="test",
            )
        )
        await repo.ingest_one(
            IngestSignalInput(
                id="sig_voice_recent",
                kind="session_summary",
                title="Voice summary",
                summary="User explicitly said they are interested in testing cards",
                occurred_at=now - timedelta(minutes=5),
                salience=0.7,
                source="test",
            )
        )

    r = await client.get(
        "/api/agent/signals/recent?hours=24&limit=30",
        headers=_auth(user_a),
    )
    assert r.status_code == 200, r.text
    ids = [item["id"] for item in r.json()["items"]]
    assert "sig_voice_recent" in ids
    assert "sig_future_home" not in ids


@pytest.mark.asyncio
async def test_recent_accepts_daily_dream_full_context_limit(client, pool, user_ids):
    user_a, _ = user_ids
    now = datetime.now(UTC)
    async with user_scoped_tx(pool, user_a) as conn:
        repo = PersonalSignalsRepository(user_a, conn)
        await repo.ingest_one(
            IngestSignalInput(
                id="sig_daily_dream_limit",
                kind="ambient.candidate_window",
                title="Daily dream context",
                summary="This row proves the 10000 limit is accepted.",
                payload={"transcript": "Full transcript text should be available."},
                occurred_at=now - timedelta(minutes=5),
                salience=0.7,
                source="test",
            )
        )

    r = await client.get(
        "/api/agent/signals/recent?status=all&hours=24&limit=10000&includePayload=true",
        headers=_auth(user_a),
    )
    assert r.status_code == 200, r.text
    items = {item["id"]: item for item in r.json()["items"]}
    assert "sig_daily_dream_limit" in items
    assert items["sig_daily_dream_limit"]["payload"]["transcript"] == (
        "Full transcript text should be available."
    )


@pytest.mark.asyncio
async def test_recent_surfaces_ambient_speaker_preview_without_full_payload(client, pool, user_ids):
    user_a, _ = user_ids
    now = datetime.now(UTC)
    async with user_scoped_tx(pool, user_a) as conn:
        repo = PersonalSignalsRepository(user_a, conn)
        await repo.ingest_one(
            IngestSignalInput(
                id="sig_ambient_speakers",
                kind="ambient.candidate_window",
                title="Ambient transcript_session window",
                summary='speaker_1: "we should order lunch"',
                payload={
                    "speaker_text": 'speaker_1: "we should order lunch"\nself: "I need to finish the review first"',
                    "self_text": "I need to finish the review first",
                    "speaker_segments": [
                        {"speaker": "speaker_1", "text": "we should order lunch"},
                        {"speaker": "self", "text": "I need to finish the review first"},
                    ],
                },
                occurred_at=now - timedelta(minutes=5),
                salience=0.7,
                source="device",
            )
        )

    r = await client.get(
        "/api/agent/signals/recent?hours=24&kind=ambient.candidate_window",
        headers=_auth(user_a),
    )

    assert r.status_code == 200, r.text
    item = r.json()["items"][0]
    assert "payload" not in item
    assert item["selfText"] == "I need to finish the review first"
    assert item["speakerText"] == (
        'speaker_1: "we should order lunch"\nself: "I need to finish the review first"'
    )


@pytest.mark.asyncio
async def test_agent_raw_reports_missing_connector(client, monkeypatch, user_ids):
    user_a, _ = user_ids

    async def fake_list_connections(_user):
        return []

    monkeypatch.setattr(agent_raw.cs, "list_connections", fake_list_connections)

    r = await client.get(
        "/api/agent/raw/gmail/messages?limit=10000",
        headers=_auth(user_a),
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["items"] == []
    assert body["connectionRequired"] is True
    assert body["connectorToolkit"] == "gmail"
    assert body["nextTool"] == "COMPOSIO_MANAGE_CONNECTIONS"


@pytest.mark.asyncio
async def test_agent_raw_connector_status_error_is_unknown(monkeypatch):
    async def fake_load_user_by_id(_pool, _user_id):
        return object()

    async def fake_list_connections(_user):
        raise agent_raw.cs.ComposioError(502, "upstream unavailable")

    monkeypatch.setattr(agent_raw, "load_user_by_id", fake_load_user_by_id)
    monkeypatch.setattr(agent_raw.cs, "list_connections", fake_list_connections)

    status = await agent_raw._active_connector_toolkit(object(), 123, "gmail")

    assert status is None


@pytest.mark.asyncio
async def test_agent_raw_reads_cache_when_connector_status_is_unavailable(
    client,
    pool,
    monkeypatch,
    user_ids,
):
    user_a, _ = user_ids
    now = datetime.now(UTC)
    async with user_scoped_tx(pool, user_a) as conn:
        await conn.execute(
            """
            INSERT INTO pai_raw_gmail_messages
              (user_id, id, message_id, subject, occurred_at)
            VALUES
              (%s, 'raw_gmail_cached_on_status_error', 'msg_cached', 'Cached', %s)
            """,
            (user_a, now),
        )

    async def fake_list_connections(_user):
        raise agent_raw.cs.ComposioError(502, "upstream unavailable")

    monkeypatch.setattr(agent_raw.cs, "list_connections", fake_list_connections)

    r = await client.get(
        "/api/agent/raw/gmail/messages?limit=10",
        headers=_auth(user_a),
    )

    assert r.status_code == 200, r.text
    body = r.json()
    assert "connectionRequired" not in body
    assert [item["id"] for item in body["items"]] == ["raw_gmail_cached_on_status_error"]


@pytest.mark.asyncio
async def test_agent_raw_supports_offset_pagination(client, pool, monkeypatch, user_ids):
    user_a, _ = user_ids

    async def fake_list_connections(_user):
        return [
            agent_raw.cs.Connection(
                toolkit="gmail",
                status="ACTIVE",
                connected_account_id="cid_gmail",
            )
        ]

    monkeypatch.setattr(agent_raw.cs, "list_connections", fake_list_connections)

    now = datetime.now(UTC)
    async with user_scoped_tx(pool, user_a) as conn:
        await conn.execute(
            """
            INSERT INTO pai_raw_gmail_messages
              (user_id, id, message_id, subject, occurred_at)
            VALUES
              (%s, 'raw_gmail_offset_0', 'msg_offset_0', 'Newest', %s),
              (%s, 'raw_gmail_offset_1', 'msg_offset_1', 'Middle', %s),
              (%s, 'raw_gmail_offset_2', 'msg_offset_2', 'Oldest', %s)
            """,
            (
                user_a,
                now,
                user_a,
                now - timedelta(minutes=1),
                user_a,
                now - timedelta(minutes=2),
            ),
        )

    r = await client.get(
        "/api/agent/raw/gmail/messages?limit=1&offset=1",
        headers=_auth(user_a),
    )

    assert r.status_code == 200, r.text
    body = r.json()
    assert [item["id"] for item in body["items"]] == ["raw_gmail_offset_1"]
    assert body["offset"] == 1
    assert body["limit"] == 1


@pytest.mark.asyncio
async def test_agent_signals_support_since_until_offset_pagination(client, pool, user_ids):
    user_a, _ = user_ids
    now = datetime.now(UTC)
    async with user_scoped_tx(pool, user_a) as conn:
        repo = PersonalSignalsRepository(user_a, conn)
        for idx in range(3):
            await repo.ingest_one(
                IngestSignalInput(
                    id=f"sig_context_page_{idx}",
                    kind="context.test",
                    title=f"context {idx}",
                    summary=f"context summary {idx}",
                    occurred_at=now - timedelta(minutes=idx),
                    salience=0.7,
                    source="test",
                )
            )

    r = await client.get(
        "/api/agent/signals/recent",
        params={
            "status": "all",
            "since": (now - timedelta(hours=1)).isoformat(),
            "until": (now + timedelta(seconds=1)).isoformat(),
            "limit": 1,
            "offset": 1,
        },
        headers=_auth(user_a),
    )

    assert r.status_code == 200, r.text
    body = r.json()
    assert [item["id"] for item in body["items"]] == ["sig_context_page_1"]
    assert body["offset"] == 1
    assert body["limit"] == 1
    assert body["total"] >= 3


@pytest.mark.asyncio
async def test_agent_world_supports_since_until_window(client, pool, user_ids):
    user_a, _ = user_ids
    now = datetime.now(UTC)
    old_id = f"world_window_old_{user_a}"
    future_id = f"world_window_future_{user_a}"
    async with service_tx(pool) as conn:
        await conn.execute(
            """
            INSERT INTO pai_world_signals
              (id, provider, title, url, normalized_url, published_at)
            VALUES
              (%s, 'test', 'Old but in previous cycle', %s, %s, %s),
              (%s, 'test', 'Future outside window', %s, %s, %s)
            """,
            (
                old_id,
                f"https://example.com/world-window-old-{user_a}",
                f"https://example.com/world-window-old-{user_a}",
                now - timedelta(hours=30),
                future_id,
                f"https://example.com/world-window-future-{user_a}",
                f"https://example.com/world-window-future-{user_a}",
                now + timedelta(hours=2),
            ),
        )
    async with user_scoped_tx(pool, user_a) as conn:
        await conn.execute(
            """
            INSERT INTO pai_world_signal_user_view
              (user_id, world_signal_id, salience, status)
            VALUES
              (%s, %s, 0.5, 'open'),
              (%s, %s, 0.9, 'open')
            """,
            (user_a, old_id, user_a, future_id),
        )

    r = await client.get(
        "/api/agent/world/recent",
        params={
            "status": "open",
            "since": (now - timedelta(hours=36)).isoformat(),
            "until": now.isoformat(),
            "limit": 10,
        },
        headers=_auth(user_a),
    )

    assert r.status_code == 200, r.text
    ids = [item["id"] for item in r.json()["items"]]
    assert old_id in ids
    assert future_id not in ids
