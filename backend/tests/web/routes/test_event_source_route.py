"""End-to-end: agent JWT → GET /api/agent/events/{id}/source (L0 drill-down).

Locks in the source→table registry (design §三) + supersede-aware resolution:
  * composio event → pai_raw_apps payload comes back verbatim
  * world event → global pai_world_signals row (provider/url/summary)
  * a STALE id (superseded revision) resolves server-side to the current
    revision (resolvedTo + revisionNote) — the chain is never the agent's job
  * tombstone surfaces structured.status ("cancelled") at the top level
  * no-archive events (agent_action) and TTL'd raws degrade to source=null
    with distinct notes (traceability is best-effort by design)

Fixture wiring mirrors test_events_agent_routes.py.
"""

from __future__ import annotations

import base64
import json
from datetime import UTC, datetime

import httpx
import pytest
import pytest_asyncio
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from pinai_api.app import create_app
from pinai_api.domains.memory.events.repository import AppendEventInput, EventsRepository
from pinai_api.platform.auth.agent_jwt import sign_agent_run_jwt
from pinai_db.rls import user_scoped_tx


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
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as c:
        yield c


def _hdrs(user_id: int, run_id: str) -> dict[str, str]:
    token, _ = sign_agent_run_jwt(user_id=user_id, run_id=run_id)
    return {"Authorization": f"Bearer {token}"}


async def _insert_raw_apps(pool, user_id: int, *, raw_id: str, payload: dict) -> None:
    async with user_scoped_tx(pool, user_id) as conn:
        await conn.execute(
            """
            INSERT INTO pai_raw_apps
              (user_id, id, toolkit, entity_type, external_id, occurred_at,
               title, snippet, payload, dedupe_key)
            VALUES (%s, %s, 'gmail', 'messages', %s, now(), 'Quarterly numbers',
                    'short snippet', %s::jsonb, %s)
            """,
            (user_id, raw_id, raw_id, json.dumps(payload), f"gmail:messages:{raw_id}"),
        )


async def _append_event(pool, user_id: int, inp: AppendEventInput):
    async with user_scoped_tx(pool, user_id) as conn:
        return await EventsRepository(user_id, conn).append(inp)


def _evt(id: str, *, source="composio", source_ref=None, supersedes=None, **kw) -> AppendEventInput:
    return AppendEventInput(
        id=id,
        source=source,
        event_type=kw.pop("event_type", "communication"),
        occurred_at=kw.pop("occurred_at", datetime(2026, 7, 1, 10, tzinfo=UTC)),
        dedupe_key=f"src-test:{id}",
        source_ref=source_ref,
        supersedes_id=supersedes,
        title=kw.pop("title", "t"),
        curated=True,
        **kw,
    )


@pytest.mark.asyncio
async def test_composio_event_drills_into_raw_payload(client, pool, user_ids):
    user_a, _ = user_ids
    await _insert_raw_apps(
        pool,
        user_a,
        raw_id="raw_g1",
        payload={"messageText": "full email body here", "from": "d@x.com"},
    )
    await _append_event(pool, user_a, _evt("ev_src_1", source_ref="raw_g1"))

    r = await client.get("/api/agent/events/ev_src_1/source", headers=_hdrs(user_a, "r1"))
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["ok"] is True
    assert "full email body here" in out["source"]
    assert "resolvedTo" not in out  # head id → no revision note


@pytest.mark.asyncio
async def test_stale_id_resolves_to_current_revision(client, pool, user_ids):
    user_a, _ = user_ids
    await _insert_raw_apps(pool, user_a, raw_id="raw_g2", payload={"messageText": "v2 content"})
    await _append_event(pool, user_a, _evt("ev_old", source_ref="raw_g2"))
    await _append_event(
        pool,
        user_a,
        _evt(
            "ev_new",
            source_ref="raw_g2",
            supersedes="ev_old",
            occurred_at=datetime(2026, 7, 2, 14, tzinfo=UTC),
            structured={"status": "cancelled"},
        ),
    )

    # Ask with the STALE id — server walks the chain.
    r = await client.get("/api/agent/events/ev_old/source", headers=_hdrs(user_a, "r2"))
    out = r.json()
    assert out["resolvedTo"] == "ev_new"
    assert "superseded" in out["revisionNote"]
    assert out["status"] == "cancelled"  # tombstone state at a glance
    assert "v2 content" in out["source"]
    assert out["event"]["id"] == "ev_new"


@pytest.mark.asyncio
async def test_no_archive_event_returns_null_source(client, pool, user_ids):
    user_a, _ = user_ids
    await _append_event(pool, user_a, _evt("ev_note", source="agent_action", source_ref=None))

    r = await client.get("/api/agent/events/ev_note/source", headers=_hdrs(user_a, "r3"))
    out = r.json()
    assert out["ok"] is True and out["source"] is None
    assert out["note"] == "no source content available for this event"


@pytest.mark.asyncio
async def test_ttl_deleted_raw_degrades_gracefully(client, pool, user_ids):
    user_a, _ = user_ids
    # Event points at a raw id that (no longer) exists.
    await _append_event(pool, user_a, _evt("ev_ttl", source_ref="raw_gone"))

    r = await client.get("/api/agent/events/ev_ttl/source", headers=_hdrs(user_a, "r4"))
    out = r.json()
    assert out["ok"] is True and out["source"] is None
    assert out["note"] == "source content no longer available"


@pytest.mark.asyncio
async def test_world_event_drills_into_global_row(client, pool, user_ids):
    user_a, _ = user_ids
    async with pool.connection() as conn:  # global table: seed as service role
        await conn.execute(
            """
            INSERT INTO pai_world_signals
              (id, provider, title, url, normalized_url, summary, published_at)
            VALUES ('ws_1', 'google_news', 'Rates cut', 'https://n.example/1',
                    'n.example/1', 'Fed cuts rates by 25bp', now())
            ON CONFLICT (id) DO NOTHING
            """
        )
    await _append_event(
        pool, user_a, _evt("ev_world", source="world", event_type="world_news", source_ref="ws_1")
    )

    r = await client.get("/api/agent/events/ev_world/source", headers=_hdrs(user_a, "r5"))
    out = r.json()
    assert "google_news" in out["source"] and "Fed cuts rates" in out["source"]


@pytest.mark.asyncio
async def test_unknown_event_404s(client, pool, user_ids):
    user_a, _ = user_ids
    r = await client.get("/api/agent/events/ev_nope/source", headers=_hdrs(user_a, "r6"))
    assert r.status_code == 404
