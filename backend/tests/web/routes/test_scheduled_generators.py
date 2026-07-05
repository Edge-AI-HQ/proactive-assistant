from __future__ import annotations

import base64
from datetime import UTC, datetime, timedelta

import httpx
import pytest
import pytest_asyncio
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from pinai_api.app import create_app
from pinai_api.domains.user_model.settings import SettingsRepository
from pinai_api.platform.auth.agent_jwt import sign_agent_run_jwt
from pinai_api.platform.auth.deps import current_user
from pinai_api.platform.auth.user_service import User
from pinai_api.platform.db.repositories.scheduled_tasks import ScheduledTasksRepository
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


def _agent_auth(user_id: int, run_id: str = "run_scheduled_generator_test") -> dict[str, str]:
    token, _ = sign_agent_run_jwt(user_id=user_id, run_id=run_id)
    return {"Authorization": f"Bearer {token}"}


_DAILY_PREVIEW_BODY = {
    "originalRequest": "每天 9 点给我推一些 AI 新闻",
    "timezone": "America/Los_Angeles",
    "schedule": {"type": "cron", "frequency": "daily", "localTime": "09:00"},
    "topic": "AI 新闻",
}

_ONCE_REMINDER_BODY = {
    "originalRequest": "5 分钟后提醒我喝水",
    "timezone": "Asia/Shanghai",
    "schedule": {"type": "once", "inMinutes": 5},
    "mode": "reminder",
    "reminder": {"title": "喝水", "message": "该喝水了"},
}


def _daily_create_body(preview_body: dict) -> dict:
    return {
        **_DAILY_PREVIEW_BODY,
        "previewId": preview_body["previewId"],
        "semanticSignature": preview_body["semanticSignature"],
        "confirmedBrief": preview_body["confirmedBrief"],
    }


def test_scheduled_generator_routes_are_mounted() -> None:
    app = create_app()
    routes = {
        (route.path, method) for route in app.routes for method in getattr(route, "methods", set())
    }

    assert ("/api/scheduled-generators/preview", "POST") in routes
    assert ("/api/scheduled-generators", "GET") in routes
    assert ("/api/scheduled-generators", "POST") in routes
    assert ("/api/scheduled-generators/once", "POST") in routes
    assert ("/api/scheduled-generators/{task_id}/pause", "POST") in routes
    assert ("/api/scheduled-generators/{task_id}/resume", "POST") in routes
    assert ("/api/scheduled-generators/{task_id}", "DELETE") in routes


@pytest.mark.asyncio
async def test_preview_and_create_daily_generate(client, user_ids, pool):
    user_a, _ = user_ids
    # 任务时区跟手机(由设备头写进 pai_user_settings);settings 行总在,默认
    # 'UTC' 会覆盖 body 里 agent 传的值,所以先把设备时区落到 LA(等价于前端
    # X-Pin-Client-Timezone 引导过),body 的 America/Los_Angeles 才能持久化。
    async with user_scoped_tx(pool, user_a) as conn:
        await SettingsRepository(user_a, conn).upsert_settings(timezone="America/Los_Angeles")
    headers = _agent_auth(user_a)
    # 同轮硬闸:create 必须发生在用户确认后的下一轮,用不同 run JWT 模拟
    confirm_headers = _agent_auth(user_a, run_id="run_confirm_turn")

    preview = await client.post(
        "/api/scheduled-generators/preview",
        headers=headers,
        json=_DAILY_PREVIEW_BODY,
    )

    assert preview.status_code == 200, preview.text
    preview_body = preview.json()
    assert preview_body["previewId"].startswith("sgprev_")
    assert preview_body["scheduleLabel"] == "每天 09:00"
    assert preview_body["parsedIntent"]["schedule"]["frequency"] == "daily"
    assert preview_body["parsedIntent"]["schedule"]["localTime"] == "09:00"
    assert preview_body["parsedIntent"]["timezone"] == "America/Los_Angeles"
    assert preview_body["parsedIntent"]["topic"] == "AI 新闻"
    assert preview_body["confirmedBrief"]["topic"] == "AI 新闻"
    assert preview_body["similarTasks"] == []

    created = await client.post(
        "/api/scheduled-generators",
        headers=confirm_headers,
        json=_daily_create_body(preview_body),
    )

    assert created.status_code == 201, created.text
    created_body = created.json()
    assert created_body["task"]["id"].startswith("sched.gen.")
    assert created_body["task"]["kind"] == "generator.scheduled"
    assert created_body["task"]["status"] == "active"
    assert created_body["task"]["cronExpr"] == "0 9 * * *"
    assert created_body["task"]["triggerKind"] == "schedule"
    assert created_body["task"]["scheduleLabel"] == "每天 09:00"
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
    assert row["payload"]["schedule_label"] == "每天 09:00"
    assert row["payload"]["trigger"] == "scheduled"


