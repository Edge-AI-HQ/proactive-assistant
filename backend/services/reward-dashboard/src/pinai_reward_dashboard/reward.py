"""Reward dashboard repository.

Owns the internal card reward surface:
  * append-only reward ledger (`pai_card_reward_events`)
  * human-curated casebook (`pai_card_casebook`)
  * deterministic trace artifacts (`pai_trace_artifacts`)

The repository is user-scoped like the rest of the web DB layer. Routes
must construct it inside `user_scoped_tx`.
"""

from __future__ import annotations

import json
import uuid
from collections import defaultdict
from datetime import UTC, date, datetime, timedelta
from typing import Any, Literal

from pinai_db.base import UserScopedRepository

RewardSource = Literal["user", "reviewer", "system"]
RewardEventType = Literal[
    "card_open",
    "user_score",
    "reviewer_score",
    "dismiss",
    "imported_feedback",
]
CasebookLabel = Literal[
    "great",
    "bad",
    "surprising",
    "generic",
    "hallucinated",
    "duplicate",
    "mistimed",
    "weak_source",
]
TraceStatus = Literal["pending", "ready", "missing", "failed"]

VALID_SOURCES = {"user", "reviewer", "system"}
VALID_EVENT_TYPES = {
    "card_open",
    "user_score",
    "reviewer_score",
    "dismiss",
    "imported_feedback",
}
VALID_CASEBOOK_LABELS = {
    "great",
    "bad",
    "surprising",
    "generic",
    "hallucinated",
    "duplicate",
    "mistimed",
    "weak_source",
}
VALID_TRACE_STATUSES = {"pending", "ready", "missing", "failed"}


