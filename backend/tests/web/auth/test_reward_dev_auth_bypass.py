from __future__ import annotations

import pytest
from fastapi import HTTPException
from pinai_reward_dashboard import auth
from pinai_reward_dashboard.config import get_settings


@pytest.fixture(autouse=True)
def _settings(monkeypatch):
    monkeypatch.setenv("DEPLOY_ENV", "dev")
    monkeypatch.setenv("DEV_AUTH_BYPASS", "1")
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


@pytest.fixture
def captured_upserts(monkeypatch):
    calls: list[str] = []

    async def _fake_upsert(pool, *, supabase_user_id: str, email: str | None = None):
        calls.append(supabase_user_id)
        return auth.User(
            id=1,
            supabase_user_id=supabase_user_id,
            email=email,
            litellm_virtual_key=None,
            browserbase_context_id=None,
        )

    monkeypatch.setattr(auth, "_upsert_user_by_supabase_id", _fake_upsert)
    return calls


@pytest.mark.asyncio
async def test_reviewer_header_works_with_local_flag(captured_upserts):
    user = await auth.current_user(
        authorization=None, x_dev_auth="pinai-dev-reviewer", pool=object()
    )

    assert user.supabase_user_id == auth._DEV_AUTH_REVIEWER_SUB
    assert captured_upserts == [auth._DEV_AUTH_REVIEWER_SUB]


@pytest.mark.asyncio
async def test_reviewer_header_ignored_on_dev_without_local_flag(monkeypatch, captured_upserts):
    # fly dev: DEPLOY_ENV=dev on a public URL, no DEV_AUTH_BYPASS.
    monkeypatch.delenv("DEV_AUTH_BYPASS")
    get_settings.cache_clear()

    with pytest.raises(HTTPException) as exc:
        await auth.current_user(authorization=None, x_dev_auth="pinai-dev-reviewer", pool=object())

    assert exc.value.status_code == 401
    assert captured_upserts == []
