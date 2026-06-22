from __future__ import annotations

import httpx
import pytest
from pinai_api.app import create_app
from pinai_api.control.agent_runs import _AGENT_KINDS
from pinai_api.platform.auth.deps import current_user
from pinai_api.platform.auth.user_service import User
from pinai_db.rls import service_tx


def _user(user_id: int) -> User:
    return User(
        id=user_id,
        supabase_user_id="00000000-0000-0000-0000-000000000001",
        email="agent-runs@test.invalid",
        litellm_virtual_key=None,
        browserbase_context_id=None,
    )


def test_agent_runs_surfaces_scheduled_generator_kind():
    assert "generator.scheduled" in _AGENT_KINDS


@pytest.mark.asyncio
async def test_active_agent_runs_ignores_recently_archived_recurring_schedule(
    pool,
    user_ids,
):
    user_a, _ = user_ids
    async with service_tx(pool) as conn:
        await conn.execute(
            """
            INSERT INTO pai_scheduled_tasks
              (user_id, id, kind, trigger_kind, status, next_run_at,
               last_run_status, last_error, updated_at)
            VALUES
              (%s, 'gen.auto.test', 'generator.auto', 'schedule', 'archived',
               NULL, 'failed', 'old generate worker 500', NOW())
            """,
            (user_a,),
        )
        await conn.execute(
            """
            INSERT INTO pai_scheduled_task_runs
              (user_id, id, task_id, scheduled_for, fired_at, status, error)
            VALUES
              (%s, 'gen.auto.test.oldrun', 'gen.auto.test',
               NOW() - INTERVAL '1 day', NOW() - INTERVAL '1 day',
               'failed', 'old generate worker 500')
            """,
            (user_a,),
        )

    app = create_app()
    app.state.pool = pool
    app.dependency_overrides[current_user] = lambda: _user(user_a)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport,
        base_url="http://testserver",
    ) as client:
        res = await client.get("/api/agent-runs/active")

    assert res.status_code == 200, res.text
    assert res.json()["runs"] == []
