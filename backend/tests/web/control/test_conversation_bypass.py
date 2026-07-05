"""P0-4: /send derives bypass_permissions server-side from permission_mode,
never from the client-supplied bool."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest
from pinai_api.control import conversation
from pinai_api.domains.user_model.settings import SettingsRepository
from pinai_api.platform.auth.user_service import User
from pinai_db.rls import user_scoped_tx


def _user(user_id: int) -> User:
    return User(
        id=user_id,
        supabase_user_id="00000000-0000-0000-0000-000000000000",
        email="t@test.invalid",
        litellm_virtual_key=None,
        browserbase_context_id=None,
    )


def _request_capturing(captured: dict[str, Any]) -> SimpleNamespace:
    """A fake FastAPI Request whose agent_service.post_message records the meta
    the send handler hands off (the channel bypass_permissions rides on)."""

    async def post_message(_session_key: str, **kwargs: Any) -> None:
        captured["meta"] = kwargs.get("meta")

    agent_service = SimpleNamespace(post_message=post_message)
    return SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(agent_service=agent_service)))


@pytest.mark.asyncio
async def test_send_ignores_client_bypass_when_permission_mode_ask(user_ids, pool):
    user_id, _ = user_ids
    captured: dict[str, Any] = {}
    request = _request_capturing(captured)
    # Default permission_mode is 'ask'; the client lies with bypassPermissions=true.
    body = {"session_key": f"main-{user_id}-t1", "message": "hi", "bypassPermissions": True}
    await conversation.send(body, request, user=_user(user_id), pool=pool)
    assert (captured["meta"] or {}).get("bypass_permissions") is None


@pytest.mark.asyncio
async def test_send_derives_bypass_from_permission_mode(user_ids, pool):
    user_id, _ = user_ids
    async with user_scoped_tx(pool, user_id) as conn:
        await SettingsRepository(user_id, conn).upsert_settings(permission_mode="bypass")
    captured: dict[str, Any] = {}
    request = _request_capturing(captured)
    # Client sends no bypass field at all — it must be derived from the DB.
    body = {"session_key": f"main-{user_id}-t2", "message": "hi"}
    await conversation.send(body, request, user=_user(user_id), pool=pool)
    assert captured["meta"]["bypass_permissions"] is True
