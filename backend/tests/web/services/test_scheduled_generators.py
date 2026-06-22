"""Pure-function tests for the scheduled generator service — no DB needed.

Guards the camelCase round-trip contract (preview emits snake_case, the
route camelCases it via `_dump`, the client echoes it back) plus the v2
structured-schedule guardrails: per-mode min gap, reminder payload shape,
and signature-based similarity matching. The DB-backed create path lives
in tests/web/routes/.
"""

from __future__ import annotations

import pytest
from pinai_api.domains.generation.scheduled_generators import (
    REMINDER_KIND,
    SCHEDULED_GENERATOR_KIND,
    USER_TASK_KINDS,
    ScheduledGeneratorValidationError,
    _find_similar,
    _normalize_payload_keys,
    _resolve_and_guard,
    _validate_reminder,
)


def test_normalize_payload_keys_camel_to_snake():
    camel = {
        "frequency": "daily",
        "localTime": "09:00",
        "timezone": "America/Los_Angeles",
        "topic": "AI 新闻",
        "cardCount": 8,
    }
    out = _normalize_payload_keys(camel)
    assert out["local_time"] == "09:00"
    assert out["card_count"] == 8
    assert out["frequency"] == "daily"
    assert out["timezone"] == "America/Los_Angeles"


def test_normalize_payload_keys_is_idempotent_on_snake():
    snake = {"frequency": "daily", "local_time": "09:00", "timezone": "UTC"}
    assert _normalize_payload_keys(snake) == snake


def test_normalize_payload_keys_recurses_into_nested():
    nested = {"confirmedBrief": {"timeWindow": "past 24h", "contentFocus": ["a", "b"]}}
    out = _normalize_payload_keys(nested)
    assert out["confirmed_brief"]["time_window"] == "past 24h"
    assert out["confirmed_brief"]["content_focus"] == ["a", "b"]


def test_user_task_kinds_cover_both_modes():
    assert SCHEDULED_GENERATOR_KIND in USER_TASK_KINDS
    assert REMINDER_KIND in USER_TASK_KINDS


def test_resolve_and_guard_rejects_dense_generate_interval():
    with pytest.raises(ScheduledGeneratorValidationError):
        _resolve_and_guard(
            schedule={"type": "interval", "every_seconds": 300},
            timezone="UTC",
            mode="generate",
            original_request="每 5 分钟推新闻",
        )


def test_resolve_and_guard_allows_dense_reminder_interval():
    resolved = _resolve_and_guard(
        schedule={"type": "interval", "every_seconds": 300},
        timezone="UTC",
        mode="reminder",
        original_request="每 5 分钟提醒我喝水",
    )
    assert resolved.interval_seconds == 300


def test_validate_reminder_requires_title_and_message():
    with pytest.raises(ScheduledGeneratorValidationError):
        _validate_reminder("reminder", {"title": "喝水"})
    clean = _validate_reminder("reminder", {"title": "喝水", "message": "该喝水了"})
    assert clean == {"title": "喝水", "message": "该喝水了"}


def test_find_similar_matches_on_signature():
    from pinai_api.platform.db.repositories.scheduled_tasks import ScheduledTaskRow

    row = ScheduledTaskRow.from_record(
        {
            "user_id": 1,
            "id": "t1",
            "kind": SCHEDULED_GENERATOR_KIND,
            "trigger_kind": "schedule",
            "payload": {"semantic_signature": "sig-x"},
            "timezone": "UTC",
            "status": "active",
            "run_count": 0,
        }
    )
    assert _find_similar(
        [row], semantic_signature="sig-x", parsed_intent={}, confirmed_brief={}
    ) == [row]
    assert (
        _find_similar([row], semantic_signature="sig-y", parsed_intent={}, confirmed_brief={}) == []
    )