def _iso(value: Any) -> Any:
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, dict):
        return {k: _iso(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_iso(v) for v in value]
    return value


def _json_obj(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if isinstance(value, str) and value:
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return {}


def _as_float(value: Any) -> float | None:
    if value is None:
        return None
    return float(value)


def _require_score(score: float | None, *, event_type: str) -> None:
    if event_type in {"user_score", "reviewer_score"} and score is None:
        msg = f"{event_type} requires score"
        raise ValueError(msg)
    if event_type in {"user_score", "reviewer_score"} and score is not None and score < 1:
        msg = f"{event_type} score must be between 1 and 10"
        raise ValueError(msg)
    if score is not None and not 0 <= score <= 10:
        msg = "score must be between 0 and 10"
        raise ValueError(msg)


def _validate_event_pair(source: str, event_type: str) -> None:
    valid_pairs = {
        "card_open": {"user"},
        "user_score": {"user"},
        "reviewer_score": {"reviewer"},
        "dismiss": {"user"},
        "imported_feedback": {"system"},
    }
    if source not in valid_pairs.get(event_type, set()):
        msg = f"invalid reward source/event_type pair: {source}/{event_type}"
        raise ValueError(msg)


def _evaluation_to_wire(row: dict[str, Any] | None) -> dict[str, Any] | None:
    if row is None:
        return None
    return {
        "cardId": row["card_id"],
        "runId": row["run_id"],
        "intentKey": row.get("intent_key"),
        "basket": row.get("basket"),
        "dimensions": {
            "relevance": _as_float(row.get("dim_relevance")),
            "actionability": _as_float(row.get("dim_actionability")),
            "whyNowClarity": _as_float(row.get("dim_why_now")),
            "novelty": _as_float(row.get("dim_novelty")),
            "decisionCompression": _as_float(row.get("dim_decision_compress")),
        },
        "overall": _as_float(row.get("overall")),
        "pass": bool(row.get("pass")),
        "evaluator": row.get("evaluator"),
        "feedback": row.get("feedback_text"),
        "evaluatedAt": _iso(row.get("evaluated_at")),
    }


def _reward_event_to_wire(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": row["id"],
        "runId": row["run_id"],
        "cardId": row["card_id"],
        "source": row["source"],
        "eventType": row["event_type"],
        "score": _as_float(row.get("score")),
        "reason": row.get("reason"),
        "metadata": _json_obj(row.get("metadata")),
        "createdAt": _iso(row.get("created_at")),
    }


def _casebook_to_wire(row: dict[str, Any] | None) -> dict[str, Any] | None:
    if row is None:
        return None
    return {
        "id": row["id"],
        "runId": row["run_id"],
        "cardId": row["card_id"],
        "label": row["label"],
        "scoreSnapshot": _as_float(row.get("score_snapshot")),
        "reviewerNote": row.get("reviewer_note"),
        "snapshot": _json_obj(row.get("snapshot")),
        "createdAt": _iso(row.get("created_at")),
        "updatedAt": _iso(row.get("updated_at")),
    }


def _trace_to_wire(row: dict[str, Any] | None) -> dict[str, Any] | None:
    if row is None:
        return None
    trace_tree = _json_obj(row.get("trace_tree"))
    summary = _json_obj(row.get("summary"))
    langsmith_url = trace_tree.get("langsmithUrl") or summary.get("langsmithUrl")
    return {
        "runId": row["run_id"],
        "langsmithTraceId": row.get("langsmith_trace_id"),
        "langsmithUrl": langsmith_url if isinstance(langsmith_url, str) else None,
        "status": row["status"],
        "traceTree": trace_tree,
        "summary": summary,
        "imageFormat": row.get("image_format"),
        "imagePath": row.get("image_path"),
        "error": row.get("error"),
        "generatedAt": _iso(row.get("generated_at")),
    }


def _fold_rewards(events: list[dict[str, Any]]) -> dict[str, Any]:
    latest_user_score: float | None = None
    latest_user_score_at: str | None = None
    latest_reviewer_score: float | None = None
    latest_reviewer_score_at: str | None = None
    opened = False

    # Events are expected newest-first. First score seen per source wins.
    for event in events:
        source = event.get("source")
        event_type = event.get("event_type")
        if source == "user" and event_type == "card_open":
            opened = True
        elif source == "user" and event_type == "user_score" and latest_user_score is None:
            latest_user_score = _as_float(event.get("score"))
            latest_user_score_at = _iso(event.get("created_at"))
        elif (
            source == "reviewer"
            and event_type == "reviewer_score"
            and latest_reviewer_score is None
        ):
            latest_reviewer_score = _as_float(event.get("score"))
            latest_reviewer_score_at = _iso(event.get("created_at"))

    user_reward = latest_user_score if latest_user_score is not None else (1.0 if opened else 0.0)
    return {
        "userReward": user_reward,
        "reviewerReward": latest_reviewer_score,
        "displayReward": user_reward,
        "opened": opened,
        "latestUserScoreAt": latest_user_score_at,
        "latestReviewerScoreAt": latest_reviewer_score_at,
    }


class RewardRepository(UserScopedRepository):
    async def list_runs(
        self,
        *,
        limit: int = 50,
        trigger: str | None = None,
        since: datetime | None = None,
        until: datetime | None = None,
        reviewed: bool | None = None,
        quality: Literal["aha", "dead", "reviewer_aha"] | None = None,
    ) -> list[dict[str, Any]]:
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                WITH selected_runs AS (
                  SELECT id, run_id, status, trigger, started_at, completed_at, final_cards
                  FROM pai_pipeline_runs
                  WHERE user_id = %s
                    AND jsonb_typeof(final_cards) = 'array'
                    AND (%s::text IS NULL OR trigger = %s)
                    AND (%s::timestamptz IS NULL OR completed_at >= %s)
                    AND (%s::timestamptz IS NULL OR completed_at <= %s)
                ),
                cards AS (
                  SELECT
                    r.id, r.run_id, r.status, r.trigger, r.started_at, r.completed_at,
                    c.card,
                    c.card->>'id' AS card_id
                  FROM selected_runs r
                  LEFT JOIN LATERAL jsonb_array_elements(
                    CASE
                      WHEN jsonb_typeof(r.final_cards) = 'array' THEN r.final_cards
                      ELSE '[]'::jsonb
                    END
                  )
                    AS c(card) ON jsonb_typeof(c.card) = 'object'
                ),
                latest_user_score AS (
                  SELECT DISTINCT ON (card_id)
                    card_id, score, created_at
                  FROM pai_card_reward_events
                  WHERE user_id = %s
                    AND source = 'user'
                    AND event_type = 'user_score'
                  ORDER BY card_id, created_at DESC
                ),
                opened AS (
                  SELECT DISTINCT card_id
                  FROM pai_card_reward_events
                  WHERE user_id = %s
                    AND source = 'user'
                    AND event_type = 'card_open'
                ),
                latest_reviewer_score AS (
                  SELECT DISTINCT ON (card_id)
                    card_id, score, created_at
                  FROM pai_card_reward_events
                  WHERE user_id = %s
                    AND source = 'reviewer'
                    AND event_type = 'reviewer_score'
                  ORDER BY card_id, created_at DESC
                ),
                aggregated AS (
                  SELECT
                    c.id,
                    c.run_id,
                    c.status,
                    c.trigger,
                    c.started_at,
                    c.completed_at,
                    COUNT(c.card_id)::int AS card_count,
                    AVG(
                      CASE WHEN c.card_id IS NOT NULL
                        THEN COALESCE(us.score, CASE WHEN o.card_id IS NOT NULL THEN 1.0 ELSE 0.0 END)
                      END
                    ) AS avg_user_reward,
                    AVG(rs.score) FILTER (WHERE rs.score IS NOT NULL) AS avg_reviewer_reward,
                    (
                      SUM(
                        CASE
                          WHEN c.card_id IS NOT NULL
                           AND COALESCE(us.score, CASE WHEN o.card_id IS NOT NULL THEN 1.0 ELSE 0.0 END) = 0
                          THEN 1 ELSE 0
                        END
                      )::float / NULLIF(COUNT(c.card_id), 0)
                    ) AS dead_card_rate,
                    (
                      SUM(
                        CASE
                          WHEN c.card_id IS NOT NULL
                           AND COALESCE(us.score, CASE WHEN o.card_id IS NOT NULL THEN 1.0 ELSE 0.0 END) >= 8
                          THEN 1 ELSE 0
                        END
                      )::float / NULLIF(COUNT(c.card_id), 0)
                    ) AS aha_rate,
                    COUNT(rs.card_id)::int AS reviewed_count,
                    COUNT(DISTINCT cb.card_id)::int AS casebook_count,
                    AVG(e.overall) AS avg_evaluator_overall,
                    COALESCE(t.status, 'missing') AS trace_status,
                    EXTRACT(EPOCH FROM (
                      MIN(rs.created_at) FILTER (WHERE rs.created_at IS NOT NULL)
                      - c.completed_at
                    )) / 3600.0 AS review_latency_hours
                  FROM cards c
                  LEFT JOIN latest_user_score us ON us.card_id = c.card_id
                  LEFT JOIN opened o ON o.card_id = c.card_id
                  LEFT JOIN latest_reviewer_score rs ON rs.card_id = c.card_id
                  LEFT JOIN pai_card_evaluations e
                    ON e.user_id = %s AND e.run_id = c.run_id AND e.card_id = c.card_id
                  LEFT JOIN pai_card_casebook cb
                    ON cb.user_id = %s AND cb.card_id = c.card_id
                  LEFT JOIN pai_trace_artifacts t
                    ON t.user_id = %s AND t.run_id = c.run_id
                  GROUP BY
                    c.id, c.run_id, c.status, c.trigger, c.started_at, c.completed_at, t.status
                )
                SELECT *
                FROM aggregated
                WHERE (%s::bool IS NULL OR (reviewed_count > 0) = %s)
                  AND (
                    %s::text IS NULL
                    OR (%s = 'aha' AND aha_rate > 0)
                    OR (%s = 'dead' AND dead_card_rate > 0)
                    OR (%s = 'reviewer_aha' AND avg_reviewer_reward >= 8)
                  )
                ORDER BY completed_at DESC NULLS LAST, started_at DESC
                LIMIT %s
                """,
                (
                    self._user_id,
                    trigger,
                    trigger,
                    since,
                    since,
                    until,
                    until,
                    self._user_id,
                    self._user_id,
                    self._user_id,
                    self._user_id,
                    self._user_id,
                    self._user_id,
                    reviewed,
                    reviewed,
                    quality,
                    quality,
                    quality,
                    quality,
                    limit,
                ),
            )
            rows = await cur.fetchall()

        return [self._run_summary_to_wire(r) for r in rows]

    async def metrics(self, *, days: int = 14) -> dict[str, Any]:
        since = datetime.now(UTC) - timedelta(days=days)
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                WITH runs AS (
                  SELECT run_id, completed_at, final_cards
                  FROM pai_pipeline_runs
                  WHERE user_id = %s
                    AND completed_at >= %s
                    AND jsonb_typeof(final_cards) = 'array'
                ),
                cards AS (
                  SELECT
                    r.run_id,
                    date_trunc('day', r.completed_at)::date AS day,
                    c.card->>'id' AS card_id
                  FROM runs r
                  CROSS JOIN LATERAL jsonb_array_elements(
                    CASE
                      WHEN jsonb_typeof(r.final_cards) = 'array' THEN r.final_cards
                      ELSE '[]'::jsonb
                    END
                  ) AS c(card)
                  WHERE jsonb_typeof(c.card) = 'object'
                ),
                latest_user_score AS (
                  SELECT DISTINCT ON (card_id) card_id, score
                  FROM pai_card_reward_events
                  WHERE user_id = %s AND source = 'user' AND event_type = 'user_score'
                  ORDER BY card_id, created_at DESC
                ),
                opened AS (
                  SELECT DISTINCT card_id
                  FROM pai_card_reward_events
                  WHERE user_id = %s AND source = 'user' AND event_type = 'card_open'
                ),
                latest_reviewer_score AS (
                  SELECT DISTINCT ON (card_id) card_id, score
                  FROM pai_card_reward_events
                  WHERE user_id = %s AND source = 'reviewer' AND event_type = 'reviewer_score'
                  ORDER BY card_id, created_at DESC
                ),
                daily_cards AS (
                  SELECT
                    c.day,
                    COUNT(*)::int AS card_count,
                    AVG(COALESCE(us.score, CASE WHEN o.card_id IS NOT NULL THEN 1.0 ELSE 0.0 END))
                      AS avg_user_reward,
                    AVG(rs.score) FILTER (WHERE rs.score IS NOT NULL) AS avg_reviewer_reward,
                    SUM(
                      CASE
                        WHEN COALESCE(us.score, CASE WHEN o.card_id IS NOT NULL THEN 1.0 ELSE 0.0 END) = 0
                        THEN 1 ELSE 0
                      END
                    )::float / NULLIF(COUNT(*), 0) AS dead_card_rate,
                    SUM(
                      CASE
                        WHEN COALESCE(us.score, CASE WHEN o.card_id IS NOT NULL THEN 1.0 ELSE 0.0 END) >= 8
                        THEN 1 ELSE 0
                      END
                    )::float / NULLIF(COUNT(*), 0) AS aha_rate,
                    COUNT(rs.card_id)::int AS reviewed_count
                  FROM cards c
                  LEFT JOIN latest_user_score us ON us.card_id = c.card_id
                  LEFT JOIN opened o ON o.card_id = c.card_id
                  LEFT JOIN latest_reviewer_score rs ON rs.card_id = c.card_id
                  GROUP BY c.day
                ),
                daily_cases AS (
                  SELECT date_trunc('day', created_at)::date AS day, COUNT(*)::int AS casebook_growth
                  FROM pai_card_casebook
                  WHERE user_id = %s AND created_at >= %s
                  GROUP BY 1
                )
                SELECT
                  COALESCE(dc.day, dcase.day) AS day,
                  COALESCE(card_count, 0)::int AS card_count,
                  avg_user_reward,
                  avg_reviewer_reward,
                  dead_card_rate,
                  aha_rate,
                  COALESCE(reviewed_count, 0)::int AS reviewed_count,
                  COALESCE(casebook_growth, 0)::int AS casebook_growth
                FROM daily_cards dc
                FULL OUTER JOIN daily_cases dcase ON dcase.day = dc.day
                ORDER BY day ASC
                """,
                (
                    self._user_id,
                    since,
                    self._user_id,
                    self._user_id,
                    self._user_id,
                    self._user_id,
                    since,
                ),
            )
            rows = await cur.fetchall()
        return {
            "days": days,
            "series": [
                {
                    "day": _iso(r["day"]),
                    "cardCount": r["card_count"],
                    "avgUserReward": _as_float(r.get("avg_user_reward")),
                    "avgReviewerReward": _as_float(r.get("avg_reviewer_reward")),
                    "deadCardRate": _as_float(r.get("dead_card_rate")),
                    "ahaRate": _as_float(r.get("aha_rate")),
                    "reviewedCount": r["reviewed_count"],
                    "casebookGrowth": r["casebook_growth"],
                }
                for r in rows
            ],
        }

    async def get_run_detail(self, run_id: str) -> dict[str, Any] | None:
        run = await self._get_run(run_id)
        if run is None:
            return None
        cards = [
            c
            for c in (run.get("final_cards") or [])
            if isinstance(c, dict) and isinstance(c.get("id"), str)
        ]
        card_ids = [c["id"] for c in cards]
        evaluations = await self._evaluations_for_cards(card_ids)
        histories = await self._reward_histories(card_ids)
        casebook = await self._casebook_for_cards(card_ids)
        feedback = await self._feedback_for_cards(card_ids)
        cards_out: list[dict[str, Any]] = []
        for card in cards:
            cid = card["id"]
            events = histories.get(cid, [])
            cards_out.append(
                {
                    "card": card,
                    "evaluation": evaluations.get(cid),
                    "rewards": _fold_rewards(events),
                    "rewardHistory": [_reward_event_to_wire(e) for e in events],
                    "casebook": casebook.get(cid),
                    "feedbackEvents": feedback.get(cid, []),
                }
            )
        return {
            "run": self._run_to_wire(run),
            "cards": cards_out,
            "trace": await self.get_trace_artifact(run["run_id"]),
        }

    async def get_card_detail(self, card_id: str) -> dict[str, Any] | None:
        card_row = await self._find_card(card_id)
        if card_row is None:
            return None
        run = {
            k: card_row[k]
            for k in (
                "id",
                "run_id",
                "status",
                "trigger",
                "started_at",
                "completed_at",
                "total_iterations",
                "error",
            )
            if k in card_row
        }
        card = card_row["card"]
        evaluations = await self._evaluations_for_cards([card_id])
        histories = await self._reward_histories([card_id])
        casebook = await self._casebook_for_cards([card_id])
        feedback = await self._feedback_for_cards([card_id])
        related = await self._related_cards(card)
        events = histories.get(card_id, [])
        return {
            "run": self._run_to_wire(run),
            "card": card,
            "evaluation": evaluations.get(card_id),
            "rewards": _fold_rewards(events),
            "rewardHistory": [_reward_event_to_wire(e) for e in events],
            "casebook": casebook.get(card_id),
            "feedbackEvents": feedback.get(card_id, []),
            "trace": await self.get_trace_artifact(run["run_id"]),
            "relatedCards": related,
        }

    async def create_reward_event(
        self,
        *,
        card_id: str,
        source: str,
        event_type: str,
        score: float | None = None,
        run_id: str | None = None,
        reason: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        if source not in VALID_SOURCES:
            msg = f"invalid reward source: {source}"
            raise ValueError(msg)
        if event_type not in VALID_EVENT_TYPES:
            msg = f"invalid reward event_type: {event_type}"
            raise ValueError(msg)
        _validate_event_pair(source, event_type)
        if event_type == "card_open":
            score = 1.0
        _require_score(score, event_type=event_type)
        resolved_run_id = run_id or await self._resolve_card_run_id(card_id)
        if resolved_run_id is None:
            msg = "card not found"
            raise LookupError(msg)
        if not await self._card_exists_in_run(card_id=card_id, run_id=resolved_run_id):
            msg = "card not found in run"
            raise LookupError(msg)

        event_id = f"reward_{uuid.uuid4().hex[:16]}"
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                INSERT INTO pai_card_reward_events
                  (user_id, id, run_id, card_id, source, event_type, score, reason, metadata)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb)
                RETURNING *
                """,
                (
                    self._user_id,
                    event_id,
                    resolved_run_id,
                    card_id,
                    source,
                    event_type,
                    score,
                    reason,
                    json.dumps(metadata or {}),
                ),
            )
            row = await cur.fetchone()
        if row is None:
            msg = "reward insert returned no row"
            raise RuntimeError(msg)
        # Phase 3: fan out the event to the per-user pattern + intent
        # fingerprint so the matcher can use it to score future candidates.
        # Restricted to user-side events (open / user_score / dismiss) —
        # reviewer scores adjust the global hit_rate via Phase 5 health
        # job, not the per-user fingerprint.
        if source == "user" and event_type in {"card_open", "dismiss", "user_score"}:
            await self._fanout_fingerprint(
                card_id=card_id,
                event_type=event_type,
                score=score,
            )
        return _reward_event_to_wire(row)

    async def _fanout_fingerprint(
        self,
        *,
        card_id: str,
        event_type: str,
        score: float | None,
    ) -> None:
        """Update fingerprint rows for whichever patterns hit on this card."""
        from pinai_db.repositories.user_fingerprint import (  # noqa: PLC0415
            UserFingerprintRepository,
        )

        fp = UserFingerprintRepository(self._user_id, self._conn)
        pattern_ids = await fp.patterns_for_card(card_id)
        # Resolve intent/basket from the card's stored JSON (best-effort;
        # missing values are fine, the fingerprint row stays untouched).
        card_row = await self._find_card(card_id)
        card_blob = card_row.get("card") if card_row else None
        intent = None
        basket = None
        if isinstance(card_blob, dict):
            intent = card_blob.get("intentKey") or card_blob.get("intent_key")
            basket = card_blob.get("goalBasket") or card_blob.get("goal_basket")
        # Treat a low user_score as a dismiss-like signal for the fingerprint;
        # explicit open + high score are positive.
        is_positive = event_type == "card_open" or (
            event_type == "user_score" and (score is None or score >= 5)
        )
        if is_positive:
            await fp.record_open(
                pattern_ids=pattern_ids,
                intent=intent if isinstance(intent, str) else None,
                basket=basket if isinstance(basket, str) else None,
            )
        else:
            await fp.record_dismiss(
                pattern_ids=pattern_ids,
                intent=intent if isinstance(intent, str) else None,
                basket=basket if isinstance(basket, str) else None,
            )

    async def upsert_casebook(
        self,
        *,
        card_id: str,
        label: str,
        reviewer_note: str | None = None,
    ) -> dict[str, Any]:
        if label not in VALID_CASEBOOK_LABELS:
            msg = f"invalid casebook label: {label}"
            raise ValueError(msg)
        detail = await self.get_card_detail(card_id)
        if detail is None:
            msg = "card not found"
            raise LookupError(msg)
        rewards = detail["rewards"]
        score_snapshot = (
            rewards.get("reviewerReward")
            if rewards.get("reviewerReward") is not None
            else rewards.get("displayReward")
        )
        snapshot = {
            "card": detail["card"],
            "evaluation": detail["evaluation"],
            "rewards": rewards,
            "sources": detail["card"].get("sources") if isinstance(detail["card"], dict) else [],
            "run": detail["run"],
        }
        case_id = f"case_{uuid.uuid4().hex[:16]}"
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                INSERT INTO pai_card_casebook
                  (user_id, id, run_id, card_id, label, score_snapshot, reviewer_note, snapshot)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s::jsonb)
                ON CONFLICT (user_id, card_id) DO UPDATE SET
                  label = EXCLUDED.label,
                  reviewer_note = EXCLUDED.reviewer_note,
                  score_snapshot = EXCLUDED.score_snapshot,
                  snapshot = pai_card_casebook.snapshot,
                  updated_at = NOW()
                RETURNING *
                """,
                (
                    self._user_id,
                    case_id,
                    detail["run"]["runId"],
                    card_id,
                    label,
                    score_snapshot,
                    reviewer_note,
                    json.dumps(snapshot),
                ),
            )
            row = await cur.fetchone()
        if row is None:
            msg = "casebook upsert returned no row"
            raise RuntimeError(msg)
        return _casebook_to_wire(row) or {}

    async def delete_casebook(self, card_id: str) -> bool:
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                DELETE FROM pai_card_casebook
                WHERE user_id = %s AND card_id = %s
                """,
                (self._user_id, card_id),
            )
            return cur.rowcount > 0

    async def list_casebook(
        self,
        *,
        label: str | None = None,
        min_score: float | None = None,
        max_score: float | None = None,
        basket: str | None = None,
        intent: str | None = None,
        min_evaluator_gap: float | None = None,
        since: datetime | None = None,
        until: datetime | None = None,
        limit: int = 100,
        offset: int = 0,
    ) -> list[dict[str, Any]]:
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                SELECT *,
                  COALESCE(snapshot->'card'->>'goalBasket', snapshot->'card'->>'goal_basket') AS card_basket,
                  COALESCE(snapshot->'card'->>'intentKey', snapshot->'card'->>'intent_key') AS card_intent,
                  ABS(
                    NULLIF(snapshot->'evaluation'->>'overall', '')::real
                    - score_snapshot
                  ) AS evaluator_gap
                FROM pai_card_casebook
                WHERE user_id = %s
                  AND (%s::text IS NULL OR label = %s)
                  AND (%s::real IS NULL OR score_snapshot >= %s)
                  AND (%s::real IS NULL OR score_snapshot <= %s)
                  AND (
                    %s::text IS NULL
                    OR COALESCE(snapshot->'card'->>'goalBasket', snapshot->'card'->>'goal_basket') = %s
                  )
                  AND (
                    %s::text IS NULL
                    OR COALESCE(snapshot->'card'->>'intentKey', snapshot->'card'->>'intent_key') ILIKE ('%%' || %s || '%%')
                  )
                  AND (
                    %s::real IS NULL
                    OR ABS(NULLIF(snapshot->'evaluation'->>'overall', '')::real - score_snapshot) >= %s
                  )
                  AND (%s::timestamptz IS NULL OR updated_at >= %s)
                  AND (%s::timestamptz IS NULL OR updated_at <= %s)
                ORDER BY updated_at DESC
                LIMIT %s
                OFFSET %s
                """,
                (
                    self._user_id,
                    label,
                    label,
                    min_score,
                    min_score,
                    max_score,
                    max_score,
                    basket,
                    basket,
                    intent,
                    intent,
                    min_evaluator_gap,
                    min_evaluator_gap,
                    since,
                    since,
                    until,
                    until,
                    limit,
                    offset,
                ),
            )
            rows = await cur.fetchall()
        return [c for row in rows if (c := _casebook_to_wire(row)) is not None]

    async def count_casebook(
        self,
        *,
        label: str | None = None,
        min_score: float | None = None,
        max_score: float | None = None,
        basket: str | None = None,
        intent: str | None = None,
        min_evaluator_gap: float | None = None,
        since: datetime | None = None,
        until: datetime | None = None,
    ) -> int:
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                SELECT COUNT(*)::int AS total
                FROM pai_card_casebook
                WHERE user_id = %s
                  AND (%s::text IS NULL OR label = %s)
                  AND (%s::real IS NULL OR score_snapshot >= %s)
                  AND (%s::real IS NULL OR score_snapshot <= %s)
                  AND (
                    %s::text IS NULL
                    OR COALESCE(snapshot->'card'->>'goalBasket', snapshot->'card'->>'goal_basket') = %s
                  )
                  AND (
                    %s::text IS NULL
                    OR COALESCE(snapshot->'card'->>'intentKey', snapshot->'card'->>'intent_key') ILIKE ('%%' || %s || '%%')
                  )
                  AND (
                    %s::real IS NULL
                    OR ABS(NULLIF(snapshot->'evaluation'->>'overall', '')::real - score_snapshot) >= %s
                  )
                  AND (%s::timestamptz IS NULL OR updated_at >= %s)
                  AND (%s::timestamptz IS NULL OR updated_at <= %s)
                """,
                (
                    self._user_id,
                    label,
                    label,
                    min_score,
                    min_score,
                    max_score,
                    max_score,
                    basket,
                    basket,
                    intent,
                    intent,
                    min_evaluator_gap,
                    min_evaluator_gap,
                    since,
                    since,
                    until,
                    until,
                ),
            )
            row = await cur.fetchone()
        return int(row["total"]) if row else 0

    async def get_trace_artifact(self, run_id: str) -> dict[str, Any] | None:
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                SELECT *
                FROM pai_trace_artifacts
                WHERE user_id = %s AND run_id = %s
                """,
                (self._user_id, run_id),
            )
            row = await cur.fetchone()
        return _trace_to_wire(row)

    async def upsert_trace_artifact(
        self,
        *,
        run_id: str,
        status: str,
        trace_tree: dict[str, Any] | None = None,
        summary: dict[str, Any] | None = None,
        langsmith_trace_id: str | None = None,
        image_format: str = "svg",
        image_path: str | None = None,
        error: str | None = None,
    ) -> dict[str, Any]:
        if status not in VALID_TRACE_STATUSES:
            msg = f"invalid trace status: {status}"
            raise ValueError(msg)
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                INSERT INTO pai_trace_artifacts
                  (user_id, run_id, langsmith_trace_id, status, trace_tree, summary,
                   image_format, image_path, error, generated_at)
                VALUES (%s, %s, %s, %s, %s::jsonb, %s::jsonb, %s, %s, %s, NOW())
                ON CONFLICT (user_id, run_id) DO UPDATE SET
                  langsmith_trace_id = EXCLUDED.langsmith_trace_id,
                  status = EXCLUDED.status,
                  trace_tree = EXCLUDED.trace_tree,
                  summary = EXCLUDED.summary,
                  image_format = EXCLUDED.image_format,
                  image_path = EXCLUDED.image_path,
                  error = EXCLUDED.error,
                  generated_at = NOW()
                RETURNING *
                """,
                (
                    self._user_id,
                    run_id,
                    langsmith_trace_id,
                    status,
                    json.dumps(trace_tree or {}),
                    json.dumps(summary or {}),
                    image_format,
                    image_path,
                    error,
                ),
            )
            row = await cur.fetchone()
        if row is None:
            msg = "trace artifact upsert returned no row"
            raise RuntimeError(msg)
        return _trace_to_wire(row) or {}

    async def run_exists(self, run_id: str) -> bool:
        return await self._get_run(run_id) is not None

    async def resolve_run_id(self, run_id: str) -> str | None:
        run = await self._get_run(run_id)
        return str(run["run_id"]) if run is not None else None

    async def _get_run(self, run_id: str) -> dict[str, Any] | None:
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                SELECT *
                FROM pai_pipeline_runs
                WHERE user_id = %s
                  AND (
                    id = %s
                    OR run_id = %s
                    OR run_id LIKE %s
                  )
                ORDER BY (id = %s OR run_id = %s) DESC,
                         completed_at DESC NULLS LAST,
                         started_at DESC
                LIMIT 1
                """,
                (self._user_id, run_id, run_id, f"{run_id}.%", run_id, run_id),
            )
            return await cur.fetchone()

    async def _find_card(self, card_id: str) -> dict[str, Any] | None:
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                SELECT
                  r.id, r.run_id, r.status, r.trigger, r.started_at, r.completed_at,
                  r.total_iterations, r.error, c.card
                FROM pai_pipeline_runs r
                CROSS JOIN LATERAL jsonb_array_elements(
                  CASE
                    WHEN jsonb_typeof(r.final_cards) = 'array' THEN r.final_cards
                    ELSE '[]'::jsonb
                  END
                )
                  AS c(card)
                WHERE r.user_id = %s
                  AND jsonb_typeof(c.card) = 'object'
                  AND c.card->>'id' = %s
                ORDER BY r.completed_at DESC NULLS LAST, r.started_at DESC
                LIMIT 1
                """,
                (self._user_id, card_id),
            )
            return await cur.fetchone()

    async def _resolve_card_run_id(self, card_id: str) -> str | None:
        row = await self._find_card(card_id)
        return row["run_id"] if row else None

    async def _card_exists_in_run(self, *, card_id: str, run_id: str) -> bool:
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                SELECT 1
                FROM pai_pipeline_runs r
                CROSS JOIN LATERAL jsonb_array_elements(
                  CASE
                    WHEN jsonb_typeof(r.final_cards) = 'array' THEN r.final_cards
                    ELSE '[]'::jsonb
                  END
                )
                  AS c(card)
                WHERE r.user_id = %s
                  AND (r.id = %s OR r.run_id = %s)
                  AND jsonb_typeof(c.card) = 'object'
                  AND c.card->>'id' = %s
                LIMIT 1
                """,
                (self._user_id, run_id, run_id, card_id),
            )
            return await cur.fetchone() is not None

    async def _evaluations_for_cards(
        self,
        card_ids: list[str],
    ) -> dict[str, dict[str, Any] | None]:
        if not card_ids:
            return {}
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                SELECT *
                FROM pai_card_evaluations
                WHERE user_id = %s AND card_id = ANY(%s)
                """,
                (self._user_id, card_ids),
            )
            rows = await cur.fetchall()
        return {r["card_id"]: _evaluation_to_wire(r) for r in rows}

    async def _reward_histories(self, card_ids: list[str]) -> dict[str, list[dict[str, Any]]]:
        if not card_ids:
            return {}
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                SELECT *
                FROM pai_card_reward_events
                WHERE user_id = %s AND card_id = ANY(%s)
                ORDER BY created_at DESC
                """,
                (self._user_id, card_ids),
            )
            rows = await cur.fetchall()
        grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for row in rows:
            grouped[row["card_id"]].append(row)
        return grouped

    async def _casebook_for_cards(self, card_ids: list[str]) -> dict[str, dict[str, Any]]:
        if not card_ids:
            return {}
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                SELECT *
                FROM pai_card_casebook
                WHERE user_id = %s AND card_id = ANY(%s)
                """,
                (self._user_id, card_ids),
            )
            rows = await cur.fetchall()
        return {r["card_id"]: c for r in rows if (c := _casebook_to_wire(r)) is not None}

    async def _feedback_for_cards(self, card_ids: list[str]) -> dict[str, list[dict[str, Any]]]:
        if not card_ids:
            return {}
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                SELECT id, kind, action, intent_card_id, intent_key, source, basket,
                       value, text, metadata, conversation_id, message_id, channel, created_at
                FROM pai_feedback_events
                WHERE user_id = %s AND intent_card_id = ANY(%s)
                ORDER BY created_at DESC
                """,
                (self._user_id, card_ids),
            )
            rows = await cur.fetchall()
        grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for row in rows:
            grouped[row["intent_card_id"]].append(
                {
                    "id": row["id"],
                    "kind": row["kind"],
                    "action": row.get("action"),
                    "intentCardId": row.get("intent_card_id"),
                    "intentKey": row.get("intent_key"),
                    "source": row.get("source"),
                    "basket": row.get("basket"),
                    "value": row.get("value"),
                    "text": row.get("text"),
                    "metadata": _json_obj(row.get("metadata")),
                    "conversationId": row.get("conversation_id"),
                    "messageId": row.get("message_id"),
                    "channel": row.get("channel"),
                    "createdAt": _iso(row.get("created_at")),
                }
            )
        return grouped

    async def _related_cards(self, card: dict[str, Any]) -> list[dict[str, Any]]:
        intent_key = card.get("intentKey") or card.get("intent_key")
        card_id = card.get("id")
        if not isinstance(intent_key, str) or not intent_key:
            return []
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                SELECT r.run_id, r.completed_at, c.card
                FROM pai_pipeline_runs r
                CROSS JOIN LATERAL jsonb_array_elements(
                  CASE
                    WHEN jsonb_typeof(r.final_cards) = 'array' THEN r.final_cards
                    ELSE '[]'::jsonb
                  END
                )
                  AS c(card)
                WHERE r.user_id = %s
                  AND jsonb_typeof(c.card) = 'object'
                  AND (c.card->>'intentKey' = %s OR c.card->>'intent_key' = %s)
                  AND c.card->>'id' <> %s
                ORDER BY r.completed_at DESC NULLS LAST, r.started_at DESC
                LIMIT 10
                """,
                (self._user_id, intent_key, intent_key, card_id),
            )
            rows = await cur.fetchall()
        return [
            {
                "runId": r["run_id"],
                "completedAt": _iso(r.get("completed_at")),
                "card": r["card"],
            }
            for r in rows
        ]

    def _run_summary_to_wire(self, row: dict[str, Any]) -> dict[str, Any]:
        return {
            "id": row["id"],
            "runId": row["run_id"],
            "status": row.get("status"),
            "trigger": row.get("trigger"),
            "startedAt": _iso(row.get("started_at")),
            "completedAt": _iso(row.get("completed_at")),
            "cardCount": row.get("card_count") or 0,
            "avgUserReward": _as_float(row.get("avg_user_reward")),
            "avgReviewerReward": _as_float(row.get("avg_reviewer_reward")),
            "deadCardRate": _as_float(row.get("dead_card_rate")),
            "ahaRate": _as_float(row.get("aha_rate")),
            "reviewedCount": row.get("reviewed_count") or 0,
            "casebookCount": row.get("casebook_count") or 0,
            "avgEvaluatorOverall": _as_float(row.get("avg_evaluator_overall")),
            "traceStatus": row.get("trace_status") or "missing",
            "reviewLatencyHours": _as_float(row.get("review_latency_hours")),
        }

    def _run_to_wire(self, row: dict[str, Any]) -> dict[str, Any]:
        return {
            "id": row["id"],
            "runId": row["run_id"],
            "status": row.get("status"),
            "trigger": row.get("trigger"),
            "startedAt": _iso(row.get("started_at")),
            "completedAt": _iso(row.get("completed_at")),
            "totalIterations": row.get("total_iterations"),
            "error": row.get("error"),
        }
