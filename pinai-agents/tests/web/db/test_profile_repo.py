"""ProfileRepository — covers profile + goals + user_settings.

Profile / goals / settings are 3 distinct tables sharing one Repository
because the common access pattern is "snapshot for this user". Tests
each surface independently + the cross-user isolation invariant.
"""

from __future__ import annotations

import pytest

from pinai_agents.web.db.repositories.profile import ProfileRepository
from pinai_agents.web.db.rls import user_scoped_tx


@pytest.mark.asyncio
async def test_profile_upsert_idempotent(pool, user_ids):
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        repo = ProfileRepository(user_a, conn)
        first = await repo.upsert_profile(
            id="primary", display_name="Alice",
            facts={"role": "engineer"},
        )
    assert first.display_name == "Alice"

    # Re-upsert overwrites display_name and merges facts on top.
    async with user_scoped_tx(pool, user_a) as conn:
        repo = ProfileRepository(user_a, conn)
        second = await repo.upsert_profile(
            id="primary", display_name="Alice 2.0",
            facts={"role": "engineer", "team": "ai"},
        )
    assert second.display_name == "Alice 2.0"
    assert second.facts.get("team") == "ai"


@pytest.mark.asyncio
async def test_profile_partial_upsert_preserves_existing_fields(pool, user_ids):
    """Single-field upsert must not clobber unrelated fields. Mirrors the
    `upsert_settings` partial semantics — needed so the agent's
    `profile_upsert` tool can patch one attribute without round-tripping
    the rest of the row."""
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        repo = ProfileRepository(user_a, conn)
        await repo.upsert_profile(
            display_name="Alice", locale="zh-Hans", timezone="Asia/Shanghai",
            summary="builds AI agents",
            facts={"role": "founder"},
            preferences={"comm": "terse"},
        )

    # Patch only summary; everything else must stay.
    async with user_scoped_tx(pool, user_a) as conn:
        repo = ProfileRepository(user_a, conn)
        patched = await repo.upsert_profile(summary="builds Pin AI")
    assert patched.summary == "builds Pin AI"
    assert patched.display_name == "Alice"
    assert patched.locale == "zh-Hans"
    assert patched.timezone == "Asia/Shanghai"
    assert patched.facts == {"role": "founder"}
    assert patched.preferences == {"comm": "terse"}

    # Empty repo call (no fields) is a touch — bumps updated_at without
    # changing any value.
    async with user_scoped_tx(pool, user_a) as conn:
        repo = ProfileRepository(user_a, conn)
        touched = await repo.upsert_profile()
    assert touched.summary == "builds Pin AI"
    assert touched.display_name == "Alice"


@pytest.mark.asyncio
async def test_goals_upsert_and_close(pool, user_ids):
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        repo = ProfileRepository(user_a, conn)
        await repo.upsert_goal(id="g1", key="ship-mvp", title="Ship MVP")
        await repo.upsert_goal(id="g2", key="hire-eng", title="Hire engineer", priority="high")

    async with user_scoped_tx(pool, user_a) as conn:
        repo = ProfileRepository(user_a, conn)
        active = await repo.list_goals(status="active")
        assert {g.id for g in active} == {"g1", "g2"}

        ok = await repo.close_goal("g1")
        assert ok is True
        # Closing twice is a no-op.
        again = await repo.close_goal("g1")
        assert again is False

    async with user_scoped_tx(pool, user_a) as conn:
        repo = ProfileRepository(user_a, conn)
        active = await repo.list_goals(status="active")
        assert {g.id for g in active} == {"g2"}


@pytest.mark.asyncio
async def test_goal_upsert_collapses_on_duplicate_key(pool, user_ids):
    """Two upserts with the same `key` but different surrogate ids must
    collapse to one row, returning the existing id. This is the bug a
    chat-agent `goal_upsert(key=...)` call hits when the LLM doesn't
    know about a previously-seeded goal: caller supplies a fresh random
    id, the (user_id, key) UNIQUE collides, and the route used to 500.
    Conflict-on-key resolves it to "edit the row identified by key"."""
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        repo = ProfileRepository(user_a, conn)
        first = await repo.upsert_goal(
            id="goal_seed_xyz", key="sub3-marathon",
            title="Run sub-3 marathon by Q4 2026", priority="high",
        )
    assert first.id == "goal_seed_xyz"

    # Second caller doesn't know about goal_seed_xyz; supplies a new id.
    async with user_scoped_tx(pool, user_a) as conn:
        repo = ProfileRepository(user_a, conn)
        second = await repo.upsert_goal(
            id="goal_brand_new", key="sub3-marathon",
            title="Run sub-3 marathon by Q4 2026 (revised note)",
            priority="high",
        )
    # Existing row wins — id stays as the original surrogate.
    assert second.id == "goal_seed_xyz"
    assert second.title.endswith("(revised note)")

    # And there's still exactly one row for this key.
    async with user_scoped_tx(pool, user_a) as conn:
        repo = ProfileRepository(user_a, conn)
        actives = await repo.list_goals(status="active")
    keys = [g.key for g in actives]
    assert keys.count("sub3-marathon") == 1


@pytest.mark.asyncio
async def test_settings_upsert_partial_fields(pool, user_ids):
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        repo = ProfileRepository(user_a, conn)
        s1 = await repo.upsert_settings(generation_language="zh-Hans")
    assert s1.generation_language == "zh-Hans"
    assert s1.auto_generate is False  # default
    assert s1.auto_crystallize is True  # default

    # Toggle just auto_generate; other fields should stay put.
    async with user_scoped_tx(pool, user_a) as conn:
        repo = ProfileRepository(user_a, conn)
        s2 = await repo.upsert_settings(auto_generate=True)
    assert s2.auto_generate is True
    assert s2.generation_language == "zh-Hans"  # preserved
    assert s2.auto_crystallize is True  # preserved


@pytest.mark.asyncio
async def test_profile_isolated_across_users(pool, user_ids):
    user_a, user_b = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        await ProfileRepository(user_a, conn).upsert_profile(
            id="primary", display_name="Alice",
        )
    async with user_scoped_tx(pool, user_b) as conn:
        repo_b = ProfileRepository(user_b, conn)
        # B's RLS view shows nothing of A's profile
        b_profile = await repo_b.get_profile()
        assert b_profile is None
