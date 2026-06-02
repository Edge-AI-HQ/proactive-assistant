from __future__ import annotations

from datetime import UTC, datetime

import pytest

from pinai_agents.web.db.repositories.feedback import FeedbackRepository

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
