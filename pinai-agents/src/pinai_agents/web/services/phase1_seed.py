"""Web-side phase1 seed for the pattern matcher.

The full phase1 collector lives inside the chat sandbox
(`chat/agents/generator.py` → data-collector subagent). It assembles
a deep view of the user's signals via `pinai_sdk` HTTP calls. That
result is not available before chat runs, so the web-side dispatcher
needs its own coarse snapshot to feed `pattern_matcher.match_patterns`.

This service intentionally pulls only what's cheap from existing
repository methods:
  * Recent personal signals counts grouped by source
  * Open commitments / birthdays from `pai_memory` (text + tags)
  * World signal recency
  * Profile facts
  * A few derived shapes the matcher's op-specific evaluators look for
    (gmail.unresponded_to_vip, calendar.events)

Every query is wrapped in a per-section try/except so a missing column
or empty table never breaks the matcher — the matcher already treats
"no data" as "no match", which is the safe default.
"""

from __future__ import annotations

import json
import logging
from datetime import UTC, datetime, timedelta
from typing import Any

from psycopg import AsyncConnection

logger = logging.getLogger(__name__)


async def build_phase1_seed(conn: AsyncConnection, user_id: int) -> dict[str, Any]:
    """Best-effort coarse phase1 for the matcher.

    Schema layout matches what the matcher's op-specific evaluators look
    for: `phase1.calendar.events`, `phase1.gmail.unresponded_to_vip`,
    `phase1.memory.recurring_obligations`, etc.
    """
    return {
        "personal_signals": await _collect_personal_signals_summary(conn, user_id),
        "memory": await _collect_memory(conn, user_id),
        "world": await _collect_world_summary(conn, user_id),
        "calendar": await _collect_calendar(conn, user_id),
        "gmail": await _collect_gmail(conn, user_id),
        "profile": await _collect_profile(conn, user_id),
    }


async def _collect_personal_signals_summary(
    conn: AsyncConnection,
    user_id: int,
) -> dict[str, Any]:
    try:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                SELECT source, COUNT(*)::int AS n,
                       MAX(occurred_at) AS last_seen
                FROM pai_personal_signals
                WHERE user_id = %s AND status = 'open'
                GROUP BY source
                """,
                (user_id,),
            )
            rows = await cur.fetchall()
    except Exception:
        logger.debug("phase1_seed: personal_signals query failed user=%d", user_id, exc_info=True)
        return {"counts": {}, "open_total": 0}

    counts = {r["source"]: int(r["n"]) for r in rows}
    return {
        "counts": counts,
        "open_total": sum(counts.values()),
        "last_seen_at_max": _iso(max((r["last_seen"] for r in rows), default=None)),
    }


async def _collect_memory(conn: AsyncConnection, user_id: int) -> dict[str, Any]:
    """Pull memory rows that smell like recurring obligations / birthdays
    so `birthday_within_days` / `anniversary_within_days` can fire.

    `pai_memory` has text + subject + tags (jsonb array) — we scan for
    birthday / anniversary keywords in text + subject. Date parsing is
    best-effort: memories often store dates only in free text.
    """
    try:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                SELECT id, text, subject, tags, occurred_at, created_at
                FROM pai_memory
                WHERE user_id = %s
                  AND status = 'active'
                  AND (
                    text ILIKE '%%birthday%%'
                    OR text ILIKE '%%生日%%'
                    OR text ILIKE '%%anniversary%%'
                    OR text ILIKE '%%纪念日%%'
                    OR subject ILIKE '%%birthday%%'
                    OR subject ILIKE '%%anniversary%%'
                    OR tags @> '"recurring_obligation"'::jsonb
                  )
                ORDER BY created_at DESC
                LIMIT 50
                """,
                (user_id,),
            )
            rows = await cur.fetchall()
    except Exception:
        logger.debug("phase1_seed: memory query failed user=%d", user_id, exc_info=True)
        return {"recurring_obligations": []}

    obligations: list[dict[str, Any]] = []
    for r in rows:
        obligations.append(
            {
                "id": r["id"],
                "type": "birthday"
                if "birthday" in (r.get("text") or "").lower() or "生日" in (r.get("text") or "")
                else "recurring",
                "text": r.get("text"),
                "subject": r.get("subject"),
                "next_occurrence": _iso(r.get("occurred_at")),
                "tags": _ensure_list(r.get("tags")),
            }
        )
    return {"recurring_obligations": obligations}


