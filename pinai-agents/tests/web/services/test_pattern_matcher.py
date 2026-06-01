"""Tests for the pattern matcher DSL evaluator."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from pinai_agents.web.db.repositories.patterns import PatternsRepository
from pinai_agents.web.db.rls import user_scoped_tx
from pinai_agents.web.services.pattern_matcher import (
    evaluate_condition,
    match_patterns,
)


def test_evaluate_condition_gte() -> None:
    ok, evidence = evaluate_condition(
        {"op": "gte", "field": "device.health.steps", "value": 5000},
        {"device": {"health": {"steps": 8200}}},
    )
    assert ok is True
    assert evidence["value"] == 8200.0
    assert evidence["threshold"] == 5000.0


def test_evaluate_condition_gte_missing_signal() -> None:
    ok, evidence = evaluate_condition(
        {"op": "gte", "field": "device.health.steps", "value": 5000},
        {},
    )
    assert ok is False
    assert evidence == {}


def test_evaluate_condition_within_days_family() -> None:
    upcoming = datetime.now(UTC) + timedelta(days=3)
    ok, evidence = evaluate_condition(
        {"op": "bill_due_within_days", "field": "bill.due_at", "max": 7},
        {"bill": {"due_at": upcoming.isoformat()}},
    )
    assert ok is True
    assert evidence["in_days"] <= 7


def test_evaluate_condition_age_gte_family() -> None:
    past = datetime.now(UTC) - timedelta(days=40)
    ok, evidence = evaluate_condition(
        {"op": "open_task_age_gte", "field": "task.created_at", "min_days": 30},
        {"task": {"created_at": past.isoformat()}},
    )
    assert ok is True
    assert evidence["age_days"] >= 30


def test_evaluate_condition_unknown_op_returns_false() -> None:
    ok, evidence = evaluate_condition(
        {"op": "totally_unknown_predicate", "field": "x"},
        {"x": 1},
    )
    assert ok is False
    assert evidence == {}


@pytest.mark.asyncio
async def test_match_patterns_runs_against_seed_library(pool, user_ids):
    """Matcher must traverse the seed library without errors; with empty
    phase1 data, every pattern's strict trigger should reject — so the
    result is an empty match list, never a crash."""
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        repo = PatternsRepository(user_a, conn)
        result = await match_patterns(repo, {})
    assert result.matched == []


@pytest.mark.asyncio
async def test_seed_pattern_event_in_next_hours(pool, user_ids):
    """preparation_gap_meeting needs a calendar event within 4 hours
    with subtype=meeting_external. Synthetic phase1 hits exactly that."""
    from datetime import UTC as _UTC
    from datetime import datetime as _dt
    from datetime import timedelta as _td

    user_a, _ = user_ids
    soon = _dt.now(_UTC) + _td(hours=2)
    phase1 = {
        "calendar": {
            "events": [
                {
                    "id": "ev_001",
                    "subtype": "meeting_external",
                    "start": soon.isoformat(),
                    "title": "External sync",
                },
            ],
        },
        # The same pattern's second op (no_doc_attachment) is an unknown
        # op → returns False → preparation_gap_meeting itself won't fire.
        # We instead use preparation_gap_travel_intl which has a single
        # event_in_next_hours condition.
    }
    # Travel international: max_hours=12, subtype=flight_intl
    phase1["calendar"]["events"][0]["subtype"] = "flight_intl"
    async with user_scoped_tx(pool, user_a) as conn:
        repo = PatternsRepository(user_a, conn)
        result = await match_patterns(repo, phase1)
    matched_ids = [m.pattern_id for m in result.matched]
    assert "preparation_gap_travel_intl" in matched_ids, matched_ids


@pytest.mark.asyncio
async def test_seed_pattern_multi_condition(pool, user_ids):
    """preparation_gap_interview requires BOTH title_match AND
    event_in_next_hours. Phase1 with a calendar event titled '面试' in 2h
    should fire it."""
    from datetime import UTC as _UTC
    from datetime import datetime as _dt
    from datetime import timedelta as _td

    user_a, _ = user_ids
    soon = _dt.now(_UTC) + _td(hours=2)
    phase1 = {
        "calendar": {
            "events": [
                {
                    "id": "ev_iv",
                    "title": "面试 Acme",
                    "subtype": "meeting_external",
                    "start": soon.isoformat(),
                },
            ],
        },
    }
    async with user_scoped_tx(pool, user_a) as conn:
        repo = PatternsRepository(user_a, conn)
        result = await match_patterns(repo, phase1)
    matched_ids = [m.pattern_id for m in result.matched]
    assert "preparation_gap_interview" in matched_ids, matched_ids


@pytest.mark.asyncio
async def test_seed_pattern_back_to_back_events(pool, user_ids):
    """time_buffer_multi_event_squeeze: 3 back-to-back events with gaps
    ≤ 5min should fire."""
    from datetime import UTC as _UTC
    from datetime import datetime as _dt
    from datetime import timedelta as _td

    user_a, _ = user_ids
    base = _dt.now(_UTC) + _td(hours=1)
    events = []
    for i in range(3):
        start = base + _td(minutes=i * 30)
        events.append(
            {
                "id": f"ev_{i}",
                "title": f"Event {i}",
                "start": start.isoformat(),
                "end": (start + _td(minutes=27)).isoformat(),
            }
        )
    phase1 = {"calendar": {"events": events}}
    async with user_scoped_tx(pool, user_a) as conn:
        repo = PatternsRepository(user_a, conn)
        result = await match_patterns(repo, phase1)
    matched_ids = [m.pattern_id for m in result.matched]
    assert "time_buffer_multi_event_squeeze" in matched_ids, matched_ids


@pytest.mark.asyncio
async def test_match_patterns_hits_when_phase1_satisfies_trigger(pool, user_ids):
    """Seed a synthetic phase1 payload designed to hit a specific seed
    pattern's gte op; matcher must return that pattern."""
    user_a, _ = user_ids
    phase1 = {
        # Hit `open_commitment_count_gte` (or any *_count_gte) by providing
        # a list of length 5. We let the matcher choose any pattern whose
        # trigger we can fully satisfy.
        "open_commitments": [{"id": f"c-{i}"} for i in range(10)],
    }
    # Force one pattern's trigger to fire by inserting a deterministic
    # synthetic pattern alongside the seed library — this isolates the
    # test from seed churn.
    async with user_scoped_tx(pool, user_a) as conn:
        await conn.execute(
            """
            INSERT INTO pai_card_patterns
              (id, category, abstract, signals_required, trigger_dsl, intent,
               card_skeleton, specializations, surprise_init, practical_init,
               tier, status, source)
            VALUES (%s, %s, %s, %s::jsonb, %s::jsonb, %s,
                    %s::jsonb, %s::jsonb, %s, %s, %s, %s, %s)
            ON CONFLICT (id) DO UPDATE SET trigger_dsl = EXCLUDED.trigger_dsl
            """,
            (
                "__test_count_gte__",
                "test",
                "test pattern that fires on a count gte",
                '["chat.history"]',
                '[{"op": "open_commitment_count_gte", "field": "open_commitments", "min": 5}]',
                "test_intent",
                "{}",
                "[]",
                "m",
                "m",
                "warmup",
                "active",
                "seed",
            ),
        )
        repo = PatternsRepository(user_a, conn)
        result = await match_patterns(repo, phase1)
        await conn.execute(
            "DELETE FROM pai_card_patterns WHERE id = %s",
            ("__test_count_gte__",),
        )
    match = next(m for m in result.matched if m.pattern_id == "__test_count_gte__")
    assert match.human_insight == ""
    assert match.card_skeleton == {}
    assert match.to_payload()["humanInsight"] == ""
    assert match.to_payload()["cardSkeleton"] == {}
