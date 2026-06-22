from __future__ import annotations

from datetime import UTC, datetime
from zoneinfo import ZoneInfo

import httpx
import pytest
from pinai_api.app import create_app
from pinai_api.domains.user_model.profile import ProfileRepository
from pinai_api.domains.user_model.profile_ui import _initial_generation_language_from_locale
from pinai_api.platform.auth.deps import current_user
from pinai_api.platform.auth.user_service import User
from pinai_api.platform.db.repositories.scheduled_tasks import ScheduledTasksRepository
from pinai_db.rls import user_scoped_tx


def _user(user_id: int) -> User:
    return User(
        id=user_id,
        supabase_user_id="00000000-0000-0000-0000-000000000001",
        email="ui-profile@test.invalid",
        litellm_virtual_key=None,
        browserbase_context_id=None,
    )


def test_initial_generation_language_from_locale_uses_supported_language_family():
    assert _initial_generation_language_from_locale("zh-CN") == "zh-Hans"
    assert _initial_generation_language_from_locale("zh-Hant-TW") == "zh-Hans"
    assert _initial_generation_language_from_locale("ja-JP") == "ja"
    assert _initial_generation_language_from_locale("pt-BR") == "pt"
    assert _initial_generation_language_from_locale("it-IT") is None


@pytest.mark.asyncio
async def test_profile_snapshot_backfills_default_locale_timezone_from_client_headers(
    pool, user_ids
):
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        await ProfileRepository(user_a, conn).upsert_profile(display_name="Alice")

    app = create_app()
    app.state.pool = pool
    app.dependency_overrides[current_user] = lambda: _user(user_a)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport,
        base_url="http://testserver",
    ) as client:
        res = await client.get(
            "/api/profile",
            headers={
                "X-Pin-Client-Locale": "zh-CN",
                "X-Pin-Client-Timezone": "Asia/Shanghai",
            },
        )

    assert res.status_code == 200, res.text
    profile = res.json()["profile"]
    assert profile["locale"] == "zh-CN"
    assert profile["timezone"] == "Asia/Shanghai"

    async with user_scoped_tx(pool, user_a) as conn:
        stored = await ProfileRepository(user_a, conn).get_profile()
    assert stored is not None
    assert stored.locale == "zh-CN"
    assert stored.timezone == "Asia/Shanghai"