async def _collect_world_summary(
    conn: AsyncConnection,
    user_id: int,
) -> dict[str, Any]:
    try:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                SELECT MAX(scored_at) AS most_recent,
                       COUNT(*) FILTER (WHERE scored_at >= NOW() - INTERVAL '24 hours')::int AS recent_24h
                FROM pai_world_signal_user_view
                WHERE user_id = %s
                """,
                (user_id,),
            )
            row = await cur.fetchone()
    except Exception:
        logger.debug("phase1_seed: world query failed user=%d", user_id, exc_info=True)
        return {}
    return {
        "most_recent": _iso(row.get("most_recent")) if row else None,
        "recent_24h_count": int((row or {}).get("recent_24h") or 0),
    }


async def _collect_calendar(conn: AsyncConnection, user_id: int) -> dict[str, Any]:
    """Calendar events arrive as pai_personal_signals.source='calendar'
    rows. The connector stores the event body in `payload`; the start
    time is `occurred_at`."""
    horizon = datetime.now(UTC) + timedelta(days=30)
    try:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                SELECT id, title, summary, payload, occurred_at
                FROM pai_personal_signals
                WHERE user_id = %s
                  AND source = 'calendar'
                  AND status = 'open'
                  AND occurred_at IS NOT NULL
                  AND occurred_at <= %s
                ORDER BY occurred_at ASC
                LIMIT 50
                """,
                (user_id, horizon),
            )
            rows = await cur.fetchall()
    except Exception:
        logger.debug("phase1_seed: calendar query failed user=%d", user_id, exc_info=True)
        return {"events": []}

    events: list[dict[str, Any]] = []
    for r in rows:
        payload = _ensure_dict(r.get("payload"))
        events.append(
            {
                "id": r.get("id"),
                "title": r.get("title") or payload.get("title"),
                "summary": r.get("summary"),
                "subtype": payload.get("subtype") or payload.get("event_type"),
                "start": _iso(r.get("occurred_at")),
                **{
                    k: v
                    for k, v in payload.items()
                    if k not in {"title", "subtype", "event_type", "start"}
                },
            }
        )
    return {"events": events}


async def _collect_gmail(conn: AsyncConnection, user_id: int) -> dict[str, Any]:
    """Surface pai_personal_signals.source='gmail' items flagged is_vip
    in their payload so `unresponded_to_vip` can fire."""
    try:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                SELECT id, payload, occurred_at,
                       EXTRACT(EPOCH FROM (NOW() - occurred_at))/86400 AS days_open
                FROM pai_personal_signals
                WHERE user_id = %s
                  AND source = 'gmail'
                  AND status = 'open'
                  AND (payload->>'is_vip')::boolean = true
                ORDER BY occurred_at ASC
                LIMIT 50
                """,
                (user_id,),
            )
            rows = await cur.fetchall()
    except Exception:
        logger.debug("phase1_seed: gmail query failed user=%d", user_id, exc_info=True)
        return {"unresponded_to_vip": []}

    threads: list[dict[str, Any]] = []
    for r in rows:
        payload = _ensure_dict(r.get("payload"))
        threads.append(
            {
                "thread_id": payload.get("thread_id") or r.get("id"),
                "days_open": float(r.get("days_open") or 0),
            }
        )
    return {"unresponded_to_vip": threads}


async def _collect_profile(conn: AsyncConnection, user_id: int) -> dict[str, Any]:
    try:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                SELECT display_name, locale, timezone, summary, facts
                FROM pai_profile
                WHERE user_id = %s
                LIMIT 1
                """,
                (user_id,),
            )
            row = await cur.fetchone()
    except Exception:
        logger.debug("phase1_seed: profile query failed user=%d", user_id, exc_info=True)
        return {}
    if row is None:
        return {}
    return {
        "display_name": row.get("display_name"),
        "locale": row.get("locale"),
        "timezone": row.get("timezone"),
        "summary": row.get("summary"),
        "facts": _ensure_dict(row.get("facts")),
    }


def _iso(value: Any) -> Any:
    if isinstance(value, datetime):
        return value.isoformat()
    return value


def _ensure_dict(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if isinstance(value, str) and value:
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return {}


def _ensure_list(value: Any) -> list[Any]:
    if isinstance(value, list):
        return value
    if isinstance(value, str) and value:
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return []
        return parsed if isinstance(parsed, list) else []
    return []
