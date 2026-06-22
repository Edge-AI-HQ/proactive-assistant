"""Unit tests for /api/conversation session_key classification + ownership.

_classify is the cross-user isolation guard for the unified actor route: it
maps a session_key to (kind, card_id) and rejects keys that don't belong to the
caller. card ownership (pai_pipeline_runs) is checked separately in
_assert_card_owned (needs a DB) — these cover the pure prefix logic.
"""

from __future__ import annotations

from datetime import UTC, datetime

import pytest
from fastapi import HTTPException
from pinai_api.control.conversation import (
    _AGENT_KIND_BY_THREAD,
    _active_user_entries,
    _classify,
    _row_to_message,
)
from pinai_api.control.mailbox import Message


def test_classify_card_thread() -> None:
    assert _classify("card-thread-abc123", 31) == ("card", "abc123")


def test_classify_card_thread_empty_id_rejected() -> None:
    with pytest.raises(HTTPException) as e:
        _classify("card-thread-", 31)
    assert e.value.status_code == 400


def test_classify_proactive_own() -> None:
    assert _classify("proactive-31", 31) == ("proactive", None)


def test_classify_proactive_other_user_rejected() -> None:
    # A user must not address another user's proactive thread.
    with pytest.raises(HTTPException) as e:
        _classify("proactive-99", 31)
    assert e.value.status_code == 400


def test_classify_main_own() -> None:
    assert _classify("main-31-abc123def456", 31) == ("main", None)


def test_classify_main_other_user_rejected() -> None:
    with pytest.raises(HTTPException) as e:
        _classify("main-99-abc123", 31)
    assert e.value.status_code == 400


def test_classify_main_empty_rand_rejected() -> None:
    # "main-31-" has the prefix but no random suffix → not a valid main key
    # (len must exceed the prefix), so it can't collide with the bare prefix.
    with pytest.raises(HTTPException) as e:
        _classify("main-31-", 31)
    assert e.value.status_code == 400


def test_classify_garbage_rejected() -> None:
    with pytest.raises(HTTPException) as e:
        _classify("random-garbage", 31)
    assert e.value.status_code == 400


def test_agent_kind_mapping_covers_all_conversational_kinds() -> None:
    # Every ThreadKind maps to the actor-kernel agent_kind the worker accounts
    # on; chat /agent/chat re-derives the same agent from the prefix.
    assert _AGENT_KIND_BY_THREAD == {
        "main": "main_chat",
        "card": "card_execution",
        "proactive": "proactive",
    }


def test_row_to_message_echoes_client_msg_id() -> None:
    # The send's clientMsgId (stamped on the row via the mailbox) rides back as
    # `clientMsgId` so the FE reconciles its optimistic bubble by identity;
    # NULL (assistant rows, pre-089 rows, id-less sends) omits the field.
    parts = [{"type": "text", "text": "hi"}]
    with_id = _row_to_message({"id": 7, "role": "user", "parts": parts, "client_msg_id": "u-1"})
    assert with_id["clientMsgId"] == "u-1"
    without = _row_to_message({"id": 8, "role": "assistant", "parts": parts, "client_msg_id": None})
    assert "clientMsgId" not in without


def test_active_user_entries_marks_only_unclaimed_rows_as_queued() -> None:
    now = datetime.now(UTC)
    entries = _active_user_entries(
        [
            Message(
                id=1,
                session_id="main-31-a",
                role="user",
                source="user",
                content="current run",
                meta=None,
                enqueued_at=now,
                idempotency_key="run-1",
                run_id="active-run",
            ),
            Message(
                id=2,
                session_id="main-31-a",
                role="user",
                source="user",
                content="queued follow-up",
                meta=None,
                enqueued_at=now,
                idempotency_key="queue-1",
                run_id=None,
            ),
        ],
        has_running_run=True,
    )

    assert entries == [
        {"text": "current run", "clientId": "run-1"},
        {"text": "queued follow-up", "clientId": "queue-1", "queued": True},
    ]
