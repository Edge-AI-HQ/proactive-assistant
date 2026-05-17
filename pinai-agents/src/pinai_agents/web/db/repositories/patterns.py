"""Pattern library repository.

Owns the shared (cross-user) `pai_card_patterns` + `pai_card_pattern_demos`
tables seeded from `docs/data/patterns.yaml` + `docs/data/demo_cards.yaml`.

These tables are *not* user-scoped: every reviewer sees the same library.
We still construct the repository inside a `user_scoped_tx` because that's
how the rest of the dashboard surface is wired and it keeps RLS context
consistent. The SQL itself does not filter by user_id.

Phase 1 was read-only; Phase 4 adds reviewer edit + status flip +
demo-from-golden-card upsert (see docs/plans/2026-05-15-pattern-driven-card-generation.mdx).
"""

from __future__ import annotations

import json
import uuid
from datetime import date, datetime
from typing import Any

from .base import UserScopedRepository

VALID_PATTERN_STATUSES = {"pending_review", "active", "retired"}
VALID_PATTERN_TIERS = {"cold_start_friendly", "warmup", "mature"}
VALID_SURPRISE_LEVELS = {"h", "m", "l"}


def _iso(value: Any) -> Any:
    if isinstance(value, datetime | date):
        return value.isoformat()
    return value


def _json_value(value: Any, *, default: Any) -> Any:
    if value is None:
        return default
    if isinstance(value, str):
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            return default
    return value


def _text_value(value: Any) -> str | None:
    if isinstance(value, str):
        stripped = value.strip()
        return stripped or None
    return None


def _demo_source_summary(card_json: Any, signals_used: Any) -> list[str]:
    card = _json_value(card_json, default={})
    signals = _json_value(signals_used, default=[])
    if isinstance(card, dict):
        source_data = card.get("sourceData")
        if isinstance(source_data, list):
            labels = [
                _text_value(item.get("label")) or _text_value(item.get("signal"))
                for item in source_data
                if isinstance(item, dict)
            ]
            compact = [label for label in labels if label]
            if compact:
                return compact[:5]
    if isinstance(signals, list):
        return [str(signal) for signal in signals[:5]]
    return []


def _pattern_to_wire(row: dict[str, Any]) -> dict[str, Any]:
    demo_card = _json_value(row.get("demo_card_json"), default={})
    return {
        "id": row["id"],
        "category": row["category"],
        "abstract": row["abstract"],
        "humanInsight": row.get("human_insight") or "",
        "signalsRequired": _json_value(row.get("signals_required"), default=[]),
        "triggerDsl": _json_value(row.get("trigger_dsl"), default=[]),
        "intent": row["intent"],
        "cardSkeleton": _json_value(row.get("card_skeleton"), default={}),
        "specializations": _json_value(row.get("specializations"), default=[]),
        "surpriseInit": row.get("surprise_init"),
        "practicalInit": row.get("practical_init"),
        "tier": row["tier"],
        "status": row["status"],
        "source": row["source"],
        "baseHitRate": float(row["base_hit_rate"]) if row.get("base_hit_rate") is not None else 0.0,
        "demoTitle": (
            _text_value(demo_card.get("title"))
            or _text_value(demo_card.get("hook"))
            if isinstance(demo_card, dict)
            else None
        ),
        "demoSourceDataSummary": _demo_source_summary(
            row.get("demo_card_json"),
            row.get("demo_signals_used"),
        ),
        "createdAt": _iso(row.get("created_at")),
        "updatedAt": _iso(row.get("updated_at")),
        "retiredAt": _iso(row.get("retired_at")),
    }


def _demo_to_wire(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": row["id"],
        "patternId": row["pattern_id"],
        "subtype": row.get("subtype"),
        "scenario": row["scenario"],
        "card": _json_value(row.get("card_json"), default={}),
        "signalsUsed": _json_value(row.get("signals_used"), default=[]),
        "whySurprise": row.get("why_surprise"),
        "whyPractical": row.get("why_practical"),
        "wowLevel": row.get("wow_level"),
        "source": row["source"],
        "redacted": bool(row.get("redacted")),
        "sourceCardId": row.get("source_card_id"),
        "createdAt": _iso(row.get("created_at")),
    }


