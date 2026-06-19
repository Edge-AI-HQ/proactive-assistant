from __future__ import annotations

from datetime import UTC, datetime, timedelta

from pinai_agents.web.payment.routes import (
    _current_period_start,
    _parse_budget_duration,
    _parse_dt,
)


def test_parse_budget_duration_common_units():
    assert _parse_budget_duration("30d") == timedelta(days=30)
    assert _parse_budget_duration("24h") == timedelta(hours=24)
    assert _parse_budget_duration("60m") == timedelta(minutes=60)
    assert _parse_budget_duration("2w") == timedelta(weeks=2)
    assert _parse_budget_duration("1mo") == timedelta(days=30)


def test_parse_budget_duration_rejects_garbage():
    assert _parse_budget_duration("") is None
    assert _parse_budget_duration("forever") is None
    assert _parse_budget_duration(None) is None
    assert _parse_budget_duration(30) is None


def test_parse_dt_accepts_datetime_and_iso():
    dt = datetime(2026, 7, 1, tzinfo=UTC)
    assert _parse_dt(dt) is dt
    assert _parse_dt("2026-07-01T00:00:00+00:00") == dt
    assert _parse_dt("2026-07-01T00:00:00Z") == dt
    assert _parse_dt("not-a-date") is None
    assert _parse_dt(None) is None


def test_current_period_start_derives_window():
    info = {"budget_reset_at": "2026-07-01T00:00:00+00:00", "budget_duration": "30d"}
    assert _current_period_start(info) == datetime(2026, 6, 1, tzinfo=UTC)


def test_current_period_start_none_when_unparseable():
    assert _current_period_start({}) is None
    assert _current_period_start({"budget_reset_at": "2026-07-01T00:00:00Z"}) is None
    assert _current_period_start({"budget_duration": "30d"}) is None
