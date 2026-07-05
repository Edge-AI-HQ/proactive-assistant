"""Window rollup — the api-side, synchronous, no-LLM half of the rollup stage
(doc §4.2). Aggregate periodic-state device raw into ONE event per window
instead of 1→1, so周期 snapshots don't刷屏 L1.

(The semantic half — firehose → episode, LLM — is agent-engine's rollup_semantic;
projector skips those. The off half is projector's 1→1. This module is window.)

Today the only window source is device `health`: roll up observations by
(local_date, metric) into one `movement` event per day per metric.

Why complete-days-only (local_date < current_date): an in-progress day keeps
receiving observations, so its aggregate (sum/last/…) would be stale the moment
it's written and the events dedupe_key won't update it. So a day waits until it
closes; until then its health stays in L0 pai_raw_device (raw.list can read it).
health is day-grained ("yesterday's steps"), so a one-day lag is acceptable in
exchange for a stable, idempotent aggregate (no supersede churn).
"""

from __future__ import annotations

from psycopg import AsyncConnection
from psycopg.rows import DictRow

from ..events import AppendEventInput, EventsRepository, gen_event_id


async def project_window_health(conn: AsyncConnection[DictRow], user_id: int) -> int:
    """Roll up complete-day device health observations into one event per
    (local_date, metric). Returns events appended. Idempotent — the NOT EXISTS
    skips days/metrics already rolled, and the events dedupe_key no-ops a re-roll."""
    async with conn.cursor() as cur:
        # Aggregate per (local_date, metric) over complete days. Skip groups that
        # already have their window event (NOT EXISTS on the deterministic
        # dedupe_key), so re-runs after each ingest only touch fresh closed days.
        await cur.execute(
            """
            SELECT
              payload->>'local_date' AS local_date,
              payload->>'metric' AS metric,
              count(*) AS n,
              sum((payload->>'value')::float) AS sum_v,
              min((payload->>'value')::float) AS min_v,
              max((payload->>'value')::float) AS max_v,
              (array_agg(payload->>'value' ORDER BY occurred_at DESC))[1] AS last_v,
              max(payload->>'unit') AS unit,
              min(occurred_at) AS day_start,
              min(id) AS rep_id
            FROM pai_raw_device r
            WHERE r.user_id = %s
              AND r.kind = 'health'
              AND payload->>'local_date' IS NOT NULL
              AND payload->>'metric' IS NOT NULL
              AND (payload->>'local_date')::date < current_date
              AND NOT EXISTS (
                SELECT 1 FROM pai_events e
                WHERE e.user_id = r.user_id
                  AND e.dedupe_key =
                    'window:health:' || (payload->>'local_date') || ':' || (payload->>'metric')
              )
            GROUP BY payload->>'local_date', payload->>'metric'
            """,
            (user_id,),
        )
        groups = await cur.fetchall()

    repo = EventsRepository(user_id, conn)
    appended = 0
    for g in groups:
        local_date, metric = g["local_date"], g["metric"]
        await repo.append(
            AppendEventInput(
                id=gen_event_id(),
                source="device",
                event_type="movement",  # health → movement (matches projector's map)
                occurred_at=g["day_start"],
                dedupe_key=f"window:health:{local_date}:{metric}",
                title=f"{metric} ({local_date})",
                structured={
                    "rollup": "window",
                    "date": local_date,
                    "metric": metric,
                    "count": g["n"],
                    "sum": g["sum_v"],
                    "min": g["min_v"],
                    "max": g["max_v"],
                    "last": g["last_v"],
                    "unit": g["unit"],
                },
                source_ref=g["rep_id"],  # representative raw id; full set is the day's health raw
                curated=False,
            )
        )
        appended += 1
    return appended
