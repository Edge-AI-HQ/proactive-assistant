from __future__ import annotations

import base64
from datetime import UTC, datetime

import httpx
import pytest
import pytest_asyncio
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from pinai_agents.web.app import create_app
from pinai_agents.web.auth.agent_jwt import sign_agent_run_jwt
from pinai_agents.web.auth.deps import current_user
from pinai_agents.web.auth.user_service import User
from pinai_agents.web.db.repositories.scheduled_tasks import ScheduledTasksRepository
from pinai_agents.web.db.rls import service_tx, user_scoped_tx


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


def _user(user_id: int) -> User:
    return User(
        id=user_id,
        supabase_user_id=f"test-sub-{user_id}",
        email=f"user-{user_id}@test.invalid",
        litellm_virtual_key="sk-test",
        browserbase_context_id=None,
    )


@pytest_asyncio.fixture
async def client(pool, user_ids):
    user_a, _ = user_ids
    app = create_app()
    app.state.pool = pool
    app.dependency_overrides[current_user] = lambda: _user(user_a)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as c:
        yield c


def _agent_auth(user_id: int) -> dict[str, str]:
    token, _ = sign_agent_run_jwt(user_id=user_id, run_id="run_scheduled_generator_test")
    return {"Authorization": f"Bearer {token}"}


def test_scheduled_generator_routes_are_mounted() -> None:
    app = create_app()
    routes = {
        (route.path, method) for route in app.routes for method in getattr(route, "methods", set())
    }

    assert ("/api/scheduled-generators/preview", "POST") in routes
    assert ("/api/scheduled-generators", "GET") in routes
    assert ("/api/scheduled-generators", "POST") in routes
    assert ("/api/scheduled-generators/{task_id}/pause", "POST") in routes
    assert ("/api/scheduled-generators/{task_id}/resume", "POST") in routes
    assert ("/api/scheduled-generators/{task_id}", "DELETE") in routes


@pytest.mark.asyncio
async def test_agent_preview_and_create_write_generator_scheduled_task(client, user_ids, pool):
    user_a, _ = user_ids
    headers = _agent_auth(user_a)

    preview = await client.post(
        "/api/scheduled-generators/preview",
        headers=headers,
        json={
            "originalRequest": "每天 9 点给我推一些 AI 新闻",
            "timezone": "America/Los_Angeles",
        },
    )

    assert preview.status_code == 200, preview.text
    preview_body = preview.json()
    assert preview_body["previewId"].startswith("sgprev_")
    assert preview_body["parsedIntent"]["frequency"] == "daily"
    assert preview_body["parsedIntent"]["localTime"] == "09:00"
    assert preview_body["parsedIntent"]["timezone"] == "America/Los_Angeles"
    assert preview_body["parsedIntent"]["topic"] == "AI 新闻"
    assert preview_body["confirmedBrief"]["topic"] == "AI 新闻"
    assert preview_body["similarTasks"] == []

    created = await client.post(
        "/api/scheduled-generators",
        headers=headers,
        json={
            "previewId": preview_body["previewId"],
            "semanticSignature": preview_body["semanticSignature"],
            "originalRequest": "每天 9 点给我推一些 AI 新闻",
            "parsedIntent": preview_body["parsedIntent"],
            "confirmedBrief": preview_body["confirmedBrief"],
        },
    )

    assert created.status_code == 201, created.text
    created_body = created.json()
    assert created_body["task"]["id"].startswith("sched.gen.")
    assert created_body["task"]["kind"] == "generator.scheduled"
    assert created_body["task"]["status"] == "active"
    assert created_body["task"]["cronExpr"] == "0 9 * * *"
    assert created_body["task"]["timezone"] == "America/Los_Angeles"

    async with service_tx(pool) as conn:
        cur = await conn.execute(
            """
            SELECT kind, trigger_kind, cron_expr, timezone, status, next_run_at, payload
            FROM pai_scheduled_tasks
            WHERE user_id = %s AND id = %s
            """,
            (user_a, created_body["task"]["id"]),
        )
        row = await cur.fetchone()

    assert row is not None
    assert row["kind"] == "generator.scheduled"
    assert row["trigger_kind"] == "schedule"
    assert row["cron_expr"] == "0 9 * * *"
    assert row["timezone"] == "America/Los_Angeles"
    assert row["status"] == "active"
    assert row["next_run_at"] is not None
    assert row["payload"]["preview_id"] == preview_body["previewId"]
    assert row["payload"]["confirmed_brief"]["topic"] == "AI 新闻"
    assert row["payload"]["trigger"] == "scheduled"


