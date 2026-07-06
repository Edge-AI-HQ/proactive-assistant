"""Onboarding portrait-default seeding (IDENTITY/SOUL persona + starter GOALS).

`seed_portrait_defaults` runs when a brand-new users row is first INSERTed
(user_service.upsert_user_by_supabase_id). It seeds the persona baseline into
IDENTITY/SOUL and `_STARTER_GOALS` into GOALS — per-slot idempotent (a slot
that already has content is left alone) and it never touches USER/TOOLS (they
hold what the agent learns about this specific user; nothing truthful to seed
at first touch).
"""

from __future__ import annotations

import pytest
from pinai_api.domains.memory.portrait.repository import EditOp, UserStringsRepository
from pinai_api.domains.memory.portrait.seed import (
    _IDENTITY_SEED,
    _SOUL_SEED,
    _STARTER_GOALS,
    seed_portrait_defaults,
)
from pinai_db.rls import user_scoped_tx

_SEEDED_SLOTS = (
    ("IDENTITY", _IDENTITY_SEED),
    ("SOUL", _SOUL_SEED),
    ("GOALS", _STARTER_GOALS),
)


async def _read_slot(pool, user_id: int, slot: str) -> str:
    async with user_scoped_tx(pool, user_id) as conn:
        content, _version = await UserStringsRepository(user_id, conn).get_slot(slot)
    return content


@pytest.mark.asyncio
async def test_seed_populates_persona_and_goals(pool, user_ids):
    """Fresh user → IDENTITY/SOUL baseline + starter goals land; USER/TOOLS
    stay empty by design."""
    user_a, _ = user_ids
    await seed_portrait_defaults(pool, user_a)
    for slot, entries in _SEEDED_SLOTS:
        content = await _read_slot(pool, user_a, slot)
        for entry in entries:
            assert entry in content
    assert not (await _read_slot(pool, user_a, "USER")).strip()
    assert not (await _read_slot(pool, user_a, "TOOLS")).strip()


@pytest.mark.asyncio
async def test_seed_is_idempotent(pool, user_ids):
    """Re-running the seed (e.g. re-login re-runs onboarding) is a no-op —
    each default entry appears exactly once, content unchanged."""
    user_a, _ = user_ids
    await seed_portrait_defaults(pool, user_a)
    first = {slot: await _read_slot(pool, user_a, slot) for slot, _ in _SEEDED_SLOTS}
    await seed_portrait_defaults(pool, user_a)
    for slot, entries in _SEEDED_SLOTS:
        second = await _read_slot(pool, user_a, slot)
        assert second == first[slot]
        for entry in entries:
            assert second.count(entry) == 1


@pytest.mark.asyncio
async def test_seed_is_per_slot_idempotent(pool, user_ids):
    """A slot the user/agent already wrote is left alone (their content stands
    alone, no starter entries appended) — but the OTHER empty slots still get
    their defaults."""
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        await UserStringsRepository(user_a, conn).edit(
            "GOALS", operations=[EditOp(op="add", text="Run a sub-3 marathon")]
        )
    await seed_portrait_defaults(pool, user_a)
    goals = await _read_slot(pool, user_a, "GOALS")
    assert "Run a sub-3 marathon" in goals
    for goal in _STARTER_GOALS:
        assert goal not in goals
    for slot, entries in (("IDENTITY", _IDENTITY_SEED), ("SOUL", _SOUL_SEED)):
        content = await _read_slot(pool, user_a, slot)
        for entry in entries:
            assert entry in content


@pytest.mark.asyncio
async def test_seed_is_user_scoped(pool, user_ids):
    """Seeding user A leaves user B's slots empty (RLS isolation)."""
    user_a, user_b = user_ids
    await seed_portrait_defaults(pool, user_a)
    for slot, _ in _SEEDED_SLOTS:
        assert not (await _read_slot(pool, user_b, slot)).strip()
