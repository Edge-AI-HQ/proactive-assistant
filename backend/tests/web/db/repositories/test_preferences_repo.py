"""Preference events on EventsRepository — append / search / supersede + RLS.

Preferences are now `event_type='preference'` rows in pai_events (the legacy
pai_preference_records table + the /api/agent/preferences route are both retired
— preference writes fold into event_append). This locks the event-layer
behaviour they rely on: an active preference event is visible to
search_structured(event_type='preference'), supersede asserts the new row is an
active preference before linking the old one (active → archived with a
superseded_by_id back-pointer), and RLS isolates users.
"""

from __future__ import annotations

from datetime import UTC, datetime

import pytest
from pinai_api.domains.memory.events.repository import AppendEventInput, EventsRepository
from pinai_db.rls import user_scoped_tx

pytestmark = pytest.mark.asyncio


def _pref(
    pref_id: str,
    *,
    scope: str = "topic",
    polarity: str = "positive",
    source: str = "user",
    weight: float = 1.0,
    durability: str = "persistent",
    expires_at: datetime | None = None,
) -> AppendEventInput:
    return AppendEventInput(
        id=pref_id,
        source=source,
        event_type="preference",
        occurred_at=datetime.now(tz=UTC),
        title="Wants more A-share market news",
        structured={
            "scope": scope,
            "polarity": polarity,
            "weight": weight,
            "confidence": 0.8,
            "durability": durability,
            "expires_at": expires_at.isoformat() if expires_at is not None else None,
            "card_id": "card_x",
        },
        curated=True,
        dedupe_key=pref_id,
    )


async def test_append_then_search_active_roundtrip(pool, user_ids):
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        repo = EventsRepository(user_a, conn)
        await repo.append(_pref("pref_a1", scope="topic", polarity="positive", weight=1.0))
        rows = await repo.search_structured(event_type="preference", status="active")

    assert len(rows) == 1
    row = rows[0]
    assert row.id == "pref_a1"
    assert row.title == "Wants more A-share market news"
    assert row.event_type == "preference"
    assert row.source == "user"
    assert row.curated_at is not None  # _pref lands curated (curated=True)
    assert row.structured["scope"] == "topic"
    assert row.structured["polarity"] == "positive"
    assert row.structured["weight"] == 1.0
    assert row.structured["confidence"] == 0.8
    assert row.structured["durability"] == "persistent"
    assert row.structured["card_id"] == "card_x"


async def test_search_only_returns_preference_events(pool, user_ids):
    """A non-preference event is invisible to the preference-typed search."""
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        repo = EventsRepository(user_a, conn)
        await repo.append(_pref("pref_topic", scope="topic"))
        await repo.append(
            AppendEventInput(
                id="evt_meeting",
                source="composio",
                event_type="meeting",
                occurred_at=datetime.now(tz=UTC),
                title="Standup",
                curated=True,
                dedupe_key="evt_meeting",
            )
        )
        prefs = await repo.search_structured(event_type="preference", status="active")

    assert {r.id for r in prefs} == {"pref_topic"}


async def test_supersede_links_old_to_new(pool, user_ids):
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        repo = EventsRepository(user_a, conn)
        await repo.append(_pref("pref_old"))
        await repo.append(_pref("pref_new"))

        old = await repo.supersede(old_id="pref_old", new_id="pref_new", event_type="preference")
        assert old is not None
        assert old.superseded_by_id == "pref_new"  # supersede chain expresses "archived"

        # active = current versions only (superseded_by_id IS NULL): the old row
        # is gone from active because it's superseded. (There's no "archived"
        # status anymore — the supersede chain is the archive.)
        active = await repo.search_structured(event_type="preference", status="active")
        assert {r.id for r in active} == {"pref_new"}
        gone = await repo.get("pref_old")
        assert gone is not None and gone.superseded_by_id == "pref_new"


async def test_supersede_requires_new_current(pool, user_ids):
    """new_id must already be a current (not-yet-superseded) preference event —
    supersede against a non-existent / superseded target raises, never silently
    links."""
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        repo = EventsRepository(user_a, conn)
        await repo.append(_pref("pref_only"))
        with pytest.raises(ValueError, match="must be a current preference"):
            await repo.supersede(old_id="pref_only", new_id="pref_missing", event_type="preference")


async def test_rls_isolation_between_users(pool, user_ids):
    """User A's preference event is invisible to user B."""
    user_a, user_b = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        await EventsRepository(user_a, conn).append(_pref("pref_a_secret"))

    async with user_scoped_tx(pool, user_b) as conn:
        rows = await EventsRepository(user_b, conn).search_structured(
            event_type="preference", status="active"
        )
    assert rows == []