class PatternsRepository(UserScopedRepository):
    """Phase 1: read-only access to pai_card_patterns + pai_card_pattern_demos."""

    async def list_patterns(
        self,
        *,
        category: str | None = None,
        status: str | None = None,
        surprise: str | None = None,
        tier: str | None = None,
        intent: str | None = None,
        limit: int = 200,
        offset: int = 0,
    ) -> list[dict[str, Any]]:
        if status is not None and status not in VALID_PATTERN_STATUSES:
            msg = f"invalid pattern status: {status}"
            raise ValueError(msg)
        if tier is not None and tier not in VALID_PATTERN_TIERS:
            msg = f"invalid pattern tier: {tier}"
            raise ValueError(msg)
        if surprise is not None and surprise not in VALID_SURPRISE_LEVELS:
            msg = f"invalid surprise: {surprise}"
            raise ValueError(msg)

        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                SELECT
                  p.*,
                  d.card_json AS demo_card_json,
                  d.signals_used AS demo_signals_used
                FROM pai_card_patterns p
                LEFT JOIN LATERAL (
                  SELECT card_json, signals_used
                  FROM pai_card_pattern_demos
                  WHERE pattern_id = p.id
                  ORDER BY created_at ASC, id ASC
                  LIMIT 1
                ) d ON TRUE
                WHERE (%s::text IS NULL OR p.category = %s)
                  AND (%s::text IS NULL OR p.status = %s)
                  AND (%s::text IS NULL OR p.surprise_init = %s)
                  AND (%s::text IS NULL OR p.tier = %s)
                  AND (%s::text IS NULL OR p.intent = %s)
                ORDER BY p.category ASC, p.id ASC
                LIMIT %s OFFSET %s
                """,
                (
                    category, category,
                    status, status,
                    surprise, surprise,
                    tier, tier,
                    intent, intent,
                    limit, offset,
                ),
            )
            rows = await cur.fetchall()
        return [_pattern_to_wire(r) for r in rows]

    async def count_patterns(
        self,
        *,
        category: str | None = None,
        status: str | None = None,
        surprise: str | None = None,
        tier: str | None = None,
        intent: str | None = None,
    ) -> int:
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                SELECT COUNT(*)::int AS total
                FROM pai_card_patterns
                WHERE (%s::text IS NULL OR category = %s)
                  AND (%s::text IS NULL OR status = %s)
                  AND (%s::text IS NULL OR surprise_init = %s)
                  AND (%s::text IS NULL OR tier = %s)
                  AND (%s::text IS NULL OR intent = %s)
                """,
                (
                    category, category,
                    status, status,
                    surprise, surprise,
                    tier, tier,
                    intent, intent,
                ),
            )
            row = await cur.fetchone()
        return int(row["total"]) if row else 0

    async def list_facets(self) -> dict[str, list[str]]:
        """Distinct values for filter UI."""
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                SELECT
                  COALESCE(array_agg(DISTINCT category ORDER BY category), '{}') AS categories,
                  COALESCE(array_agg(DISTINCT intent ORDER BY intent), '{}') AS intents
                FROM pai_card_patterns
                """,
            )
            row = await cur.fetchone()
        if row is None:
            return {"categories": [], "intents": []}
        return {
            "categories": list(row.get("categories") or []),
            "intents": list(row.get("intents") or []),
        }

    async def delete_pattern(self, pattern_id: str) -> bool:
        async with self._conn.cursor() as cur:
            await cur.execute(
                "DELETE FROM pai_card_patterns WHERE id = %s",
                (pattern_id,),
            )
            return cur.rowcount > 0

    async def get_pattern(self, pattern_id: str) -> dict[str, Any] | None:
        async with self._conn.cursor() as cur:
            await cur.execute(
                "SELECT * FROM pai_card_patterns WHERE id = %s",
                (pattern_id,),
            )
            row = await cur.fetchone()
        return _pattern_to_wire(row) if row is not None else None

    async def list_recent_hits(
        self, pattern_id: str, *, limit: int = 25,
    ) -> list[dict[str, Any]]:
        """Recent (user, card_id, opened?, reviewer_score, evaluator_overall)
        rows for one pattern. Used by /patterns/:id "Recent matched cards"."""
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                SELECT
                  h.user_id, h.run_id, h.card_id, h.subtype,
                  h.evidence, h.combined_score, h.pattern_grounding_ok,
                  h.created_at,
                  BOOL_OR(ro.event_type = 'card_open') AS opened,
                  MAX(rs.score)::real AS reviewer_score,
                  MAX(ev.overall)::real AS evaluator_overall
                FROM pai_card_pattern_hits h
                LEFT JOIN pai_card_reward_events ro
                  ON ro.user_id = h.user_id AND ro.card_id = h.card_id
                 AND ro.source = 'user' AND ro.event_type = 'card_open'
                LEFT JOIN pai_card_reward_events rs
                  ON rs.user_id = h.user_id AND rs.card_id = h.card_id
                 AND rs.source = 'reviewer' AND rs.event_type = 'reviewer_score'
                LEFT JOIN pai_card_evaluations ev
                  ON ev.user_id = h.user_id AND ev.card_id = h.card_id
                WHERE h.pattern_id = %s
                GROUP BY h.user_id, h.run_id, h.card_id, h.subtype,
                         h.evidence, h.combined_score, h.pattern_grounding_ok,
                         h.created_at
                ORDER BY h.created_at DESC
                LIMIT %s
                """,
                (pattern_id, limit),
            )
            rows = await cur.fetchall()
        return [
            {
                "userId": int(r["user_id"]),
                "runId": r["run_id"],
                "cardId": r["card_id"],
                "subtype": r.get("subtype"),
                "evidence": _json_value(r.get("evidence"), default={}),
                "combinedScore": float(r["combined_score"]) if r.get("combined_score") is not None else None,
                "patternGroundingOk": bool(r.get("pattern_grounding_ok")) if r.get("pattern_grounding_ok") is not None else None,
                "opened": bool(r.get("opened")),
                "reviewerScore": float(r["reviewer_score"]) if r.get("reviewer_score") is not None else None,
                "evaluatorOverall": float(r["evaluator_overall"]) if r.get("evaluator_overall") is not None else None,
                "evaluatorHumanGap": (
                    abs(float(r["evaluator_overall"]) - float(r["reviewer_score"]))
                    if r.get("evaluator_overall") is not None and r.get("reviewer_score") is not None
                    else None
                ),
                "createdAt": _iso(r.get("created_at")),
            }
            for r in rows
        ]

    async def list_demos_for_pattern(self, pattern_id: str) -> list[dict[str, Any]]:
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                SELECT *
                FROM pai_card_pattern_demos
                WHERE pattern_id = %s
                ORDER BY created_at ASC, id ASC
                """,
                (pattern_id,),
            )
            rows = await cur.fetchall()
        return [_demo_to_wire(r) for r in rows]

    async def update_pattern(
        self,
        pattern_id: str,
        *,
        abstract: str | None = None,
        human_insight: str | None = None,
        category: str | None = None,
        intent: str | None = None,
        tier: str | None = None,
        surprise_init: str | None = None,
        practical_init: str | None = None,
        signals_required: list[Any] | None = None,
        trigger_dsl: list[Any] | None = None,
        card_skeleton: dict[str, Any] | None = None,
        specializations: list[Any] | None = None,
    ) -> dict[str, Any] | None:
        """Reviewer-driven update. Only fields the caller supplies are
        touched — None means "keep existing"."""
        if tier is not None and tier not in VALID_PATTERN_TIERS:
            msg = f"invalid pattern tier: {tier}"
            raise ValueError(msg)
        if surprise_init is not None and surprise_init not in VALID_SURPRISE_LEVELS:
            msg = f"invalid surprise: {surprise_init}"
            raise ValueError(msg)
        if practical_init is not None and practical_init not in VALID_SURPRISE_LEVELS:
            msg = f"invalid practical: {practical_init}"
            raise ValueError(msg)
        sets: list[str] = []
        params: list[Any] = []
        if abstract is not None:
            sets.append("abstract = %s")
            params.append(abstract)
        if human_insight is not None:
            sets.append("human_insight = %s")
            params.append(human_insight)
        if category is not None:
            sets.append("category = %s")
            params.append(category)
        if intent is not None:
            sets.append("intent = %s")
            params.append(intent)
        if tier is not None:
            sets.append("tier = %s")
            params.append(tier)
        if surprise_init is not None:
            sets.append("surprise_init = %s")
            params.append(surprise_init)
        if practical_init is not None:
            sets.append("practical_init = %s")
            params.append(practical_init)
        if signals_required is not None:
            sets.append("signals_required = %s::jsonb")
            params.append(json.dumps(signals_required))
        if trigger_dsl is not None:
            sets.append("trigger_dsl = %s::jsonb")
            params.append(json.dumps(trigger_dsl))
        if card_skeleton is not None:
            sets.append("card_skeleton = %s::jsonb")
            params.append(json.dumps(card_skeleton))
        if specializations is not None:
            sets.append("specializations = %s::jsonb")
            params.append(json.dumps(specializations))
        if not sets:
            return await self.get_pattern(pattern_id)
        sets.append("updated_at = NOW()")
        params.append(pattern_id)
        async with self._conn.cursor() as cur:
            await cur.execute(
                f"UPDATE pai_card_patterns SET {', '.join(sets)} WHERE id = %s RETURNING *",
                params,
            )
            row = await cur.fetchone()
        return _pattern_to_wire(row) if row else None

    async def set_status(self, pattern_id: str, status: str) -> dict[str, Any] | None:
        if status not in VALID_PATTERN_STATUSES:
            msg = f"invalid pattern status: {status}"
            raise ValueError(msg)
        retired_clause = (
            "retired_at = NOW()" if status == "retired" else "retired_at = NULL"
        )
        async with self._conn.cursor() as cur:
            await cur.execute(
                f"""
                UPDATE pai_card_patterns
                SET status = %s, {retired_clause}, updated_at = NOW()
                WHERE id = %s
                RETURNING *
                """,
                (status, pattern_id),
            )
            row = await cur.fetchone()
        return _pattern_to_wire(row) if row else None

    async def insert_demo_from_card(
        self,
        pattern_id: str,
        *,
        card: dict[str, Any],
        subtype: str | None = None,
        scenario: str = "",
        signals_used: list[Any] | None = None,
        why_surprise: str | None = None,
        why_practical: str | None = None,
        wow_level: int | None = None,
        source: str = "golden",
        source_card_id: str | None = None,
        redacted: bool = True,
    ) -> dict[str, Any]:
        """Promote an existing card snapshot into pai_card_pattern_demos.
        `source` is 'golden' or 'anti'."""
        if source not in {"golden", "anti", "seed"}:
            msg = f"invalid demo source: {source}"
            raise ValueError(msg)
        demo_id = f"demo:{pattern_id}:{source}:{uuid.uuid4().hex[:8]}"
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                INSERT INTO pai_card_pattern_demos
                  (id, pattern_id, subtype, scenario, card_json, signals_used,
                   why_surprise, why_practical, wow_level, source, redacted,
                   source_card_id)
                VALUES (%s, %s, %s, %s, %s::jsonb, %s::jsonb,
                        %s, %s, %s, %s, %s, %s)
                RETURNING *
                """,
                (
                    demo_id, pattern_id, subtype, scenario,
                    json.dumps(card, ensure_ascii=False),
                    json.dumps(signals_used or []),
                    why_surprise, why_practical, wow_level,
                    source, redacted, source_card_id,
                ),
            )
            row = await cur.fetchone()
        if row is None:
            msg = "demo insert returned no row"
            raise RuntimeError(msg)
        return _demo_to_wire(row)
