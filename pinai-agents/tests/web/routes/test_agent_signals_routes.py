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

from pinai_agents.web.app import create_app
from pinai_agents.web.auth.agent_jwt import sign_agent_run_jwt
from pinai_agents.web.db.repositories.personal_signals import (
    IngestSignalInput,
    PersonalSignalsRepository,
)
from pinai_agents.web.db.rls import user_scoped_tx


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
        transport=transport, base_url="http://testserver",
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
        await repo.ingest_one(IngestSignalInput(
            id="sig_kinds_gmail_1",
            kind="gmail.message",
            title="g1",
            summary="g1 body",
            occurred_at=now - timedelta(minutes=15),
            source="test",
        ))
        await repo.ingest_one(IngestSignalInput(
            id="sig_kinds_gmail_2",
            kind="gmail.message",
            title="g2",
            summary="g2 body",
            occurred_at=now - timedelta(minutes=5),
            source="test",
        ))
        await repo.ingest_one(IngestSignalInput(
            id="sig_kinds_ambient",
            kind="ambient.candidate_window",
            title="ambient win",
            summary="transcript preview",
            occurred_at=now - timedelta(hours=1),
            source="device",
        ))

    async with user_scoped_tx(pool, user_b) as conn:
        repo_b = PersonalSignalsRepository(user_b, conn)
        await repo_b.ingest_one(IngestSignalInput(
            id="sig_kinds_other_user",
            kind="other.kind",
            title="leak",
            summary="should not appear for user_a",
            occurred_at=now,
            source="test",
        ))

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
        await repo.ingest_one(IngestSignalInput(
            id="sig_future_home",
            kind="connector.gcal.event",
            title="Future Home",
            summary="Future calendar event should not fill recent page",
            occurred_at=now + timedelta(days=30),
            source="test",
        ))
        await repo.ingest_one(IngestSignalInput(
            id="sig_voice_recent",
            kind="session_summary",
            title="Voice summary",
            summary="User explicitly said they are interested in testing cards",
            occurred_at=now - timedelta(minutes=5),
            salience=0.7,
            source="test",
        ))

    r = await client.get(
        "/api/agent/signals/recent?hours=24&limit=30",
        headers=_auth(user_a),
    )
    assert r.status_code == 200, r.text
    ids = [item["id"] for item in r.json()["items"]]
    assert "sig_voice_recent" in ids
    assert "sig_future_home" not in ids