@pytest.mark.asyncio
async def test_once_reminder_direct_create(client, user_ids, pool):
    user_a, _ = user_ids

    created = await client.post("/api/scheduled-generators/once", json=_ONCE_REMINDER_BODY)

    assert created.status_code == 201, created.text
    task = created.json()["task"]
    assert task["id"].startswith("sched.once.")
    assert task["kind"] == "reminder.card"
    assert task["triggerKind"] == "once"
    assert task["scheduleLabel"].startswith("一次 ·")
    assert task["nextRunAt"] is not None

    async with service_tx(pool) as conn:
        cur = await conn.execute(
            """
            SELECT trigger_kind, next_run_at, payload
            FROM pai_scheduled_tasks
            WHERE user_id = %s AND id = %s
            """,
            (user_a, task["id"]),
        )
        row = await cur.fetchone()

    assert row is not None
    assert row["trigger_kind"] == "once"
    assert row["next_run_at"] is not None
    assert row["payload"]["reminder"]["title"] == "喝水"


@pytest.mark.asyncio
async def test_once_create_timezone_follows_profile_not_agent(client, user_ids, pool):
    """建任务时区永远跟手机:服务端用 settings 时区(由设备头维护)覆盖 agent
    传入的值——LLM 没有来源时会按语言瞎猜(中文 → Asia/Shanghai),不能再
    影响任务何时触发。"""
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        await SettingsRepository(user_a, conn).upsert_settings(timezone="America/Los_Angeles")

    created = await client.post(
        "/api/scheduled-generators/once",
        json={**_ONCE_REMINDER_BODY, "timezone": "Asia/Shanghai"},
    )
    assert created.status_code == 201, created.text
    task = created.json()["task"]

    async with service_tx(pool) as conn:
        cur = await conn.execute(
            "SELECT timezone FROM pai_scheduled_tasks WHERE user_id = %s AND id = %s",
            (user_a, task["id"]),
        )
        row = await cur.fetchone()
    assert row is not None and row["timezone"] == "America/Los_Angeles"


@pytest.mark.asyncio
async def test_once_generate_carries_fallback_reminder(client, user_ids, pool):
    """Event-briefing once tasks (mode=generate) must carry a zero-LLM
    fallback nudge — the dispatcher degrades to it when the generator burns
    its last retry, so the user is still pinged about the event."""
    user_a, _ = user_ids

    created = await client.post(
        "/api/scheduled-generators/once",
        json={
            "originalRequest": "明天 3 点我要开会,提前半小时提醒我",
            "timezone": "Asia/Shanghai",
            "schedule": {"type": "once", "inMinutes": 60},
            "mode": "generate",
            "topic": "会前 briefing:明天 15:00 的会议——议程、参会人、相关邮件、要点",
        },
    )

    assert created.status_code == 201, created.text
    task = created.json()["task"]
    assert task["kind"] == "generator.scheduled"

    async with service_tx(pool) as conn:
        cur = await conn.execute(
            "SELECT payload FROM pai_scheduled_tasks WHERE user_id = %s AND id = %s",
            (user_a, task["id"]),
        )
        row = await cur.fetchone()

    assert row is not None
    payload = row["payload"]
    assert payload["confirmed_brief"]["topic"].startswith("会前 briefing")
    fallback = payload["fallback_reminder"]
    assert fallback["title"]
    assert fallback["message"] == "明天 3 点我要开会,提前半小时提醒我"