@pytest.mark.asyncio
async def test_supabase_override_can_list_pause_resume_and_delete(client):
    preview = await client.post(
        "/api/scheduled-generators/preview",
        json={
            "originalRequest": "每天 9 点给我推一些 AI 新闻",
            "timezone": "America/Los_Angeles",
        },
    )
    assert preview.status_code == 200, preview.text
    preview_body = preview.json()

    created = await client.post(
        "/api/scheduled-generators",
        json={
            "previewId": preview_body["previewId"],
            "semanticSignature": preview_body["semanticSignature"],
            "originalRequest": "每天 9 点给我推一些 AI 新闻",
            "parsedIntent": preview_body["parsedIntent"],
            "confirmedBrief": preview_body["confirmedBrief"],
        },
    )
    assert created.status_code == 201, created.text
    task_id = created.json()["task"]["id"]

    listed = await client.get("/api/scheduled-generators")
    assert listed.status_code == 200, listed.text
    assert [item["id"] for item in listed.json()["items"]] == [task_id]

    paused = await client.post(f"/api/scheduled-generators/{task_id}/pause")
    assert paused.status_code == 200, paused.text
    assert paused.json()["task"]["status"] == "paused"

    resumed = await client.post(f"/api/scheduled-generators/{task_id}/resume")
    assert resumed.status_code == 200, resumed.text
    assert resumed.json()["task"]["status"] == "active"
    assert resumed.json()["task"]["nextRunAt"] is not None

    deleted = await client.delete(f"/api/scheduled-generators/{task_id}")
    assert deleted.status_code == 200, deleted.text
    assert deleted.json()["task"]["status"] == "archived"

    listed = await client.get("/api/scheduled-generators")
    assert listed.status_code == 200, listed.text
    assert listed.json()["items"] == []

    listed_with_archived = await client.get(
        "/api/scheduled-generators",
        params={"includeArchived": "true"},
    )
    assert listed_with_archived.status_code == 200, listed_with_archived.text
    assert listed_with_archived.json()["items"][0]["status"] == "archived"


@pytest.mark.asyncio
async def test_create_is_idempotent_for_same_preview(client, user_ids, pool):
    user_a, _ = user_ids
    headers = _agent_auth(user_a)

    preview = await client.post(
        "/api/scheduled-generators/preview",
        headers=headers,
        json={
            "originalRequest": "每天 9 点给我推一些 AI 新闻",
            "timezone": "America/Los_Angeles",
        },
    )
    assert preview.status_code == 200, preview.text
    preview_body = preview.json()
    body = {
        "previewId": preview_body["previewId"],
        "semanticSignature": preview_body["semanticSignature"],
        "originalRequest": "每天 9 点给我推一些 AI 新闻",
        "parsedIntent": preview_body["parsedIntent"],
        "confirmedBrief": preview_body["confirmedBrief"],
    }

    first = await client.post("/api/scheduled-generators", headers=headers, json=body)
    second = await client.post("/api/scheduled-generators", headers=headers, json=body)

    assert first.status_code == 201, first.text
    assert second.status_code == 200, second.text
    assert first.json()["task"]["id"] == second.json()["task"]["id"]

    async with service_tx(pool) as conn:
        cur = await conn.execute(
            """
            SELECT COUNT(*) AS n
            FROM pai_scheduled_tasks
            WHERE user_id = %s
              AND kind = 'generator.scheduled'
              AND payload->>'preview_id' = %s
            """,
            (user_a, preview_body["previewId"]),
        )
        row = await cur.fetchone()

    assert row["n"] == 1


@pytest.mark.asyncio
async def test_create_requires_ack_when_new_similar_task_exists(client, user_ids, pool):
    user_a, _ = user_ids
    headers = _agent_auth(user_a)

    async with user_scoped_tx(pool, user_a) as conn:
        await ScheduledTasksRepository(user_a, conn).upsert(
            id="sched.gen.existing",
            kind="generator.scheduled",
            trigger_kind="schedule",
            cron_expr="0 9 * * *",
            next_run_at=datetime(2026, 6, 8, 16, 0, tzinfo=UTC),
            timezone="America/Los_Angeles",
            payload={
                "parsed_intent": {
                    "frequency": "daily",
                    "local_time": "09:00",
                    "timezone": "America/Los_Angeles",
                    "topic": "AI 新闻",
                },
                "confirmed_brief": {"topic": "AI 新闻", "title": "AI 新闻卡片"},
                "semantic_signature": "daily|09:00|America/Los_Angeles|ai-news",
            },
        )

    preview = await client.post(
        "/api/scheduled-generators/preview",
        headers=headers,
        json={
            "originalRequest": "每天 9 点给我推一些 AI 新闻",
            "timezone": "America/Los_Angeles",
        },
    )
    assert preview.status_code == 200, preview.text
    preview_body = preview.json()
    assert [item["id"] for item in preview_body["similarTasks"]] == ["sched.gen.existing"]

    create_without_ack = await client.post(
        "/api/scheduled-generators",
        headers=headers,
        json={
            "previewId": preview_body["previewId"],
            "semanticSignature": preview_body["semanticSignature"],
            "originalRequest": "每天 9 点给我推一些 AI 新闻",
            "parsedIntent": preview_body["parsedIntent"],
            "confirmedBrief": preview_body["confirmedBrief"],
        },
    )
    assert create_without_ack.status_code == 409, create_without_ack.text
    assert create_without_ack.json()["requiresConfirmation"] is True
    assert [item["id"] for item in create_without_ack.json()["similarTasks"]] == [
        "sched.gen.existing"
    ]

    create_with_ack = await client.post(
        "/api/scheduled-generators",
        headers=headers,
        json={
            "previewId": preview_body["previewId"],
            "semanticSignature": preview_body["semanticSignature"],
            "originalRequest": "每天 9 点给我推一些 AI 新闻",
            "parsedIntent": preview_body["parsedIntent"],
            "confirmedBrief": preview_body["confirmedBrief"],
            "duplicateAck": True,
            "similarTaskIdsSeen": ["sched.gen.existing"],
        },
    )
    assert create_with_ack.status_code == 201, create_with_ack.text
    assert create_with_ack.json()["task"]["id"] != "sched.gen.existing"
