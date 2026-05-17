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
