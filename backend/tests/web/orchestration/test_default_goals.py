"""Onboarding starter-goal seeding into the L2 GOALS portrait slot.

`seed_default_goals` runs when a brand-new users row is first INSERTed
(user_service.upsert_user_by_supabase_id). It seeds `_STARTER_GOALS` into
the `pai_user_strings` GOALS slot (markdown) — but only when the slot is
empty, so a re-login / already-populated user is a no-op.
"""

from __future__ import annotations

import pytest
from pinai_api.domains.memory.portrait.repository import EditOp, UserStringsRepository
from pinai_api.domains.memory.portrait.seed import _STARTER_GOALS, seed_default_goals
from pinai_db.rls import user_scoped_tx


async def _read_goals(pool, user_id: int) -> str:
    async with user_scoped_tx(pool, user_id) as conn:
        content, _version = await UserStringsRepository(user_id, conn).get_slot("GOALS")
    return content


@pytest.mark.asyncio
async def test_seed_populates_empty_goals_slot(pool, user_ids):
    """Fresh user (empty GOALS slot) → all starter goals land in the markdown."""
    user_a, _ = user_ids
    await seed_default_goals(pool, user_a)
    content = await _read_goals(pool, user_a)
    assert content.strip()
    for goal in _STARTER_GOALS:
        assert goal in content


@pytest.mark.asyncio
async def test_seed_is_idempotent(pool, user_ids):
    """Re-running the seed (e.g. re-login re-runs onboarding) is a no-op —
    each starter goal appears exactly once, content unchanged."""
    user_a, _ = user_ids
    await seed_default_goals(pool, user_a)
    first = await _read_goals(pool, user_a)
    await seed_default_goals(pool, user_a)
    second = await _read_goals(pool, user_a)
    assert first == second
    for goal in _STARTER_GOALS:
        assert second.count(goal) == 1


@pytest.mark.asyncio
async def test_seed_skips_when_user_already_stated_goals(pool, user_ids):
    """If the user/agent already put a goal in the GOALS slot, the seed must
    NOT overwrite or append starter goals — the user's own goal stands alone."""
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        await UserStringsRepository(user_a, conn).edit(
            "GOALS", operations=[EditOp(op="add", text="Run a sub-3 marathon")]
        )
    await seed_default_goals(pool, user_a)
    content = await _read_goals(pool, user_a)
    assert "Run a sub-3 marathon" in content
    for goal in _STARTER_GOALS:
        assert goal not in content


@pytest.mark.asyncio
async def test_seed_is_user_scoped(pool, user_ids):
    """Seeding user A's GOALS leaves user B's slot empty (RLS isolation)."""
    user_a, user_b = user_ids
    await seed_default_goals(pool, user_a)
    assert not (await _read_goals(pool, user_b)).strip()
