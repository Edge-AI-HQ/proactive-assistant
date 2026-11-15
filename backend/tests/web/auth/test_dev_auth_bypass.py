from __future__ import annotations

import pytest
from fastapi import HTTPException
from pinai_api.platform.auth import deps
from pinai_api.platform.auth.user_service import User


@pytest.fixture(autouse=True)
def _settings(monkeypatch):
    monkeypatch.setenv("DEPLOY_ENV", "dev")
    monkeypatch.setenv("DEV_AUTH_BYPASS", "1")
    from pinai_api import config

    config.get_web_settings.cache_clear()
    yield
    config.get_web_settings.cache_clear()


@pytest.fixture
def captured_upserts(monkeypatch):
    calls: list[tuple[str, str]] = []

    async def _fake_upsert(pool, *, supabase_user_id: str, email: str | None):
        calls.append((supabase_user_id, email or ""))
        return User(
            id=len(calls),
            supabase_user_id=supabase_user_id,
            email=email,
            litellm_virtual_key=None,
            browserbase_context_id=None,
        )

    monkeypatch.setattr(deps, "upsert_user_by_supabase_id", _fake_upsert)
    return calls


@pytest.mark.asyncio
async def test_local_dev_header_maps_to_fixed_product_user(captured_upserts):
    user = await deps.current_user(
        authorization=None,
        x_dev_auth="pinai-local-dev-user",
        pool=object(),
    )

    assert user.supabase_user_id == "00000000-0000-0000-0000-00000000d0d0"
    assert user.email == "dev-user@local.invalid"
    assert captured_upserts == [
        ("00000000-0000-0000-0000-00000000d0d0", "dev-user@local.invalid"),
    ]


@pytest.mark.asyncio
async def test_dashboard_dev_header_stays_separate_from_product_user(captured_upserts):
    user = await deps.current_user(
        authorization=None,
        x_dev_auth="pinai-dev-reviewer",
        pool=object(),
    )

    assert user.supabase_user_id == deps._DEV_AUTH_BYPASS_SUB
    assert user.supabase_user_id != "00000000-0000-0000-0000-00000000d0d0"
    assert user.email == "dev-reviewer@local.invalid"


@pytest.mark.asyncio
async def test_dev_header_is_ignored_outside_dev(monkeypatch, captured_upserts):
    monkeypatch.setenv("DEPLOY_ENV", "test")
    from pinai_api import config

    config.get_web_settings.cache_clear()

    with pytest.raises(HTTPException) as exc:
        await deps.current_user(
            authorization=None,
            x_dev_auth="pinai-local-dev-user",
            pool=object(),
        )

    assert exc.value.status_code == 401
    assert captured_upserts == []


@pytest.mark.asyncio
async def test_dev_header_is_ignored_without_explicit_flag(monkeypatch, captured_upserts):
    # fly dev runs DEPLOY_ENV=dev on a public URL; without the local-only
    # flag the fixed marker must not authenticate.
    monkeypatch.delenv("DEV_AUTH_BYPASS")
    from pinai_api import config

    config.get_web_settings.cache_clear()

    with pytest.raises(HTTPException) as exc:
        await deps.current_user(
            authorization=None,
            x_dev_auth="pinai-dev-reviewer",
            pool=object(),
        )

    assert exc.value.status_code == 401
    assert captured_upserts == []


@pytest.mark.asyncio
async def test_unknown_dev_header_falls_back_to_bearer_auth(captured_upserts):
    with pytest.raises(HTTPException) as exc:
        await deps.current_user(
            authorization=None,
            x_dev_auth="pinai-local-dev-user-typo",
            pool=object(),
        )

    assert exc.value.status_code == 401
    assert captured_upserts == []
