"""Proactive heartbeat window — compute a heartbeat turn's input text.

A heartbeat (source=heartbeat) message is just a marker when enqueued; its
content is computed HERE, in the web worker at drain time (chat never touches
the DB — trust boundary). After claim_pending the worker calls
build_heartbeat_message: it reads the per-session ingestion cursor
(last_tick_at), queries the timeline window since the cursor, formats it, and
returns the text the agent sees as one role=user message. Multiple stacked
ticks collapse into ONE window (cursor → latest tick) — plan §十七.

Migrated from proactive_loop._execute_turn's tick path (RC-1). The cursor is
advanced by the scheduler when the heartbeat is enqueued (dispatcher, in the
same tx as the enqueue), not here.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from psycopg_pool import AsyncConnectionPool

from ..db.repositories.proactive import ProactiveRepository
from ..db.repositories.profile import ProfileRepository
from ..db.repositories.timeline import TimelineEventRow, TimelineRepository
from ..db.rls import user_scoped_tx
from .ambient_speaker import inline_speaker_text

# Per-tick catch-up cap (one prompt's worth); a backlog drains over next ticks.
_CATCHUP_LIMIT = 500
# An event is "backfill" (just connected, not just happened) when it arrived
# well after it occurred (large ingested_at − occurred_at gap).
_BACKFILL_THRESHOLD = timedelta(hours=2)
# Heartbeat body char budget (chat caps input at 40000; stay well under).
_HEARTBEAT_CHAR_BUDGET = 36000


@dataclass(slots=True)
class HeartbeatWindow:
    """A computed heartbeat input + the window it covers (for the tick SSE
    frame + cursor advance)."""

    text: str
    window_start: datetime
    window_end: datetime
    event_count: int
    advance_to: datetime  # cursor target: window_end, or batch max if capped


async def build_heartbeat_message(
    pool: AsyncConnectionPool, user_id: int, *, session_id: str
) -> HeartbeatWindow:
    """Compute a heartbeat turn's input: the timeline window since the session's
    last_tick_at cursor up to NOW (this tick's moment). Called by the scheduler
    at enqueue time (plan §十七). Reads profile timezone + cursor + timeline
    (web only — chat can't touch DB)."""
    now = datetime.now(UTC)
    async with user_scoped_tx(pool, user_id) as conn:
        prof = await ProfileRepository(user_id, conn).get_profile()
        window_start = await ProactiveRepository(user_id, conn).get_last_tick_at(
            thread_id=session_id
        )
    tz_name = (prof.timezone if prof and prof.timezone else None) or "UTC"
    events = await _query_since_ingested(pool, user_id, after=window_start, before=now)
    text = _format_heartbeat(now, window_start, events, tz_name)
    # Normal (batch < cap): consumed up to now → advance to it. Capped: a
    # backlog remains → advance only to the batch's max ingested_at so the next
    # tick continues draining (no skip).
    advance_to = now if len(events) < _CATCHUP_LIMIT else max(e.ingested_at for e in events)
    return HeartbeatWindow(
        text=text,
        window_start=window_start,
        window_end=now,
        event_count=len(events),
        advance_to=advance_to,
    )


async def _query_since_ingested(
    pool: AsyncConnectionPool, user_id: int, *, after: datetime, before: datetime
) -> list[TimelineEventRow]:
    """Events that ARRIVED (ingested_at) in (after, before], ingestion order.
    Consuming by ingestion (not occurred_at) lets a just-connected connector's
    backdated items + any backlog-while-off reach the agent."""
    async with user_scoped_tx(pool, user_id) as conn:
        return await TimelineRepository(user_id, conn).list_since_ingested(
            after=after, before=before, limit=_CATCHUP_LIMIT
        )


def _day_part(hour: int) -> str:
    if 5 <= hour < 12:
        return "morning"
    if 12 <= hour < 17:
        return "afternoon"
    if 17 <= hour < 22:
        return "evening"
    return "night"


def _fmt_event_time(dt: datetime, tz: ZoneInfo, today: Any) -> str:
    """HH:MM for events on the current local day; full date+time otherwise (so
    a backdated/backfilled event isn't read as 'happening now')."""
    local = dt.astimezone(tz)
    if local.date() == today:
        return local.strftime("%H:%M")
    return local.strftime("%Y-%m-%d %H:%M")


def _format_heartbeat(
    now_dt: datetime, window_start: datetime, events: list[TimelineEventRow], tz_name: str
) -> str:
    try:
        tz = ZoneInfo(tz_name)
    except Exception:
        tz = ZoneInfo("UTC")
    local = now_dt.astimezone(tz)
    today = local.date()
    head = (
        f"[heartbeat] {local.strftime('%Y-%m-%d %H:%M')} "
        f"({local.strftime('%A')}, {_day_part(local.hour)})"
    )
    ws = _fmt_event_time(window_start, tz, today)
    we = local.strftime("%H:%M")
    if not events:
        body = "— no new events —"
    else:
        # Closest-to-now first (recent past + imminent future) so distant
        # events sink to the bottom. Tag those that occurred well before they
        # arrived as [backfill]. Truncate to a char budget (rest → "+N more").
        ordered = sorted(events, key=lambda e: abs((e.occurred_at - now_dt).total_seconds()))
        lines: list[str] = []
        used = 0
        for e in ordered:
            backfill = (e.ingested_at - e.occurred_at) > _BACKFILL_THRESHOLD
            ts = _fmt_event_time(e.occurred_at, tz, today)
            tag = " [backfill]" if backfill else ""
            # Ambient utterances carry diarized speaker attribution; render
            # `self: "..."  speaker_1: "..."` so the agent can weight the
            # user's own speech. Other sources keep their title.
            content = inline_speaker_text(e.metadata) or e.title
            line = f"{ts}{tag}  {e.source}  {content}"
            if used + len(line) + 1 > _HEARTBEAT_CHAR_BUDGET:
                lines.append(f"… (+{len(ordered) - len(lines)} more newly-arrived events)")
                break
            lines.append(line)
            used += len(line) + 1
        body = "\n".join(lines)
    return f"{head}\n\nNew since last check ({ws}–{we}):\n{body}"