@pytest.mark.asyncio
async def test_interval_reminder_via_preview_create(client, user_ids, pool):
    user_a, _ = user_ids
    body = {
        "originalRequest": "每 5 分钟提醒我喝水",
        "timezone": "UTC",
        "schedule": {"type": "interval", "everySeconds": 300},
        "mode": "reminder",
        "reminder": {"title": "喝水", "message": "该喝水了"},
    }

    preview = await client.post("/api/scheduled-generators/preview", json=body)
    assert preview.status_code == 200, preview.text
    preview_body = preview.json()

    created = await client.post(
        "/api/scheduled-generators",
        json={
            **body,
            "previewId": preview_body["previewId"],
            "semanticSignature": preview_body["semanticSignature"],
        },
    )

    assert created.status_code == 201, created.text
    task = created.json()["task"]
    assert task["kind"] == "reminder.card"
    assert task["intervalSeconds"] == 300

    async with service_tx(pool) as conn:
        cur = await conn.execute(
            """
            SELECT interval_seconds, cron_expr
            FROM pai_scheduled_tasks
            WHERE user_id = %s AND id = %s
            """,
            (user_a, task["id"]),
        )
        row = await cur.fetchone()

    assert row is not None
    assert row["interval_seconds"] == 300
    assert row["cron_expr"] is None


@pytest.mark.asyncio
async def test_generate_interval_below_guardrail_rejected(client):
    resp = await client.post(
        "/api/scheduled-generators/preview",
        json={
            "originalRequest": "每 5 分钟推新闻",
            "timezone": "UTC",
            "schedule": {"type": "interval", "everySeconds": 300},
            "mode": "generate",
        },
    )

    assert resp.status_code == 400, resp.text
    assert "1800" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_once_resume_restores_fire(client, user_ids, pool):
    user_a, _ = user_ids

    async with user_scoped_tx(pool, user_a) as conn:
        await ScheduledTasksRepository(user_a, conn).upsert(
            id="sched.once.existing",
            kind="reminder.card",
            trigger_kind="once",
            next_run_at=datetime.now(UTC) + timedelta(hours=1),
            timezone="Asia/Shanghai",
            payload={
                "reminder": {"title": "喝水", "message": "该喝水了"},
                "schedule_label": "一次 · 06-09 18:00",
            },
        )

    paused = await client.post("/api/scheduled-generators/sched.once.existing/pause")
    assert paused.status_code == 200, paused.text
    assert paused.json()["task"]["status"] == "paused"

    resumed = await client.post("/api/scheduled-generators/sched.once.existing/resume")
    assert resumed.status_code == 200, resumed.text
    assert resumed.json()["task"]["status"] == "active"
    assert resumed.json()["task"]["nextRunAt"] is not None


@pytest.mark.asyncio
async def test_list_returns_both_kinds(client):
    preview = await client.post("/api/scheduled-generators/preview", json=_DAILY_PREVIEW_BODY)
    assert preview.status_code == 200, preview.text

    created = await client.post(
        "/api/scheduled-generators",
        json=_daily_create_body(preview.json()),
    )
    assert created.status_code == 201, created.text
    generator_id = created.json()["task"]["id"]

    once = await client.post("/api/scheduled-generators/once", json=_ONCE_REMINDER_BODY)
    assert once.status_code == 201, once.text
    once_id = once.json()["task"]["id"]

    listed = await client.get("/api/scheduled-generators")
    assert listed.status_code == 200, listed.text
    items = {item["id"]: item for item in listed.json()["items"]}
    assert set(items) == {generator_id, once_id}
    assert items[once_id]["scheduleLabel"].startswith("一次 ·")


