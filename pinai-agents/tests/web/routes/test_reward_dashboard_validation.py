from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from typing import Any

import pytest
from fastapi import HTTPException

from pinai_agents.web.auth.user_service import User
from pinai_agents.web.routes.ui import reward_dashboard as reward_dashboard_module
from pinai_agents.web.routes.ui.reward_dashboard import (
    CASEBOOK_REVIEWER_NOTE_MAX_LENGTH,
    REWARD_METADATA_MAX_JSON_LENGTH,
    REWARD_TEXT_FILTER_MAX_LENGTH,
    SCORE_REASON_MAX_LENGTH,
    _casebook_label,
    _optional_bool,
    _optional_path_id,
    _optional_trimmed_text,
    _path_id,
    _review_score_value,
    _reward_metadata,
    _score_event_type,
    _score_source,
    _validate_datetime_range,
    _validate_numeric_range,
)


def _test_user() -> User:
    return User(
        id=123,
        supabase_user_id="test-sub",
        email="test@example.invalid",
        litellm_virtual_key=None,
        browserbase_context_id=None,
    )


@asynccontextmanager
async def _fake_user_scoped_tx(pool: object, user_id: int) -> AsyncIterator[object]:
    yield object()


def test_path_id_trims_and_rejects_blank_values() -> None:
    assert _path_id("  run_1  ", field_name="run_id") == "run_1"

    with pytest.raises(HTTPException) as exc:
        _path_id("   ", field_name="run_id")

    assert exc.value.status_code == 422
    assert exc.value.detail == "run_id required"


def test_optional_path_id_trims_blank_to_none_and_rejects_bad_values() -> None:
    assert _optional_path_id(None, field_name="run_id") is None
    assert _optional_path_id("   ", field_name="run_id") is None
    assert _optional_path_id(" run_1 ", field_name="run_id") == "run_1"

    with pytest.raises(HTTPException) as exc:
        _optional_path_id(["run_1"], field_name="run_id")

    assert exc.value.status_code == 422
    assert exc.value.detail == "run_id must be a string"


def test_casebook_label_trims_and_rejects_invalid_values() -> None:
    assert _casebook_label("  great ") == "great"

    with pytest.raises(HTTPException) as blank_exc:
        _casebook_label("   ")

    assert blank_exc.value.status_code == 422
    assert blank_exc.value.detail == "label required"

    with pytest.raises(HTTPException) as invalid_exc:
        _casebook_label("unknown")

    assert invalid_exc.value.status_code == 422
    assert invalid_exc.value.detail == "invalid casebook label: unknown"


def test_optional_trimmed_text_normalizes_empty_and_rejects_bad_values() -> None:
    assert _optional_trimmed_text(None, field_name="reviewerNote", max_length=10) is None
    assert _optional_trimmed_text("   ", field_name="reviewerNote", max_length=10) is None
    assert _optional_trimmed_text(" note ", field_name="reviewerNote", max_length=10) == "note"

    with pytest.raises(HTTPException) as type_exc:
        _optional_trimmed_text(123, field_name="reviewerNote", max_length=10)

    assert type_exc.value.status_code == 422
    assert type_exc.value.detail == "reviewerNote must be a string"

    with pytest.raises(HTTPException) as length_exc:
        _optional_trimmed_text(
            "x" * (CASEBOOK_REVIEWER_NOTE_MAX_LENGTH + 1),
            field_name="reviewerNote",
            max_length=CASEBOOK_REVIEWER_NOTE_MAX_LENGTH,
        )

    assert length_exc.value.status_code == 422
    assert length_exc.value.detail == (
        f"reviewerNote must be at most {CASEBOOK_REVIEWER_NOTE_MAX_LENGTH} characters"
    )


