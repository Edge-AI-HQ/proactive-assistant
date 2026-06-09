"""Pure-function tests for the scheduled generator service — no DB needed.

Guards the camelCase round-trip contract: preview emits snake_case, the
route camelCases it via `_dump`, the client echoes it back, and create must
normalize it back to snake_case so the cron expression still derives
correctly. The DB-backed create path lives in tests/web/routes/.
"""

from __future__ import annotations

from pinai_agents.web.services.scheduled_generators import (
    _cron_expr_for,
    _normalize_payload_keys,
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


def test_camel_parsed_intent_round_trips_to_valid_cron():
    # The exact bug this guards: preview → _dump emits localTime (camel);
    # after the client echoes it back, create must still derive the cron.
    camel_parsed = {"frequency": "daily", "localTime": "09:00", "timezone": "UTC"}
    normalized = _normalize_payload_keys(camel_parsed)
    assert _cron_expr_for(normalized) == "0 9 * * *"
