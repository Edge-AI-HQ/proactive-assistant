"""Pattern health metrics + auto-retire logic.

Per docs/plans/2026-05-15-pattern-driven-card-generation.mdx Phase 5:

    | Metric                      | Calc                                          | Retire threshold |
    | --------------------------- | --------------------------------------------- | ---------------- |
    | hit_rate_7d                 | hit / (hit + miss) over last 7d               | < 0.15           |
    | hit_rate_30d_trend          | 30d hit_rate slope                            | < -0.5 and hit_rate_30d > 0.3 |
    | dismiss_rate                | dismiss / total over last 30d                 | > 0.6            |
    | evaluator_human_gap_mean    | mean(abs(evaluator - reviewer)) over 30d      | > 3              |

We don't have a separate "reviewer" stream in Phase 5 — reviewer scores
come through `pai_card_reward_events.source='reviewer'`. evaluator
overall comes from `pai_card_evaluations.overall`. The job runs daily
and walks every active pattern, computing the four metrics and updating
`pai_card_patterns.base_hit_rate` so the matcher's combined score reacts.

This module exposes two surfaces:
  * `compute_pattern_health` — pure read; returns a list of dicts the
    `/patterns/health` endpoint serializes.
  * `run_pattern_health_job` — same compute + auto-retire side effects.
    Scheduler / cron wires this up; it's idempotent within a single day
    (retiring an already-retired pattern is a no-op).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

from psycopg import AsyncConnection
from psycopg.rows import DictRow

logger = logging.getLogger(__name__)


HIT_RATE_7D_FLOOR = 0.15
DISMISS_RATE_CEILING = 0.6
EVALUATOR_HUMAN_GAP_CEILING = 3.0
TREND_SLOPE_FLOOR = -0.5
TREND_MIN_HIT_RATE = 0.3


@dataclass(slots=True)
class PatternHealthRow:
    pattern_id: str
    category: str
    status: str
    hit_count_7d: int
    hit_count_30d: int
    dismiss_count_30d: int
    hit_rate_7d: float | None
    hit_rate_30d: float | None
    hit_rate_30d_trend: float | None
    dismiss_rate_30d: float | None
    evaluator_human_gap_mean: float | None
    base_hit_rate: float
    should_retire: bool
    retire_reasons: list[str]

    def to_wire(self) -> dict[str, Any]:
        return {
            "patternId": self.pattern_id,
            "category": self.category,
            "status": self.status,
            "hitCount7d": self.hit_count_7d,
            "hitCount30d": self.hit_count_30d,
            "dismissCount30d": self.dismiss_count_30d,
            "hitRate7d": self.hit_rate_7d,
            "hitRate30d": self.hit_rate_30d,
            "hitRate30dTrend": self.hit_rate_30d_trend,
            "dismissRate30d": self.dismiss_rate_30d,
            "evaluatorHumanGapMean": self.evaluator_human_gap_mean,
            "baseHitRate": self.base_hit_rate,
            "shouldRetire": self.should_retire,
            "retireReasons": self.retire_reasons,
        }


async def compute_pattern_health_one(
    conn: AsyncConnection[DictRow],
    pattern_id: str,
) -> PatternHealthRow | None:
    """Single-pattern variant for the detail page (avoids scanning the
    whole library on every GET /patterns/{id})."""
    rows = await compute_pattern_health(conn, pattern_id=pattern_id)
    return rows[0] if rows else None


async def compute_pattern_health(
    conn: AsyncConnection[DictRow],
    *,
    pattern_id: str | None = None,
) -> list[PatternHealthRow]:
    """Compute health metrics across patterns in one SQL pass.
    When `pattern_id` is supplied, restrict to that one pattern."""
    async with conn.cursor() as cur:
        await cur.execute(
            """
            WITH hit_windows AS (
              SELECT
                pattern_id,
                COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days')::int  AS hits_7d,
                COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days')::int AS hits_30d,
                COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '60 days'
                                  AND created_at < NOW() - INTERVAL '30 days')::int AS hits_prev_30d
              FROM pai_card_pattern_hits
              GROUP BY pattern_id
            ),
            -- For each pattern, derive a per-card "did the user open/dismiss" view
            -- by joining hits to reward events on (user_id, card_id).
            card_outcomes AS (
              SELECT
                h.pattern_id,
                h.user_id,
                h.card_id,
                h.created_at AS hit_at,
                BOOL_OR(re.event_type = 'card_open') AS opened,
                BOOL_OR(re.event_type = 'dismiss') AS dismissed
              FROM pai_card_pattern_hits h
              LEFT JOIN pai_card_reward_events re
                ON re.user_id = h.user_id AND re.card_id = h.card_id
               AND re.source = 'user'
              WHERE h.created_at >= NOW() - INTERVAL '30 days'
              GROUP BY h.pattern_id, h.user_id, h.card_id, h.created_at
            ),
            window_rates AS (
              SELECT
                pattern_id,
                COUNT(*)::int AS card_count_30d,
                SUM(CASE WHEN opened THEN 1 ELSE 0 END)::int AS opens_30d,
                SUM(CASE WHEN dismissed THEN 1 ELSE 0 END)::int AS dismisses_30d,
                AVG(CASE WHEN opened THEN 1.0
                         WHEN dismissed THEN 0.0
                         ELSE NULL END)::float8 AS hit_rate_30d,
                AVG(CASE WHEN hit_at >= NOW() - INTERVAL '7 days'
                          THEN CASE WHEN opened THEN 1.0
                                    WHEN dismissed THEN 0.0
                                    ELSE NULL END END)::float8 AS hit_rate_7d,
                AVG(CASE WHEN hit_at >= NOW() - INTERVAL '60 days'
                          AND hit_at < NOW() - INTERVAL '30 days'
                          THEN CASE WHEN opened THEN 1.0
                                    WHEN dismissed THEN 0.0
                                    ELSE NULL END END)::float8 AS hit_rate_prev_30d
              FROM card_outcomes
              GROUP BY pattern_id
            ),
            evaluator_gap AS (
              SELECT
                h.pattern_id,
                AVG(ABS(ev.overall - re.score))::float8 AS gap_mean
              FROM pai_card_pattern_hits h
              JOIN pai_card_evaluations ev
                ON ev.user_id = h.user_id AND ev.card_id = h.card_id
              JOIN pai_card_reward_events re
                ON re.user_id = h.user_id AND re.card_id = h.card_id
               AND re.source = 'reviewer' AND re.event_type = 'reviewer_score'
              WHERE h.created_at >= NOW() - INTERVAL '30 days'
                AND ev.overall IS NOT NULL AND re.score IS NOT NULL
              GROUP BY h.pattern_id
            )
            SELECT
              p.id AS pattern_id,
              p.category,
              p.status,
              p.base_hit_rate,
              COALESCE(hw.hits_7d, 0) AS hits_7d,
              COALESCE(hw.hits_30d, 0) AS hits_30d,
              COALESCE(wr.dismisses_30d, 0) AS dismisses_30d,
              wr.hit_rate_7d,
              wr.hit_rate_30d,
              (wr.hit_rate_30d - wr.hit_rate_prev_30d) AS hit_rate_trend,
              CASE
                WHEN wr.card_count_30d IS NULL OR wr.card_count_30d = 0 THEN NULL
                ELSE wr.dismisses_30d::float8 / wr.card_count_30d::float8
              END AS dismiss_rate_30d,
              eg.gap_mean AS evaluator_human_gap_mean
            FROM pai_card_patterns p
            LEFT JOIN hit_windows hw ON hw.pattern_id = p.id
            LEFT JOIN window_rates wr ON wr.pattern_id = p.id
            LEFT JOIN evaluator_gap eg ON eg.pattern_id = p.id
            WHERE %s::text IS NULL OR p.id = %s
            ORDER BY p.id
            """,
            (pattern_id, pattern_id),
        )
        rows = await cur.fetchall()

    out: list[PatternHealthRow] = []
    for r in rows:
        hit_rate_7d = r.get("hit_rate_7d")
        hit_rate_30d = r.get("hit_rate_30d")
        trend = r.get("hit_rate_trend")
        dismiss_rate = r.get("dismiss_rate_30d")
        gap = r.get("evaluator_human_gap_mean")

        reasons: list[str] = []
        if hit_rate_7d is not None and hit_rate_7d < HIT_RATE_7D_FLOOR:
            reasons.append(f"hit_rate_7d<{HIT_RATE_7D_FLOOR}")
        if (
            trend is not None
            and trend < TREND_SLOPE_FLOOR
            and hit_rate_30d is not None
            and hit_rate_30d > TREND_MIN_HIT_RATE
        ):
            reasons.append("declining_trend")
        if dismiss_rate is not None and dismiss_rate > DISMISS_RATE_CEILING:
            reasons.append(f"dismiss_rate>{DISMISS_RATE_CEILING}")
        if gap is not None and gap > EVALUATOR_HUMAN_GAP_CEILING:
            reasons.append(f"eval_human_gap>{EVALUATOR_HUMAN_GAP_CEILING}")

        out.append(
            PatternHealthRow(
                pattern_id=r["pattern_id"],
                category=r["category"],
                status=r["status"],
                hit_count_7d=int(r.get("hits_7d") or 0),
                hit_count_30d=int(r.get("hits_30d") or 0),
                dismiss_count_30d=int(r.get("dismisses_30d") or 0),
                hit_rate_7d=hit_rate_7d,
                hit_rate_30d=hit_rate_30d,
                hit_rate_30d_trend=trend,
                dismiss_rate_30d=dismiss_rate,
                evaluator_human_gap_mean=gap,
                base_hit_rate=float(r.get("base_hit_rate") or 0.0),
                should_retire=bool(reasons),
                retire_reasons=reasons,
            )
        )
    return out


async def run_pattern_health_job(conn: AsyncConnection[DictRow]) -> dict[str, Any]:
    """Daily job entry point. Updates base_hit_rate + auto-retires.

    Returns a small summary the scheduler can log.
    """
    rows = await compute_pattern_health(conn)
    updates = 0
    retires = 0
    async with conn.cursor() as cur:
        for r in rows:
            # Always refresh base_hit_rate from the 30d window so the
            # matcher's combined score reflects the latest signal.
            if r.hit_rate_30d is not None:
                await cur.execute(
                    "UPDATE pai_card_patterns SET base_hit_rate = %s WHERE id = %s",
                    (r.hit_rate_30d, r.pattern_id),
                )
                updates += 1
            # Auto-retire only ACTIVE patterns whose metrics tripped a
            # threshold. Once retired we leave them alone (reviewer
            # decides whether to revive).
            if r.should_retire and r.status == "active":
                await cur.execute(
                    """
                    UPDATE pai_card_patterns
                    SET status = 'retired', retired_at = NOW(), updated_at = NOW()
                    WHERE id = %s AND status = 'active'
                    """,
                    (r.pattern_id,),
                )
                retires += 1
                logger.info(
                    "pattern auto-retired id=%s reasons=%s",
                    r.pattern_id,
                    r.retire_reasons,
                )
    logger.info("pattern_health: updated=%d retired=%d", updates, retires)
    return {"updates": updates, "retires": retires, "total": len(rows)}