@pytest.mark.asyncio
async def test_create_is_idempotent_for_same_preview(client, user_ids, pool):
    user_a, _ = user_ids
    headers = _agent_auth(user_a)
    confirm_headers = _agent_auth(user_a, run_id="run_confirm_turn")

    preview = await client.post(
        "/api/scheduled-generators/preview",
        headers=headers,
        json=_DAILY_PREVIEW_BODY,
    )
    assert preview.status_code == 200, preview.text
    preview_body = preview.json()
    body = _daily_create_body(preview_body)

    first = await client.post("/api/scheduled-generators", headers=confirm_headers, json=body)
    second = await client.post("/api/scheduled-generators", headers=confirm_headers, json=body)

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
    confirm_headers = _agent_auth(user_a, run_id="run_confirm_turn")

    # The create path recomputes the semantic signature server-side, so seed
    # the pre-existing row with the signature preview computes for this body.
    first_preview = await client.post(
        "/api/scheduled-generators/preview",
        headers=headers,
        json=_DAILY_PREVIEW_BODY,
    )
    assert first_preview.status_code == 200, first_preview.text
    semantic_signature = first_preview.json()["semanticSignature"]

    async with user_scoped_tx(pool, user_a) as conn:
        await ScheduledTasksRepository(user_a, conn).upsert(
            id="sched.gen.existing",
            kind="generator.scheduled",
            trigger_kind="schedule",
            cron_expr="0 9 * * *",
            next_run_at=datetime(2026, 6, 8, 16, 0, tzinfo=UTC),
            timezone="America/Los_Angeles",
            payload={
                "semantic_signature": semantic_signature,
                "parsed_intent": {
                    "schedule": {"type": "cron", "frequency": "daily", "local_time": "09:00"},
                    "timezone": "America/Los_Angeles",
                    "topic": "AI 新闻",
                    "mode": "generate",
                },
                "confirmed_brief": {"topic": "AI 新闻", "title": "AI 新闻卡片"},
                "schedule_label": "每天 09:00",
            },
        )

    preview = await client.post(
        "/api/scheduled-generators/preview",
        headers=headers,
        json=_DAILY_PREVIEW_BODY,
    )
    assert preview.status_code == 200, preview.text
    preview_body = preview.json()
    assert [item["id"] for item in preview_body["similarTasks"]] == ["sched.gen.existing"]

    create_without_ack = await client.post(
        "/api/scheduled-generators",
        headers=confirm_headers,
        json=_daily_create_body(preview_body),
    )
    assert create_without_ack.status_code == 409, create_without_ack.text
    assert create_without_ack.json()["requiresConfirmation"] is True
    assert [item["id"] for item in create_without_ack.json()["similarTasks"]] == [
        "sched.gen.existing"
    ]

    create_with_ack = await client.post(
        "/api/scheduled-generators",
        headers=confirm_headers,
        json={
            **_daily_create_body(preview_body),
            "duplicateAck": True,
            "similarTaskIdsSeen": ["sched.gen.existing"],
        },
    )
    assert create_with_ack.status_code == 201, create_with_ack.text
    assert create_with_ack.json()["task"]["id"] != "sched.gen.existing"


@pytest.mark.asyncio
async def test_same_turn_create_is_rejected_by_confirmation_gate(client, user_ids):
    """preview 和 create 带同一个 run JWT(= 模型在同一轮里没等用户确认就
    create)必须 400。这是确认流程的服务端硬闸——提示词约束失守时的兜底,
    回归自 2026-06-10 本地验收(agent 自行确认创建)。"""
    user_a, _ = user_ids
    same_turn = _agent_auth(user_a, run_id="run_same_turn")

    preview = await client.post(
        "/api/scheduled-generators/preview",
        headers=same_turn,
        json=_DAILY_PREVIEW_BODY,
    )
    assert preview.status_code == 200, preview.text
    preview_body = preview.json()

    blocked = await client.post(
        "/api/scheduled-generators",
        headers=same_turn,
        json=_daily_create_body(preview_body),
    )
    assert blocked.status_code == 400, blocked.text
    assert "confirmation gate" in blocked.json()["detail"]

    # 换一轮(用户确认后的新 run)就放行
    confirmed = await client.post(
        "/api/scheduled-generators",
        headers=_agent_auth(user_a, run_id="run_next_turn"),
        json=_daily_create_body(preview_body),
    )
    assert confirmed.status_code == 201, confirmed.text