@pytest.mark.asyncio
async def test_profile_timezone_follows_device_and_retimes_cron_tasks(pool, user_ids):
    """永远跟手机:① 没有 profile 行也能从设备头建档;② 设备时区漂移时更新
    并把周期任务的"每天 X 点"重排到新时区;③ once 任务定格不动。"""
    user_a, _ = user_ids

    app = create_app()
    app.state.pool = pool
    app.dependency_overrides[current_user] = lambda: _user(user_a)
    transport = httpx.ASGITransport(app=app)

    # ① 无 profile 行 → 设备头直接建档(旧条件下这里永远引导不上)。走
    # /api/settings —— App 冷启动实际只打这个接口,不打 /api/profile。
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        res = await client.get("/api/settings", headers={"X-Pin-Client-Timezone": "Asia/Shanghai"})
    assert res.status_code == 200, res.text
    async with user_scoped_tx(pool, user_a) as conn:
        stored = await ProfileRepository(user_a, conn).get_profile()
    assert stored is not None and stored.timezone == "Asia/Shanghai"

    # 种一个上海时区的"每天 9 点" cron 任务 + 一个 once 任务。
    async with user_scoped_tx(pool, user_a) as conn:
        repo = ScheduledTasksRepository(user_a, conn)
        cron_task = await repo.upsert(
            id="sched.tzfollow.cron",
            kind="generator.scheduled",
            trigger_kind="schedule",
            cron_expr="0 9 * * *",
            next_run_at=datetime.now(UTC),
            timezone="Asia/Shanghai",
            payload={},
        )
        once_task = await repo.upsert(
            id="sched.tzfollow.once",
            kind="reminder.card",
            trigger_kind="once",
            next_run_at=datetime.now(UTC),
            timezone="Asia/Shanghai",
            payload={},
        )
        # paused cron 任务也要跟时区:retime 是边沿触发,暂停中错过就永远
        # 错过,resume 会按行上的旧时区重排(在上海暂停、落地 LA 再恢复 →
        # 永远按上海 9 点触发)。
        paused_task = await repo.upsert(
            id="sched.tzfollow.paused",
            kind="generator.scheduled",
            trigger_kind="schedule",
            cron_expr="0 9 * * *",
            next_run_at=datetime.now(UTC),
            timezone="Asia/Shanghai",
            payload={},
        )
        await conn.execute(
            "UPDATE pai_scheduled_tasks SET status = 'paused' "
            "WHERE user_id = %s AND id = 'sched.tzfollow.paused'",
            (user_a,),
        )
    assert cron_task is not None and once_task is not None and paused_task is not None

    # ② 设备搬到洛杉矶 → profile 更新 + cron 任务重排到 LA 的 9 点。
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        res = await client.get(
            "/api/settings", headers={"X-Pin-Client-Timezone": "America/Los_Angeles"}
        )
    assert res.status_code == 200, res.text

    async with user_scoped_tx(pool, user_a) as conn:
        stored = await ProfileRepository(user_a, conn).get_profile()
        cur = await conn.execute(
            "SELECT id, timezone, next_run_at FROM pai_scheduled_tasks "
            "WHERE user_id = %s AND id LIKE 'sched.tzfollow.%%'",
            (user_a,),
        )
        rows = {r["id"]: r for r in await cur.fetchall()}
    assert stored is not None and stored.timezone == "America/Los_Angeles"
    cron_after = rows["sched.tzfollow.cron"]
    assert cron_after["timezone"] == "America/Los_Angeles"
    # 重排后的下一次触发 = LA 当地 09:00。
    local = cron_after["next_run_at"].astimezone(ZoneInfo("America/Los_Angeles"))
    assert (local.hour, local.minute) == (9, 0)
    # paused cron 任务的 timezone 同步改写(resume 据此重排到新时区)。
    assert rows["sched.tzfollow.paused"]["timezone"] == "America/Los_Angeles"
    # ③ once 任务的时区/时间保持创建时的定格。
    assert rows["sched.tzfollow.once"]["timezone"] == "Asia/Shanghai"


@pytest.mark.asyncio
async def test_settings_get_initializes_generation_language_from_client_locale(pool, user_ids):
    user_a, _ = user_ids

    app = create_app()
    app.state.pool = pool
    app.dependency_overrides[current_user] = lambda: _user(user_a)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport,
        base_url="http://testserver",
    ) as client:
        res = await client.get(
            "/api/settings",
            headers={"X-Pin-Client-Locale": "zh-CN"},
        )

    assert res.status_code == 200, res.text
    assert res.json()["generationLanguage"] == "zh-Hans"

    async with user_scoped_tx(pool, user_a) as conn:
        stored = await ProfileRepository(user_a, conn).get_settings()
    assert stored.generation_language == "zh-Hans"


@pytest.mark.asyncio
async def test_settings_get_does_not_override_existing_generation_language_from_locale(
    pool, user_ids
):
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        await ProfileRepository(user_a, conn).upsert_settings(generation_language="en")

    app = create_app()
    app.state.pool = pool
    app.dependency_overrides[current_user] = lambda: _user(user_a)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport,
        base_url="http://testserver",
    ) as client:
        res = await client.get(
            "/api/settings",
            headers={"X-Pin-Client-Locale": "zh-CN"},
        )

    assert res.status_code == 200, res.text
    assert res.json()["generationLanguage"] == "en"

    async with user_scoped_tx(pool, user_a) as conn:
        stored = await ProfileRepository(user_a, conn).get_settings()
    assert stored.generation_language == "en"


