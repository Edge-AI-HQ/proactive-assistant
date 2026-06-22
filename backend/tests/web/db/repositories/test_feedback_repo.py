from __future__ import annotations

from datetime import UTC, datetime

import pytest
from pinai_api.domains.feedback.repository import FeedbackRepository
from pinai_api.domains.user_model.preferences import PreferenceRepository
from pinai_api.domains.user_model.profile import ProfileRepository
from pinai_db.rls import user_scoped_tx

pytestmark = pytest.mark.asyncio


class _CursorContext:
    def __init__(self, cursor):
        self._cursor = cursor

    async def __aenter__(self):
        return self._cursor

    async def __aexit__(self, *_exc):
        return False


class _ListCursor:
    def __init__(self):
        self.sql = ""

    async def execute(self, sql, _params):
        self.sql = sql

    async def fetchall(self):
        return [
            {"intent_card_id": "card_kind_dismiss"},
            {"intent_card_id": "card_kind_snooze"},
        ]


class _LogCursor:
    async def execute(self, _sql, _params):
        pass

    async def fetchone(self):
        return {
            "id": "fb_test",
            "kind": "dismiss",
            "action": None,
            "push_id": None,
            "intent_card_id": "card_kind_dismiss_fp",
            "intent_key": "work:followup",
            "source": "user_direct",
            "basket": "work",
            "value": None,
            "text": None,
            "metadata": {},
            "conversation_id": None,
            "message_id": None,
            "channel": "web",
            "created_at": datetime.now(UTC),
        }


class _Conn:
    def __init__(self, cursor):
        self._cursor = cursor

    def cursor(self):
        return _CursorContext(self._cursor)


class _CapturingFeedbackRepository(FeedbackRepository):
    def __init__(self, user_id, conn):
        super().__init__(user_id, conn)
        self.fanout_calls = []

    async def _fanout_fingerprint(self, **kwargs):
        self.fanout_calls.append(kwargs)


async def test_frontend_kind_dismiss_and_snooze_are_hidden_card_ids():
    cursor = _ListCursor()
    repo = FeedbackRepository(1, _Conn(cursor))

    hidden_ids = await repo.list_dismissed_card_ids()

    assert set(hidden_ids) == {"card_kind_dismiss", "card_kind_snooze"}
    assert "kind IN ('dismiss', 'snooze')" in cursor.sql


async def test_frontend_kind_dismiss_updates_intent_fingerprint():
    repo = _CapturingFeedbackRepository(1, _Conn(_LogCursor()))

    await repo.log(
        kind="dismiss",
        intent_card_id="card_kind_dismiss_fp",
        intent_key="work:followup",
        basket="work",
    )

    assert repo.fanout_calls == [
        {
            "card_id": "card_kind_dismiss_fp",
            "action": "dismiss",
            "intent_key": "work:followup",
            "basket": "work",
        }
    ]


async def test_future_card_text_feedback_creates_active_preference(pool, user_ids):
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        await ProfileRepository(user_a, conn).upsert_profile(
            display_name="Avery",
            locale="en-US",
            timezone="America/Los_Angeles",
            summary="Silicon Valley AI engineer building infra products.",
            facts={"role": "AI engineer", "location": "San Francisco Bay Area"},
            preferences={"content_depth": "technical, source-backed, low hype"},
        )
        repo = FeedbackRepository(user_a, conn)

        feedback = await repo.log(
            kind="text_feedback",
            intent_card_id="card_vc_rumors",
            intent_key="tech:vc-rumors",
            basket="tech",
            text=(
                "Stop showing me VC funding rumor cards again; "
                "focus on deeply technical AI infra papers."
            ),
            metadata={
                "surface": "card_thread_reply",
                "cardContext": {
                    "title": "VC funding rumor roundup",
                    "summary": "A high-level funding gossip card.",
                },
            },
            channel="card_thread",
        )

        preferences = await PreferenceRepository(user_a, conn).list(status="active")

    assert len(preferences) == 1
    pref = preferences[0]
    assert pref.statement == (
        "Stop showing me VC funding rumor cards again; focus on deeply technical AI infra papers."
    )
    assert pref.scope == "topic"
    assert pref.polarity == "negative"
    assert pref.durability == "persistent"
    assert pref.source == "user"
    assert pref.weight == 1.0
    assert pref.evidence == {
        "card_id": "card_vc_rumors",
        "feedback_id": feedback.id,
        "intent_key": "tech:vc-rumors",
        "basket": "tech",
        "surface": "card_thread_reply",
    }


async def test_future_card_text_feedback_accepts_metadata_json_string(pool, user_ids):
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        feedback = await FeedbackRepository(user_a, conn).log(
            kind="text_feedback",
            intent_card_id="card_less_vc",
            intent_key="tech:funding-rumors",
            basket="tech",
            text="No more funding rumor cards; I care about AI systems papers.",
            metadata='{"surface": "legacy_card_thread"}',
            channel="card_thread",
        )

        preferences = await PreferenceRepository(user_a, conn).list(status="active")

    assert len(preferences) == 1
    assert preferences[0].evidence == {
        "card_id": "card_less_vc",
        "feedback_id": feedback.id,
        "intent_key": "tech:funding-rumors",
        "basket": "tech",
        "surface": "legacy_card_thread",
    }


async def test_card_complete_updates_intent_fingerprint_as_positive(pool, user_ids):
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        await FeedbackRepository(user_a, conn).log(
            kind="card_action",
            action="complete",
            intent_card_id="card_ai_pr_review",
            intent_key="work:ai-pr-review",
            basket="work",
            channel="web",
        )

        cur = await conn.execute(
            """
            SELECT ctr_7d, ctr_30d, last_open_at, last_dismiss_at
            FROM pai_user_intent_pref
            WHERE user_id = %s AND intent = %s AND basket = %s
            """,
            (user_a, "work:ai-pr-review", "work"),
        )
        row = await cur.fetchone()

    assert row is not None
    assert row["ctr_7d"] == 1.0
    assert row["ctr_30d"] == 1.0
    assert row["last_open_at"] is not None
    assert row["last_dismiss_at"] is None
