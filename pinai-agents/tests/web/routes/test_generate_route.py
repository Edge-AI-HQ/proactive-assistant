from __future__ import annotations

import uuid

import pytest

from pinai_agents.shared.api_models import GenerateRequest
from pinai_agents.web.auth.user_service import User
from pinai_agents.web.db.rls import service_tx
from pinai_agents.web.routes.ui import generate as generate_route
from pinai_agents.web.services.chat_proxy import _GENERATE_READ_TIMEOUT_SECONDS


def test_generate_proxy_read_timeout_is_ten_minutes() -> None:
    assert _GENERATE_READ_TIMEOUT_SECONDS == 600.0


@pytest.mark.asyncio
async def test_manual_generate_does_not_retry_after_timeout(
    pool,
    user_ids,
    monkeypatch,
) -> None:
    user_a, _ = user_ids
    user = User(
        id=user_a,
        supabase_user_id=str(uuid.uuid4()),
        email="generate-route@test.invalid",
        litellm_virtual_key="sk-test",
        browserbase_context_id=None,
    )

    async def fake_ensure_virtual_key(user_arg, pool_arg):
        return user_arg

    monkeypatch.setattr(generate_route, "_ensure_virtual_key", fake_ensure_virtual_key)

    body = GenerateRequest(cards_to_generate=1, output_language="zh-Hans")
    result = await generate_route.generate(body=body, user=user, pool=pool)

    async with service_tx(pool) as conn:
        cur = await conn.execute(
            """
            SELECT max_attempts
            FROM pai_scheduled_tasks
            WHERE user_id = %s AND id = %s
            """,
            (user_a, result["taskId"]),
        )
        row = await cur.fetchone()

    assert row is not None
    assert row["max_attempts"] == 1
