"""Cron / interval next-fire computation.

Wraps `croniter` so the rest of the scheduler doesn't import it directly.
Also handles interval-based tasks (`interval_seconds`) and once-shot tasks
(no future fire).

Timezone:
  We accept a tz string per task (default UTC). croniter is tz-aware via
  zoneinfo. Naive `now` is treated as UTC.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

from croniter import croniter


def next_fire(
    *,
    trigger_kind: str,
    cron_expr: str | None,
    interval_seconds: int | None,
    timezone: str = "UTC",
    after: datetime | None = None,
) -> datetime | None:
    """Compute the next fire time strictly after `after`.

    - trigger_kind='schedule' + cron_expr → croniter
    - trigger_kind='schedule' + interval_seconds → after + interval
    - trigger_kind='once'  → None (no future fire after this one)
    - trigger_kind='event' → None (event-triggered tasks don't have schedules)
    """
    after = after or datetime.now(UTC)
    if after.tzinfo is None:
        after = after.replace(tzinfo=UTC)

    if trigger_kind == "once" or trigger_kind == "event":
        return None

    if trigger_kind != "schedule":
        msg = f"unknown trigger_kind: {trigger_kind!r}"
        raise ValueError(msg)

    if cron_expr:
        # croniter takes tz via the start time's tzinfo.
        try:
            tz = ZoneInfo(timezone)
        except Exception as e:
            msg = f"invalid timezone {timezone!r}: {e}"
            raise ValueError(msg) from e
        local_after = after.astimezone(tz)
        it = croniter(cron_expr, local_after)
        nxt = it.get_next(datetime)
        return nxt.astimezone(UTC)

    if interval_seconds and interval_seconds > 0:
        return after + timedelta(seconds=interval_seconds)

    msg = "schedule trigger requires either cron_expr or interval_seconds"
    raise ValueError(msg)