@pytest.mark.asyncio
async def test_settings_auto_dreaming_creates_daily_schedule(pool, user_ids):
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        await ProfileRepository(user_a, conn).upsert_profile(
            display_name="Alice",
            timezone="Asia/Shanghai",
        )

    app = create_app()
    app.state.pool = pool
    app.dependency_overrides[current_user] = lambda: _user(user_a)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport,
        base_url="http://testserver",
    ) as client:
        res = await client.post("/api/settings", json={"autoDreaming": True})

    assert res.status_code == 200, res.text
    assert res.json()["autoDreaming"] is True

    async with user_scoped_tx(pool, user_a) as conn, conn.cursor() as cur:
        await cur.execute(
            """
            SELECT id, kind, trigger_kind, status, cron_expr, timezone,
                   next_run_at, payload
            FROM pai_scheduled_tasks
            WHERE user_id=%s AND id=%s
            """,
            (user_a, f"dream.auto.{user_a}"),
        )
        row = await cur.fetchone()

    assert row is not None
    assert row["kind"] == "auto.dreaming"
    assert row["trigger_kind"] == "schedule"
    assert row["status"] == "active"
    assert row["cron_expr"] == "0 6 * * *"
    assert row["timezone"] == "Asia/Shanghai"
    assert row["next_run_at"] is not None
    assert row["payload"] == {"trigger": "auto"}


@pytest.mark.asyncio
async def test_settings_auto_dreaming_off_archives_schedule(pool, user_ids):
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        await ProfileRepository(user_a, conn).upsert_profile(
            display_name="Alice",
            timezone="Asia/Shanghai",
        )

    app = create_app()
    app.state.pool = pool
    app.dependency_overrides[current_user] = lambda: _user(user_a)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport,
        base_url="http://testserver",
    ) as client:
        on_res = await client.post("/api/settings", json={"autoDreaming": True})
        off_res = await client.post("/api/settings", json={"autoDreaming": False})

    assert on_res.status_code == 200, on_res.text
    assert off_res.status_code == 200, off_res.text
    assert off_res.json()["autoDreaming"] is False

    async with user_scoped_tx(pool, user_a) as conn, conn.cursor() as cur:
        await cur.execute(
            """
            SELECT status, next_run_at
            FROM pai_scheduled_tasks
            WHERE user_id=%s AND id=%s
            """,
            (user_a, f"dream.auto.{user_a}"),
        )
        row = await cur.fetchone()

    assert row is not None
    assert row["status"] == "archived"
    assert row["next_run_at"] is None


@pytest.mark.asyncio
async def test_settings_get_repairs_missing_auto_dreaming_schedule(pool, user_ids):
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        repo = ProfileRepository(user_a, conn)
        await repo.upsert_profile(display_name="Alice", timezone="Asia/Shanghai")
        await repo.upsert_settings(auto_dreaming=True)

    app = create_app()
    app.state.pool = pool
    app.dependency_overrides[current_user] = lambda: _user(user_a)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport,
        base_url="http://testserver",
    ) as client:
        res = await client.get("/api/settings")

    assert res.status_code == 200, res.text
    assert res.json()["autoDreaming"] is True

    async with user_scoped_tx(pool, user_a) as conn, conn.cursor() as cur:
        await cur.execute(
            """
            SELECT kind, trigger_kind, status, cron_expr, timezone
            FROM pai_scheduled_tasks
            WHERE user_id=%s AND id=%s
            """,
            (user_a, f"dream.auto.{user_a}"),
        )
        row = await cur.fetchone()

    assert row is not None
    assert row["kind"] == "auto.dreaming"
    assert row["trigger_kind"] == "schedule"
    assert row["status"] == "active"
    assert row["cron_expr"] == "0 6 * * *"
    assert row["timezone"] == "Asia/Shanghai"


