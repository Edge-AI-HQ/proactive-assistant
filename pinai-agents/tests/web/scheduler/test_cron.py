"""next_fire — pure-function unit tests, no DB."""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from pinai_agents.web.scheduler.cron import next_fire


def test_cron_advances():
    after = datetime(2026, 5, 5, 12, 0, tzinfo=UTC)
    nxt = next_fire(
        trigger_kind="schedule", cron_expr="0 6 * * *",
        interval_seconds=None, timezone="UTC", after=after,
    )
    # Next 06:00 UTC after 12:00 = next day 06:00
    assert nxt == datetime(2026, 5, 6, 6, 0, tzinfo=UTC)


def test_interval_advances():
    after = datetime(2026, 5, 5, 12, 0, tzinfo=UTC)
    nxt = next_fire(
        trigger_kind="schedule", cron_expr=None,
        interval_seconds=300, timezone="UTC", after=after,
    )
    assert nxt == datetime(2026, 5, 5, 12, 5, tzinfo=UTC)


def test_once_returns_none():
    nxt = next_fire(
        trigger_kind="once", cron_expr=None,
        interval_seconds=None, timezone="UTC",
    )
    assert nxt is None


def test_event_returns_none():
    nxt = next_fire(
        trigger_kind="event", cron_expr=None,
        interval_seconds=None, timezone="UTC",
    )
    assert nxt is None


def test_schedule_without_cron_or_interval_raises():
    with pytest.raises(ValueError):
        next_fire(
            trigger_kind="schedule", cron_expr=None,
            interval_seconds=None, timezone="UTC",
        )


def test_invalid_timezone_raises():
    with pytest.raises(ValueError):
        next_fire(
            trigger_kind="schedule", cron_expr="0 6 * * *",
            interval_seconds=None, timezone="Made/Up", after=datetime.now(UTC),
        )