def test_score_reason_uses_same_text_boundary() -> None:
    assert (
        _optional_trimmed_text(" sharp ", field_name="reason", max_length=SCORE_REASON_MAX_LENGTH)
        == "sharp"
    )

    with pytest.raises(HTTPException) as exc:
        _optional_trimmed_text(
            "x" * (SCORE_REASON_MAX_LENGTH + 1),
            field_name="reason",
            max_length=SCORE_REASON_MAX_LENGTH,
        )

    assert exc.value.status_code == 422
    assert exc.value.detail == f"reason must be at most {SCORE_REASON_MAX_LENGTH} characters"


@pytest.mark.asyncio
async def test_list_routes_trim_text_filters_before_querying_repo(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[tuple[str, dict[str, Any]]] = []

    class FakeRewardRepository:
        def __init__(self, user_id: int, conn: object) -> None:
            self.user_id = user_id
            self.conn = conn

        async def list_runs(self, **kwargs: Any) -> list[dict[str, Any]]:
            calls.append(("list_runs", kwargs))
            return []

        async def count_casebook(self, **kwargs: Any) -> int:
            calls.append(("count_casebook", kwargs))
            return 0

        async def list_casebook(self, **kwargs: Any) -> list[dict[str, Any]]:
            calls.append(("list_casebook", kwargs))
            return []

    monkeypatch.setattr(reward_dashboard_module, "RewardRepository", FakeRewardRepository)
    monkeypatch.setattr(reward_dashboard_module, "user_scoped_tx", _fake_user_scoped_tx)

    await reward_dashboard_module.list_runs(
        user=_test_user(),
        pool=object(),
        limit=50,
        trigger="  manual  ",
        since=None,
        until=None,
        reviewed=None,
        quality=None,
    )
    await reward_dashboard_module.list_casebook(
        user=_test_user(),
        pool=object(),
        label=None,
        min_score=None,
        max_score=None,
        basket="  work  ",
        intent="  route  ",
        min_evaluator_gap=None,
        since=None,
        until=None,
        limit=20,
        offset=0,
    )

    assert calls[0] == (
        "list_runs",
        {
            "limit": 50,
            "trigger": "manual",
            "since": None,
            "until": None,
            "reviewed": None,
            "quality": None,
        },
    )
    assert calls[1][0] == "count_casebook"
    assert calls[1][1]["basket"] == "work"
    assert calls[1][1]["intent"] == "route"
    assert calls[2][0] == "list_casebook"
    assert calls[2][1]["basket"] == "work"
    assert calls[2][1]["intent"] == "route"


@pytest.mark.asyncio
async def test_list_routes_reject_oversized_text_filters() -> None:
    with pytest.raises(HTTPException) as trigger_exc:
        await reward_dashboard_module.list_runs(
            user=_test_user(),
            pool=object(),
            limit=50,
            trigger="x" * (REWARD_TEXT_FILTER_MAX_LENGTH + 1),
            since=None,
            until=None,
            reviewed=None,
            quality=None,
        )

    assert trigger_exc.value.status_code == 422
    assert (
        trigger_exc.value.detail
        == f"trigger must be at most {REWARD_TEXT_FILTER_MAX_LENGTH} characters"
    )

    with pytest.raises(HTTPException) as intent_exc:
        await reward_dashboard_module.list_casebook(
            user=_test_user(),
            pool=object(),
            label=None,
            min_score=None,
            max_score=None,
            basket=None,
            intent="x" * (REWARD_TEXT_FILTER_MAX_LENGTH + 1),
            min_evaluator_gap=None,
            since=None,
            until=None,
            limit=20,
            offset=0,
        )

    assert intent_exc.value.status_code == 422
    assert (
        intent_exc.value.detail
        == f"intent must be at most {REWARD_TEXT_FILTER_MAX_LENGTH} characters"
    )


def test_score_event_type_defaults_and_trims() -> None:
    assert _score_event_type({}) == "reviewer_score"
    assert _score_event_type({"eventType": " reviewer_score "}) == "reviewer_score"
    assert _score_event_type({"eventType": "   ", "event_type": " user_score "}) == "user_score"


@pytest.mark.parametrize("value", [["reviewer_score"], {"kind": "reviewer_score"}, 1, True])
def test_score_event_type_rejects_non_string_values(value: object) -> None:
    with pytest.raises(HTTPException) as exc:
        _score_event_type({"eventType": value})

    assert exc.value.status_code == 422
    assert exc.value.detail == "invalid score event"


def test_score_event_type_rejects_non_score_events() -> None:
    with pytest.raises(HTTPException) as exc:
        _score_event_type({"eventType": "imported_feedback"})

    assert exc.value.status_code == 422
    assert exc.value.detail == "invalid score event"


def test_score_source_defaults_and_trims() -> None:
    assert _score_source({}, event_type="reviewer_score") == "reviewer"
    assert _score_source({}, event_type="user_score") == "user"
    assert _score_source({}, event_type="card_open") == "user"
    assert _score_source({"source": " reviewer "}, event_type="reviewer_score") == "reviewer"
    assert _score_source({"source": "   "}, event_type="reviewer_score") == "reviewer"


@pytest.mark.parametrize("value", [["reviewer"], {"source": "reviewer"}, 1, True])
def test_score_source_rejects_non_string_values(value: object) -> None:
    with pytest.raises(HTTPException) as exc:
        _score_source({"source": value}, event_type="reviewer_score")

    assert exc.value.status_code == 422
    assert exc.value.detail == "invalid score source"


def test_score_source_rejects_unknown_sources() -> None:
    with pytest.raises(HTTPException) as exc:
        _score_source({"source": "admin"}, event_type="reviewer_score")

    assert exc.value.status_code == 422
    assert exc.value.detail == "invalid score source"


def test_reward_metadata_accepts_small_json_objects() -> None:
    assert _reward_metadata(
        {
            "surface": "now_feed",
            "goalBasket": "career",
            "rank": 1,
            "flags": [True, None],
        }
    ) == {
        "surface": "now_feed",
        "goalBasket": "career",
        "rank": 1,
        "flags": [True, None],
    }


@pytest.mark.parametrize("value", [[], "metadata", 1])
def test_reward_metadata_rejects_non_object_values(value: object) -> None:
    with pytest.raises(HTTPException) as exc:
        _reward_metadata(value)

    assert exc.value.status_code == 422
    assert exc.value.detail == "metadata must be an object"


@pytest.mark.parametrize("value", [float("nan"), float("inf"), float("-inf")])
def test_reward_metadata_rejects_non_finite_numbers(value: float) -> None:
    with pytest.raises(HTTPException) as exc:
        _reward_metadata({"value": value})

    assert exc.value.status_code == 422
    assert exc.value.detail == "metadata numbers must be finite"


def test_reward_metadata_rejects_oversized_payloads() -> None:
    with pytest.raises(HTTPException) as exc:
        _reward_metadata({"value": "x" * REWARD_METADATA_MAX_JSON_LENGTH})

    assert exc.value.status_code == 422
    assert (
        exc.value.detail == f"metadata must be at most {REWARD_METADATA_MAX_JSON_LENGTH} characters"
    )


def test_reward_metadata_rejects_deep_or_wide_payloads() -> None:
    with pytest.raises(HTTPException) as deep_exc:
        _reward_metadata({"a": {"b": {"c": {"d": {"e": "too deep"}}}}})

    assert deep_exc.value.status_code == 422
    assert deep_exc.value.detail == "metadata is too deeply nested"

    with pytest.raises(HTTPException) as wide_exc:
        _reward_metadata({f"k{i}": i for i in range(51)})

    assert wide_exc.value.status_code == 422
    assert wide_exc.value.detail == "metadata contains too many items"


@pytest.mark.parametrize("event_type", ["user_score", "reviewer_score"])
def test_score_events_require_present_score(event_type: str) -> None:
    with pytest.raises(HTTPException) as exc:
        _review_score_value(None, event_type=event_type)

    assert exc.value.status_code == 422
    assert exc.value.detail == f"{event_type} score must be between 1 and 10"


@pytest.mark.parametrize("event_type", ["user_score", "reviewer_score"])
def test_score_events_require_score_at_least_one(event_type: str) -> None:
    with pytest.raises(HTTPException) as exc:
        _review_score_value(0, event_type=event_type)

    assert exc.value.status_code == 422
    assert exc.value.detail == f"{event_type} score must be between 1 and 10"


@pytest.mark.parametrize("score", [True, False])
def test_score_events_reject_boolean_scores(score: bool) -> None:
    with pytest.raises(HTTPException) as exc:
        _review_score_value(score, event_type="reviewer_score")

    assert exc.value.status_code == 422
    assert exc.value.detail == "score must be a number"


@pytest.mark.parametrize("score", [float("nan"), float("inf"), float("-inf")])
def test_score_events_reject_non_finite_scores(score: float) -> None:
    with pytest.raises(HTTPException) as exc:
        _review_score_value(score, event_type="reviewer_score")

    assert exc.value.status_code == 422
    assert exc.value.detail == "score must be a finite number"


def test_card_open_can_omit_score_before_route_sets_default() -> None:
    assert _review_score_value(None, event_type="card_open") is None


def test_score_events_accept_valid_score() -> None:
    assert _review_score_value(1, event_type="reviewer_score") == 1.0
    assert _review_score_value(10, event_type="user_score") == 10.0


def test_optional_bool_accepts_only_boolean_values() -> None:
    assert _optional_bool(None, field_name="force") is False
    assert _optional_bool(None, field_name="force", default=True) is True
    assert _optional_bool(True, field_name="force") is True
    assert _optional_bool(False, field_name="force") is False


@pytest.mark.parametrize("value", ["false", "true", 0, 1, [], {}])
def test_optional_bool_rejects_non_boolean_values(value: object) -> None:
    with pytest.raises(HTTPException) as exc:
        _optional_bool(value, field_name="force")

    assert exc.value.status_code == 422
    assert exc.value.detail == "force must be a boolean"


def test_rejects_reversed_datetime_ranges() -> None:
    since = datetime(2026, 5, 15, 0, 0, tzinfo=UTC)
    until = datetime(2026, 5, 14, 23, 59, tzinfo=UTC)

    with pytest.raises(HTTPException) as exc:
        _validate_datetime_range(since, until)

    assert exc.value.status_code == 422
    assert exc.value.detail == "since must be before or equal to until"


def test_datetime_range_order_handles_mixed_timezone_inputs() -> None:
    since = datetime(2026, 5, 14, 12, 0, tzinfo=UTC)
    until = datetime(2026, 5, 14, 13, 0)

    _validate_datetime_range(since, until)


def test_rejects_reversed_numeric_ranges() -> None:
    with pytest.raises(HTTPException) as exc:
        _validate_numeric_range(8, 5, min_name="minScore", max_name="maxScore")

    assert exc.value.status_code == 422
    assert exc.value.detail == "minScore must be less than or equal to maxScore"


@pytest.mark.parametrize(
    ("name", "min_value", "max_value"),
    [
        ("minScore", float("nan"), 5),
        ("maxScore", 1, float("inf")),
        ("maxScore", 1, float("-inf")),
    ],
)
def test_rejects_non_finite_numeric_ranges(
    name: str,
    min_value: float,
    max_value: float,
) -> None:
    with pytest.raises(HTTPException) as exc:
        _validate_numeric_range(
            min_value,
            max_value,
            min_name="minScore",
            max_name="maxScore",
        )

    assert exc.value.status_code == 422
    assert exc.value.detail == f"{name} must be finite"


def test_allows_open_ended_ranges() -> None:
    _validate_datetime_range(None, datetime(2026, 5, 14, 23, 59, tzinfo=UTC))
    _validate_numeric_range(8, None, min_name="minScore", max_name="maxScore")