@pytest.mark.asyncio
async def test_onboarding_completion_provisions_litellm_key_and_browserbase(
    pool,
    user_ids,
    monkeypatch,
):
    """Finishing onboarding provisions the LiteLLM key + Browserbase context
    before stamping onboarding_completed_at, so every downstream LLM/agent task
    (connector.evolve / dreaming / generator / proactive / chat) has a key the
    moment it runs. Provisioning is mocked — assert it's invoked + completion
    is stamped."""
    from pinai_api.domains.user_model import profile_ui as profile_routes

    user_a, _ = user_ids
    calls = {"litellm": 0, "browserbase": 0}

    async def fake_litellm(_pool, user, *, required_models=None):
        calls["litellm"] += 1
        return user

    async def fake_browserbase(_pool, user):
        calls["browserbase"] += 1
        return user

    monkeypatch.setattr(profile_routes, "ensure_user_litellm_key", fake_litellm)
    monkeypatch.setattr(profile_routes, "ensure_browserbase_context", fake_browserbase)

    app = create_app()
    app.state.pool = pool
    app.dependency_overrides[current_user] = lambda: _user(user_a)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport,
        base_url="http://testserver",
    ) as client:
        res = await client.post("/api/settings", json={"onboardingCompleted": True})

    assert res.status_code == 200, res.text
    assert calls == {"litellm": 1, "browserbase": 1}
    assert res.json()["onboardingCompletedAt"] is not None


@pytest.mark.asyncio
async def test_onboarding_blocked_when_litellm_provisioning_fails(
    pool,
    user_ids,
    monkeypatch,
):
    """If LiteLLM key provisioning fails at onboarding completion, the request
    errors and onboarding_completed_at is NOT stamped — the client retries, so
    a user never finishes onboarding without a usable key."""
    from pinai_api.domains.user_model import profile_ui as profile_routes

    user_a, _ = user_ids

    async def boom(_pool, user, *, required_models=None):
        raise RuntimeError("litellm down")

    monkeypatch.setattr(profile_routes, "ensure_user_litellm_key", boom)

    app = create_app()
    app.state.pool = pool
    app.dependency_overrides[current_user] = lambda: _user(user_a)
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    async with httpx.AsyncClient(
        transport=transport,
        base_url="http://testserver",
    ) as client:
        res = await client.post("/api/settings", json={"onboardingCompleted": True})

    assert res.status_code >= 500
    async with user_scoped_tx(pool, user_a) as conn:
        settings = await ProfileRepository(user_a, conn).get_settings()
    assert settings.onboarding_completed_at is None


@pytest.mark.asyncio
async def test_web_platform_seeds_but_never_overrides_timezone(pool, user_ids):
    """平台分级:web/desktop(X-Pin-Client-Platform: web)只能 seed 还没
    确立的时区(行缺失或建行默认 'UTC'),不能覆盖手机已确立的时区 —
    否则出差场景下手机和家里桌面端会让时区反复横跳。缺 platform 头 =
    在野老 App,保持完整跟随。"""
    _, user_b = user_ids

    app = create_app()
    app.state.pool = pool
    app.dependency_overrides[current_user] = lambda: _user(user_b)
    transport = httpx.ASGITransport(app=app)

    async def settings_get(headers: dict[str, str]) -> None:
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
            res = await client.get("/api/settings", headers=headers)
        assert res.status_code == 200, res.text

    async def stored_tz() -> str | None:
        async with user_scoped_tx(pool, user_b) as conn:
            prof = await ProfileRepository(user_b, conn).get_profile()
        return prof.timezone if prof else None

    # ① 无档案时 web 端可以 seed(首日 onboarding 不退化到 UTC)。
    await settings_get({"X-Pin-Client-Timezone": "Europe/Berlin", "X-Pin-Client-Platform": "web"})
    assert await stored_tz() == "Europe/Berlin"

    # ② 手机确立时区(缺 platform 头 = 老 App,同样完整跟随)。
    await settings_get({"X-Pin-Client-Timezone": "Asia/Shanghai"})
    assert await stored_tz() == "Asia/Shanghai"

    # ③ web 端不同时区轮询 → 不得覆盖,不 retime。
    await settings_get({"X-Pin-Client-Timezone": "Europe/Berlin", "X-Pin-Client-Platform": "web"})
    assert await stored_tz() == "Asia/Shanghai"

    # ④ 手机(显式 ios 平台头)漂移 → 照常跟随。
    await settings_get(
        {"X-Pin-Client-Timezone": "America/Los_Angeles", "X-Pin-Client-Platform": "ios"}
    )
    assert await stored_tz() == "America/Los_Angeles"
