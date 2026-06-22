"""PreferenceRepository — add / list / supersede / archive + RLS.

Mirrors the memory-repo state-machine tests: a preference goes
active → superseded (linked) or active → archived, and supersede asserts
the new row is already active before touching the old one. RLS isolation
is verified by writing under user A and reading under user B in a
separate user_scoped_tx.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from pinai_api.domains.user_model.preferences import (
    AddPreferenceInput,
    PreferenceRepository,
)
from pinai_db.rls import user_scoped_tx

pytestmark = pytest.mark.asyncio


def _input(
    pref_id: str,
    *,
    scope: str = "topic",
    polarity: str = "positive",
    source: str = "user",
    weight: float = 1.0,
    durability: str = "persistent",
    expires_at: datetime | None = None,
) -> AddPreferenceInput:
    return AddPreferenceInput(
        id=pref_id,
        statement="Wants more A-share market news",
        scope=scope,
        polarity=polarity,
        weight=weight,
        confidence=0.8,
        source=source,
        evidence={"card_id": "card_x"},
        durability=durability,
        expires_at=expires_at,
    )


async def test_add_then_list_active_roundtrip(pool, user_ids):
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        repo = PreferenceRepository(user_a, conn)
        await repo.add(
            _input("pref_a1", scope="topic", polarity="positive", source="user", weight=1.0)
        )
        rows = await repo.list(status="active")

    assert len(rows) == 1
    row = rows[0]
    assert row.id == "pref_a1"
    assert row.statement == "Wants more A-share market news"
    assert row.scope == "topic"
    assert row.polarity == "positive"
    assert row.source == "user"
    assert row.weight == 1.0
    assert row.confidence == 0.8
    assert row.durability == "persistent"
    assert row.expires_at is None
    assert row.status == "active"
    assert row.evidence == {"card_id": "card_x"}


async def test_list_scope_filter(pool, user_ids):
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        repo = PreferenceRepository(user_a, conn)
        await repo.add(_input("pref_topic", scope="topic"))
        await repo.add(_input("pref_timing", scope="timing"))

        topic_only = await repo.list(status="active", scope="topic")
        assert {r.id for r in topic_only} == {"pref_topic"}

        all_active = await repo.list(status="active")
        assert {r.id for r in all_active} == {"pref_topic", "pref_timing"}


async def test_list_active_omits_expired_temporary_preferences(pool, user_ids):
    user_a, _ = user_ids
    now = datetime.now(tz=UTC)
    async with user_scoped_tx(pool, user_a) as conn:
        repo = PreferenceRepository(user_a, conn)
        await repo.add(
            _input(
                "pref_expired",
                durability="temporary",
                expires_at=now - timedelta(hours=1),
            )
        )
        await repo.add(
            _input(
                "pref_current",
                durability="temporary",
                expires_at=now + timedelta(hours=1),
            )
        )

        active = await repo.list(status="active")

    assert {r.id for r in active} == {"pref_current"}
    assert active[0].durability == "temporary"
    assert active[0].expires_at is not None


async def test_supersede_links_old_to_new(pool, user_ids):
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        repo = PreferenceRepository(user_a, conn)
        await repo.add(_input("pref_old"))
        await repo.add(_input("pref_new"))

        old = await repo.supersede(old_id="pref_old", new_id="pref_new")
        assert old is not None
        assert old.status == "superseded"
        assert old.superseded_by == "pref_new"

        active = await repo.list(status="active")
        assert {r.id for r in active} == {"pref_new"}
        superseded = await repo.list(status="superseded")
        assert {r.id for r in superseded} == {"pref_old"}


async def test_supersede_requires_new_active(pool, user_ids):
    """new_id must already be an active preference — supersede against a
    non-existent / non-active target raises, never silently links."""
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        repo = PreferenceRepository(user_a, conn)
        await repo.add(_input("pref_only"))
        with pytest.raises(ValueError, match="must be an active preference"):
            await repo.supersede(old_id="pref_only", new_id="pref_missing")


async def test_archive(pool, user_ids):
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        repo = PreferenceRepository(user_a, conn)
        await repo.add(_input("pref_arch"))
        archived = await repo.archive("pref_arch")
        assert archived is not None
        assert archived.status == "archived"
        assert await repo.list(status="active") == []


async def test_rls_isolation_between_users(pool, user_ids):
    """User A's preference is invisible to user B."""
    user_a, user_b = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        await PreferenceRepository(user_a, conn).add(_input("pref_a_secret"))

    async with user_scoped_tx(pool, user_b) as conn:
        rows = await PreferenceRepository(user_b, conn).list(status="active")
    assert rows == []
