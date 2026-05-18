from __future__ import annotations

import httpx
import pytest

from pinai_agents.web.app import create_app
from pinai_agents.web.auth.deps import current_user
from pinai_agents.web.auth.user_service import User
from pinai_agents.web.db.repositories.profile import ProfileRepository
from pinai_agents.web.db.rls import user_scoped_tx


def _user(user_id: int) -> User:
    return User(
        id=user_id,
        supabase_user_id="00000000-0000-0000-0000-000000000001",
        email="ui-profile@test.invalid",
        litellm_virtual_key=None,
        browserbase_context_id=None,
    )


@pytest.mark.asyncio
async def test_profile_snapshot_backfills_default_locale_timezone_from_client_headers(pool, user_ids):
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
async def test_settings_auto_dreaming_creates_daily_schedule(pool, user_ids):
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        await ProfileRepository(user_a, conn).upsert_profile(
            display_name="Alice", timezone="Asia/Shanghai",
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
            display_name="Alice", timezone="Asia/Shanghai",
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
async def test_settings_get_repairs_archived_auto_generate_schedule(pool, user_ids):
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        repo = ProfileRepository(user_a, conn)
        settings = await repo.upsert_settings(auto_generate=True)
        async with conn.cursor() as cur:
            await cur.execute(
                """
                INSERT INTO pai_scheduled_tasks
                  (user_id, id, kind, trigger_kind, interval_seconds,
                   payload, status, next_run_at, last_run_status)
                VALUES (%s, %s, 'generator.auto', 'schedule', %s,
                        %s::jsonb, 'archived', NULL, 'failed')
                """,
                (
                    user_a,
                    f"gen.auto.{user_a}",
                    settings.auto_generate_interval_minutes * 60,
                    '{"trigger":"auto","output_language":"en","cards_to_generate":4}',
                ),
            )

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
    assert res.json()["autoGenerate"] is True

    async with user_scoped_tx(pool, user_a) as conn, conn.cursor() as cur:
        await cur.execute(
            """
            SELECT status, next_run_at, payload
            FROM pai_scheduled_tasks
            WHERE user_id=%s AND id=%s
            """,
            (user_a, f"gen.auto.{user_a}"),
        )
        row = await cur.fetchone()

    assert row is not None
    assert row["status"] == "active"
    assert row["next_run_at"] is not None
    assert row["payload"]["output_language"] == "zh-Hans"
