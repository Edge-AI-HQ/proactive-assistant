"""Unit tests for compute_salience — the pure scoring formula.

DB-bound integration of score_for_active_users is exercised by the
e2e test that runs a full ingest cycle against the live DB.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta

import pytest
from pinai_api.domains.connector.world.world_scoring import (
    _PROJECT_SALIENCE_MIN,
    _jaccard,
    _slug_tokens,
    _user_topic_set,
    compute_salience,
    score_for_active_users,
)
from pinai_api.domains.memory.events.repository import AppendEventInput, EventsRepository
from pinai_db.rls import service_tx, user_scoped_tx

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
    # Preferences now come from L1 preference events (statement + scope).
    preferences = [{"title": "Loves AI agents", "structured": {"scope": "tech"}}]
    # Goals now come from the §-separated GOALS portrait markdown slot.
    goals_text = "Ship Pin AI v2 by Q4\n§\nRun a sub3 marathon"
    cards = [
        {
            "goalBasket": "wealth",
            "intentKey": "openai-budget-cap",
            "sources": ["signal id=sig_x, title=OpenAI billing"],
        }
    ]
    out = _user_topic_set(preferences, goals_text, cards)
    # Preference contributes 'ai', 'agents' (statement) + 'tech' (scope)
    assert {"ai", "agents"} <= out
    assert "tech" in out
    # Goals markdown contributes 'ship', 'pin', 'v2', 'q4', 'sub3', 'marathon'
    assert "ship" in out
    assert "v2" in out
    assert "marathon" in out
    # Cards contribute 'wealth', 'openai', 'budget', 'cap', 'billing'
    assert "wealth" in out
    assert "openai" in out


def test_user_topics_handles_string_jsonb():
    """psycopg can hand back the preference `structured` JSONB as a JSON
    string depending on cursor config. The function must tolerate both."""
    import json

    preferences = [{"title": "Cares about health", "structured": json.dumps({"scope": "fitness"})}]
    out = _user_topic_set(preferences, None, [])
    assert {"health", "fitness"} <= out


def test_user_topics_handles_empty_sources():
    out = _user_topic_set([], None, [])
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
        signal_topics=["ai"],
        signal_regions=[],
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
        signal_topics=["ai"],
        signal_regions=[],
        signal_importance="high",
        signal_published_at=naive,
        user_topics={"ai"},
        now=datetime(2026, 5, 6, 13, 0, 0, tzinfo=UTC),
    )
    # Should compute a sensible value, not crash.
    assert 0 <= sal <= 1.0


def test_salience_no_published_at_zero_recency():
    sal, reason = compute_salience(
        signal_topics=["ai"],
        signal_regions=[],
        signal_importance="high",
        signal_published_at=None,
        user_topics={"ai"},
    )
    # 0.4*1 + 0.4*0.6 + 0.2*0 = 0.64
    assert sal == pytest.approx(0.64)
    assert "recency=0.00" in reason


# ── score_for_active_users L1 projection (DB) ──────────────────────


async def _seed_signal(conn, *, sid, title, topics, importance, published_at):
    await conn.execute(
        """
        INSERT INTO pai_world_signals
          (id, provider, title, url, normalized_url,
           summary, published_at, topics, importance)
        VALUES (%s, 'rss', %s, %s, %s, 'summary', %s, %s::jsonb, %s)
        ON CONFLICT (normalized_url) DO NOTHING
        """,
        (
            sid,
            title,
            f"https://x/{sid}",
            f"https://x/{sid}",
            published_at,
            json.dumps(topics),
            importance,
        ),
    )


@pytest.mark.asyncio
async def test_high_salience_signal_projects_to_world_news_event(pool, user_ids):
    """A signal scored ≥ _PROJECT_SALIENCE_MIN for a user ALSO lands as a
    world_news event in pai_events (joins unified retrieval, doc §四/§331);
    a low-salience one does not. Re-scoring is idempotent (dedupe_key)."""
    user_a, _ = user_ids
    now = datetime.now(UTC)

    # Give the user an 'ai' interest via a preference event so the topic
    # fingerprint matches the high signal. Seed one on-topic high-importance
    # fresh signal (salience ≈ 0.64) and one off-topic stale low one (≈ 0.12).
    async with user_scoped_tx(pool, user_a) as conn:
        await EventsRepository(user_a, conn).append(
            AppendEventInput(
                id="pref_ai",
                source="pinai_chat",
                event_type="preference",
                occurred_at=now,
                dedupe_key="pref:ai",
                title="ai",
                curated=True,
            )
        )
    async with service_tx(pool) as conn:
        await _seed_signal(
            conn,
            sid="world_hi",
            title="AI breakthrough",
            topics=["ai"],
            importance="high",
            published_at=now,
        )
        await _seed_signal(
            conn,
            sid="world_lo",
            title="Cricket scores",
            topics=["sports"],
            importance="low",
            published_at=now - timedelta(hours=300),
        )

    await score_for_active_users(pool, world_signal_ids=["world_hi", "world_lo"])

    async with user_scoped_tx(pool, user_a) as conn:
        cur = await conn.execute(
            """
            SELECT source_ref, title, event_type, source,
                   (structured->>'salience')::float AS salience
            FROM pai_events
            WHERE user_id = %s AND event_type = 'world_news'
            """,
            (user_a,),
        )
        rows = await cur.fetchall()

    refs = {r["source_ref"] for r in rows}
    assert "world_hi" in refs  # salience ≈ 0.64 ≥ threshold → projected
    assert "world_lo" not in refs  # salience ≈ 0.12 < threshold → not projected
    hi = next(r for r in rows if r["source_ref"] == "world_hi")
    assert hi["source"] == "world"
    assert hi["title"] == "AI breakthrough"
    assert hi["salience"] >= _PROJECT_SALIENCE_MIN

    # Idempotent: re-scoring the same signal hits the events dedupe and no-ops.
    await score_for_active_users(pool, world_signal_ids=["world_hi"])
    async with user_scoped_tx(pool, user_a) as conn:
        cur = await conn.execute(
            "SELECT count(*) AS n FROM pai_events WHERE user_id = %s AND source_ref = 'world_hi'",
            (user_a,),
        )
        assert (await cur.fetchone())["n"] == 1


@pytest.mark.asyncio
async def test_world_projection_caps_at_top_k_per_user(pool, user_ids):
    """W2: even when many signals clear the salience floor, only the top-K most
    relevant project into the user's events — a busy news day can't bury personal
    events under world_news."""
    from pinai_api.domains.connector.world.world_scoring import _PROJECT_TOP_K

    user_a, _ = user_ids
    now = datetime.now(UTC)
    async with user_scoped_tx(pool, user_a) as conn:
        await EventsRepository(user_a, conn).append(
            AppendEventInput(
                id="pref_ai_k",
                source="pinai_chat",
                event_type="preference",
                occurred_at=now,
                dedupe_key="pref:ai:k",
                title="ai",
                curated=True,
            )
        )
    # 2*K high-importance fresh 'ai' signals — all clear the floor, only K project.
    async with service_tx(pool) as conn:
        for i in range(_PROJECT_TOP_K * 2):
            await _seed_signal(
                conn,
                sid=f"wk_{i}",
                title=f"AI story {i}",
                topics=["ai"],
                importance="high",
                published_at=now,
            )

    await score_for_active_users(
        pool, world_signal_ids=[f"wk_{i}" for i in range(_PROJECT_TOP_K * 2)]
    )

    async with user_scoped_tx(pool, user_a) as conn:
        cur = await conn.execute(
            "SELECT count(*) AS n FROM pai_events WHERE user_id = %s AND event_type = 'world_news'",
            (user_a,),
        )
        assert (await cur.fetchone())["n"] == _PROJECT_TOP_K  # capped, not all 2*K
