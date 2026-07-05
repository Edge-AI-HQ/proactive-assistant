"""SettingsRepository — per-user pai_user_settings row.

Was bundled with the retired pai_profile / pai_goals tables (snapshot for
this user) until the lifelong-memory sunset; those moved to the L1 events
stream + L2 markdown portrait. What remains here is the settings row,
including the `timezone` column that migrated over from pai_profile
(migration 113).
"""

from __future__ import annotations

from datetime import UTC, datetime

import pytest
from pinai_api.domains.user_model.settings import SettingsRepository
from pinai_db.rls import user_scoped_tx


@pytest.mark.asyncio
async def test_settings_upsert_partial_fields(pool, user_ids):
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        repo = SettingsRepository(user_a, conn)
        s1 = await repo.upsert_settings(generation_language="zh-Hans")
    assert s1.generation_language == "zh-Hans"
    assert s1.auto_generate is True  # default (038)
    assert s1.auto_generate_interval_minutes == 60  # default (126)

    # Toggle just auto_generate off; other fields should stay put.
    async with user_scoped_tx(pool, user_a) as conn:
        repo = SettingsRepository(user_a, conn)
        s2 = await repo.upsert_settings(auto_generate=False)
    assert s2.auto_generate is False
    assert s2.generation_language == "zh-Hans"  # preserved


@pytest.mark.asyncio
async def test_settings_lazy_create_returns_defaults(pool, user_ids):
    """`get_settings` is the single entry point — it lazy-creates on first
    read so callers never need a `None` branch and DB column DEFAULTs are
    the only source of truth for initial values."""
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        repo = SettingsRepository(user_a, conn)
        s = await repo.get_settings()
    # Column defaults from 010_pai_core_state.sql + later ALTER-default migrations.
    assert s.timezone == "UTC"  # default (113)
    assert s.generation_language == "en"
    assert s.auto_generate is True
    assert s.auto_generate_interval_minutes == 60  # migration 126 default
    assert s.auto_dreaming is True  # 086 flipped the column default ON
    assert s.proactive_interval_seconds == 300  # default (081): 5 min
    assert s.metadata == {}


@pytest.mark.asyncio
async def test_settings_timezone_round_trip(pool, user_ids):
    """timezone migrated from the retired pai_profile to pai_user_settings
    (113). Defaults to 'UTC'; an explicit upsert persists, and an unrelated
    edit preserves it via COALESCE."""
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        s = await SettingsRepository(user_a, conn).get_settings()
    assert s.timezone == "UTC"

    async with user_scoped_tx(pool, user_a) as conn:
        updated = await SettingsRepository(user_a, conn).upsert_settings(
            timezone="Asia/Shanghai",
        )
    assert updated.timezone == "Asia/Shanghai"

    async with user_scoped_tx(pool, user_a) as conn:
        s = await SettingsRepository(user_a, conn).get_settings()
    assert s.timezone == "Asia/Shanghai"

    # An unrelated edit must NOT reset the timezone (COALESCE).
    async with user_scoped_tx(pool, user_a) as conn:
        preserved = await SettingsRepository(user_a, conn).upsert_settings(
            generation_language="en",
        )
    assert preserved.timezone == "Asia/Shanghai"


@pytest.mark.asyncio
async def test_settings_default_notify_new_cards_off(pool, user_ids):
    """notify_new_cards defaults to FALSE: nothing fires until the user
    explicitly opts in via the in-app pre-prompt + OS grant."""
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        s = await SettingsRepository(user_a, conn).get_settings()
    assert s.notify_new_cards is False
    assert s.notify_permission_prompted_at is None


@pytest.mark.asyncio
async def test_settings_default_permission_mode_ask(pool, user_ids):
    """permission_mode defaults to 'ask': a fresh user keeps the HITL approval
    gate on side-effect tools until they explicitly switch to 'bypass'."""
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        s = await SettingsRepository(user_a, conn).get_settings()
    assert s.permission_mode == "ask"


@pytest.mark.asyncio
async def test_settings_permission_mode_round_trip(pool, user_ids):
    """Switching permission_mode persists; an unrelated upsert (None param)
    preserves it via COALESCE so editing another setting can't silently
    change the mode."""
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        on = await SettingsRepository(user_a, conn).upsert_settings(permission_mode="bypass")
    assert on.permission_mode == "bypass"

    async with user_scoped_tx(pool, user_a) as conn:
        # An unrelated edit must NOT change permission_mode (COALESCE).
        preserved = await SettingsRepository(user_a, conn).upsert_settings(generation_language="en")
    assert preserved.permission_mode == "bypass"

    async with user_scoped_tx(pool, user_a) as conn:
        off = await SettingsRepository(user_a, conn).upsert_settings(permission_mode="ask")
    assert off.permission_mode == "ask"


@pytest.mark.asyncio
async def test_settings_notify_prompt_stamp_is_monotonic(pool, user_ids):
    """First write stamps notify_permission_prompted_at. A subsequent
    upsert that doesn't touch the field (None param) must preserve the
    earlier timestamp — the column is one-shot and the home screen's
    gate keys off "is this NULL or not"."""
    user_a, _ = user_ids
    stamp = datetime.now(UTC)
    async with user_scoped_tx(pool, user_a) as conn:
        repo = SettingsRepository(user_a, conn)
        first = await repo.upsert_settings(
            notify_new_cards=True,
            notify_permission_prompted_at=stamp,
        )
    assert first.notify_new_cards is True
    assert first.notify_permission_prompted_at is not None

    async with user_scoped_tx(pool, user_a) as conn:
        repo = SettingsRepository(user_a, conn)
        # Toggle off later from Account → Notifications; the stamp
        # must NOT reset to NULL even though we didn't pass it.
        second = await repo.upsert_settings(notify_new_cards=False)
    assert second.notify_new_cards is False
    assert second.notify_permission_prompted_at == first.notify_permission_prompted_at


@pytest.mark.asyncio
async def test_settings_isolated_across_users(pool, user_ids):
    """User A's settings (here a non-default timezone) are invisible to
    user B — B's RLS-scoped lazy-create returns column defaults."""
    user_a, user_b = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        await SettingsRepository(user_a, conn).upsert_settings(timezone="Asia/Shanghai")
    async with user_scoped_tx(pool, user_b) as conn:
        b_settings = await SettingsRepository(user_b, conn).get_settings()
    assert b_settings.timezone == "UTC"
