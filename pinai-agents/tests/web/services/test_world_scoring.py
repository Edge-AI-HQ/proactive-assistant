"""Unit tests for compute_salience — the pure scoring formula.

DB-bound integration of score_for_active_users is exercised by the
e2e test that runs a full ingest cycle against the live DB.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from pinai_agents.web.services.world_scoring import (
    _jaccard,
    _slug_tokens,
    _user_topic_set,
    compute_salience,
)


# ── _slug_tokens ───────────────────────────────────────────────────


def test_slug_tokens_kebab_case():
    assert _slug_tokens("sub3-marathon") == {"sub3", "marathon"}


def test_slug_tokens_strips_stopwords():
    out = _slug_tokens("the rate of inflation in the US")
    assert "the" not in out
    assert "of" not in out
    assert "in" not in out
    assert {"rate", "inflation", "us"} <= out


def test_slug_tokens_min_length():
    """1-char tokens dropped as noise."""
    out = _slug_tokens("a B c def")
    assert out == {"def"}


def test_slug_tokens_handles_none():
    assert _slug_tokens(None) == set()
    assert _slug_tokens("") == set()


# ── _jaccard ───────────────────────────────────────────────────────


def test_jaccard_identical():
    assert _jaccard({"a", "b"}, {"a", "b"}) == 1.0


def test_jaccard_disjoint():
    assert _jaccard({"a"}, {"b"}) == 0.0


def test_jaccard_partial():
    # |intersection|=1, |union|=3 → 1/3
    assert _jaccard({"a", "b"}, {"a", "c"}) == pytest.approx(1 / 3)


def test_jaccard_empty():
    assert _jaccard(set(), {"a"}) == 0.0
    assert _jaccard({"a"}, set()) == 0.0


# ── _user_topic_set ────────────────────────────────────────────────


def test_user_topics_combines_three_sources():
    profile = {"preferences": {"topics": ["AI agents"]}}
    goals = [{"key": "ship-pin-v2", "title": "Ship Pin AI v2 by Q4"}]
    cards = [{"goalBasket": "wealth", "intentKey": "openai-budget-cap",
              "sources": ["signal id=sig_x, title=OpenAI billing"]}]
    out = _user_topic_set(profile, goals, cards)
    # Profile contributes 'ai', 'agents'
    assert {"ai", "agents"} <= out
    # Goals contribute 'ship', 'pin', 'v2', 'q4'
    assert "ship" in out
    assert "v2" in out
    # Cards contribute 'wealth', 'openai', 'budget', 'cap', 'billing'
    assert "wealth" in out
    assert "openai" in out


def test_user_topics_handles_string_jsonb():
    """psycopg can hand back JSONB as a JSON string depending on cursor
    config. The function must tolerate both."""
    import json
    profile = {"preferences": json.dumps({"topics": ["health", "fitness"]})}
    out = _user_topic_set(profile, [], [])
    assert {"health", "fitness"} <= out


def test_user_topics_handles_none_profile():
    out = _user_topic_set(None, [], [])
    assert out == set()


# ── compute_salience ──────────────────────────────────────────────


def test_salience_high_match_high_importance_recent():
    """Strong match in topics + high importance + just-published →
    salience near 1.0."""
    now = datetime.now(UTC)
    sal, reason = compute_salience(
        signal_topics=["finance", "regulation"],
        signal_regions=["us"],
        signal_importance="high",
        signal_published_at=now - timedelta(hours=1),
        user_topics={"finance", "regulation", "us"},
        now=now,
    )
    # topic_match=1.0 (subset/equal), importance=0.6, recency≈1.0
    # salience = 0.4*1 + 0.4*0.6 + 0.2*≈1 ≈ 0.84
    assert 0.7 < sal <= 1.0
    assert "topic_match=1.00" in reason


def test_salience_no_match_medium_old():
    """Zero topic overlap + medium importance + 200h old → low salience."""
    now = datetime.now(UTC)
    sal, _ = compute_salience(
        signal_topics=["sports"],
        signal_regions=[],
        signal_importance="medium",
        signal_published_at=now - timedelta(hours=200),  # > 168h cutoff
        user_topics={"finance", "ai"},
        now=now,
    )
    # topic_match=0, importance=0.3, recency=0 → 0.4*0 + 0.4*0.3 + 0.2*0 = 0.12
    assert sal == pytest.approx(0.12)


def test_salience_clipped_to_unit_interval():
    """Even with everything maxed, salience can't exceed 1.0."""
    sal, _ = compute_salience(
        signal_topics=["ai"], signal_regions=[],
        signal_importance="high",
        signal_published_at=datetime.now(UTC),
        user_topics={"ai"},
    )
    assert 0 <= sal <= 1.0


def test_salience_naive_published_at_treated_as_utc():
    """Tolerate naive datetime → UTC. Otherwise psycopg's tz-naive
    rows from older migrations would crash the formula."""
    naive = datetime(2026, 5, 6, 12, 0, 0)  # no tzinfo
    sal, _ = compute_salience(
        signal_topics=["ai"], signal_regions=[],
        signal_importance="high",
        signal_published_at=naive,
        user_topics={"ai"},
        now=datetime(2026, 5, 6, 13, 0, 0, tzinfo=UTC),
    )
    # Should compute a sensible value, not crash.
    assert 0 <= sal <= 1.0


def test_salience_no_published_at_zero_recency():
    sal, reason = compute_salience(
        signal_topics=["ai"], signal_regions=[],
        signal_importance="high",
        signal_published_at=None,
        user_topics={"ai"},
    )
    # 0.4*1 + 0.4*0.6 + 0.2*0 = 0.64
    assert sal == pytest.approx(0.64)
    assert "recency=0.00" in reason
