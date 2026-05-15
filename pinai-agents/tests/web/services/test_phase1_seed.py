"""Phase1 seed collector — must not crash on empty/missing data."""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta

import pytest

from pinai_agents.web.db.repositories.patterns import PatternsRepository
from pinai_agents.web.db.rls import service_tx, user_scoped_tx
from pinai_agents.web.services.pattern_matcher import match_patterns
from pinai_agents.web.services.phase1_seed import build_phase1_seed


@pytest.mark.asyncio
async def test_phase1_seed_empty_user(pool, user_ids) -> None:
    """A user with no signals / memory / calendar still gets a well-shaped
    phase1 — no exception, all expected sub-keys present."""
    user_a, _ = user_ids
    async with service_tx(pool) as conn:
        phase1 = await build_phase1_seed(conn, user_a)
    assert set(phase1.keys()) == {
        "personal_signals",
        "memory",
        "world",
        "calendar",
        "gmail",
        "profile",
    }
    assert phase1["calendar"]["events"] == []
    assert phase1["memory"]["recurring_obligations"] == []
    assert phase1["gmail"]["unresponded_to_vip"] == []


@pytest.mark.asyncio
async def test_phase1_seed_picks_up_calendar_event(pool, user_ids) -> None:
    """Inserting a calendar signal turns up in phase1.calendar.events."""
    user_a, _ = user_ids
    soon = datetime.now(UTC) + timedelta(hours=3)
    payload = json.dumps({"subtype": "flight_intl", "destination": "NRT"})
    async with user_scoped_tx(pool, user_a) as conn:
        await conn.execute(
            """
            INSERT INTO pai_personal_signals
              (user_id, id, kind, title, summary, payload,
               salience, confidence, occurred_at, available_at, source, status)
            VALUES (%s, %s, 'calendar.event', 'Flight to NRT', 'NRT 21:00',
                    %s::jsonb, 0.8, 0.9, %s, NOW(), 'calendar', 'open')
            """,
            (user_a, "test_phase1_cal_1", payload, soon),
        )
    try:
        async with service_tx(pool) as conn:
            phase1 = await build_phase1_seed(conn, user_a)
        events = phase1["calendar"]["events"]
        assert len(events) == 1
        ev = events[0]
        assert ev["subtype"] == "flight_intl"
        # And the matcher actually fires preparation_gap_travel_intl.
        async with user_scoped_tx(pool, user_a) as conn:
            repo = PatternsRepository(user_a, conn)
            result = await match_patterns(repo, phase1)
        ids = [m.pattern_id for m in result.matched]
        assert "preparation_gap_travel_intl" in ids, ids
    finally:
        async with user_scoped_tx(pool, user_a) as conn:
            await conn.execute(
                "DELETE FROM pai_personal_signals WHERE user_id = %s AND id = %s",
                (user_a, "test_phase1_cal_1"),
            )
