"""Pattern extractor (Phase 6).

Per docs/plans/2026-05-15-pattern-driven-card-generation.mdx § "LLM 批量抽取":
  * Input: recent golden cards from `pai_card_casebook` (label='great')
    where the reviewer judged the cross-check passed.
  * Cluster by intent_key + evidence-type signature.
  * For each cluster ≥ MIN_CLUSTER_SIZE that doesn't already correspond
    to an existing active pattern, emit a `status='pending_review'`,
    `source='ai_extracted'` row so reviewer can audit on /patterns/pending.

Phase 6 acceptance is "weekly job + reviewer can approve". The plan
describes the LLM-driven path that generates the trigger DSL and
abstract; v0 here ships the deterministic cluster + stub-pattern path
so the workflow is exercisable end-to-end without an LLM round-trip.
Real LLM abstraction lives behind `_synthesize_pattern` — a hook for a
follow-up to call LiteLLM with a few-shot prompt over the cluster's
cards. Until that lands, the stub fills sensible defaults that the
reviewer is expected to edit on `/patterns/:patternId` before approval.

Idempotency: the extractor never overwrites an existing pattern. It
suppresses clusters whose intent_key already exists as an active or
pending pattern (i.e. nothing it would do is destructive).
"""

from __future__ import annotations

import logging
from collections import defaultdict
from dataclasses import dataclass
from typing import Any

from psycopg import AsyncConnection
from psycopg.rows import DictRow

logger = logging.getLogger(__name__)


MIN_CLUSTER_SIZE = 3
LOOKBACK_DAYS = 7
EXTRACTED_PATTERN_PREFIX = "ai_extracted__"


@dataclass(slots=True)
class ExtractedPatternCandidate:
    pattern_id: str
    intent_key: str
    cluster_size: int
    sample_card_ids: list[str]
    abstract: str

    def to_wire(self) -> dict[str, Any]:
        return {
            "patternId": self.pattern_id,
            "intentKey": self.intent_key,
            "clusterSize": self.cluster_size,
            "sampleCardIds": self.sample_card_ids,
            "abstract": self.abstract,
        }


async def run_pattern_extractor(
    conn: AsyncConnection[DictRow],
    *,
    lookback_days: int = LOOKBACK_DAYS,
    min_cluster_size: int = MIN_CLUSTER_SIZE,
) -> dict[str, Any]:
    """Read recent golden cards, cluster, write candidate patterns.

    Returns a summary the dashboard can render after a manual run, plus
    a list of inserted candidate ids so the UI can deep-link them.
    """
    rows = await _fetch_recent_golden(conn, lookback_days=lookback_days)
    clusters = _cluster_by_intent(rows)
    existing_intent_keys = await _existing_intent_keys(conn)

    candidates: list[ExtractedPatternCandidate] = []
    for intent_key, items in clusters.items():
        if len(items) < min_cluster_size:
            continue
        if intent_key in existing_intent_keys:
            # Already covered by an active/pending pattern — skip.
            continue
        pattern_id = _candidate_pattern_id(intent_key)
        candidate = _synthesize_pattern(pattern_id, intent_key, items)
        await _upsert_candidate(conn, candidate, items)
        candidates.append(candidate)

    summary = {
        "lookback_days": lookback_days,
        "min_cluster_size": min_cluster_size,
        "golden_cards_seen": len(rows),
        "clusters_total": len(clusters),
        "clusters_above_min": sum(
            1 for items in clusters.values() if len(items) >= min_cluster_size
        ),
        "candidates_inserted": len(candidates),
        "candidates": [c.to_wire() for c in candidates],
    }
    logger.info("pattern_extractor: %s", summary)
    return summary


async def _fetch_recent_golden(
    conn: AsyncConnection[DictRow],
    *,
    lookback_days: int,
) -> list[dict[str, Any]]:
    """Pull golden casebook entries from the last N days, joined with the
    card's evaluation row + the pattern hit (if any). The join lets us
    cluster by `intent_key` even when the casebook snapshot doesn't carry
    one directly.
    """
    async with conn.cursor() as cur:
        await cur.execute(
            """
            SELECT
              cb.id AS case_id,
              cb.user_id,
              cb.card_id,
              cb.run_id,
              cb.snapshot,
              cb.score_snapshot,
              cb.created_at,
              ev.intent_key,
              ev.basket,
              h.pattern_id AS existing_pattern_id
            FROM pai_card_casebook cb
            LEFT JOIN pai_card_evaluations ev
              ON ev.user_id = cb.user_id AND ev.card_id = cb.card_id
            LEFT JOIN pai_card_pattern_hits h
              ON h.user_id = cb.user_id AND h.card_id = cb.card_id
            WHERE cb.label = 'great'
              AND cb.created_at >= NOW() - make_interval(days => %s)
            ORDER BY cb.created_at DESC
            """,
            (lookback_days,),
        )
        rows = await cur.fetchall()
    return rows


def _cluster_by_intent(
    rows: list[dict[str, Any]],
) -> dict[str, list[dict[str, Any]]]:
    """Group golden cards by intent_key. Rows with no intent_key fall
    into a synthetic '__unintented__' bucket which won't pass the
    minimum-cluster gate so it's effectively ignored."""
    clusters: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        if row.get("existing_pattern_id"):
            # Card already attributed to a known pattern — skip; this is
            # not a *new* pattern, just a strong golden of an existing one.
            continue
        intent_key = row.get("intent_key")
        if not isinstance(intent_key, str) or not intent_key.strip():
            intent_key = "__unintented__"
        clusters[intent_key].append(row)
    return dict(clusters)


async def _existing_intent_keys(conn: AsyncConnection[DictRow]) -> set[str]:
    """intent_keys already covered by an active or pending pattern. We
    treat the pattern's `intent` column as the join key — patterns whose
    seed intent matches an extracted cluster's intent_key are considered
    "already covered" (reviewer doesn't want a duplicate)."""
    async with conn.cursor() as cur:
        await cur.execute(
            """
            SELECT DISTINCT intent FROM pai_card_patterns
            WHERE status IN ('active', 'pending_review')
            """,
        )
        rows = await cur.fetchall()
    return {r["intent"] for r in rows if isinstance(r.get("intent"), str)}


def _candidate_pattern_id(intent_key: str) -> str:
    # `intent_key` is already a kebab-case slug per PlanItem contract;
    # we just need a deterministic prefix so the extracted candidate is
    # distinguishable from human-curated seeds.
    safe = "".join(c if c.isalnum() or c in "-_" else "_" for c in intent_key)
    return f"{EXTRACTED_PATTERN_PREFIX}{safe}"[:120]


def _synthesize_pattern(
    pattern_id: str,
    intent_key: str,
    items: list[dict[str, Any]],
) -> ExtractedPatternCandidate:
    """Stub heuristic. A real LLM step would read `items[].snapshot.card`
    and generate a polished `abstract` + `trigger_dsl`. For Phase 6 v0
    we leave that to the reviewer (they edit on the detail page before
    approving)."""
    sample_card_ids = [str(it.get("card_id")) for it in items[:5] if it.get("card_id")]
    abstract = (
        f"AI 抽取候选：意图 {intent_key} 在最近窗口里 reviewer 标记了 {len(items)} 张 "
        f"golden 卡。请补全 trigger DSL + card_skeleton 后通过。"
    )
    return ExtractedPatternCandidate(
        pattern_id=pattern_id,
        intent_key=intent_key,
        cluster_size=len(items),
        sample_card_ids=sample_card_ids,
        abstract=abstract,
    )


async def _upsert_candidate(
    conn: AsyncConnection[DictRow],
    candidate: ExtractedPatternCandidate,
    items: list[dict[str, Any]],
) -> None:
    """Insert (or refresh) the candidate pattern as status=pending_review.
    The trigger / card_skeleton are intentionally empty so the reviewer
    edits them before approving."""
    sample_baskets = [it.get("basket") for it in items if isinstance(it.get("basket"), str)]
    primary_basket = sample_baskets[0] if sample_baskets else None
    async with conn.cursor() as cur:
        await cur.execute(
            """
            INSERT INTO pai_card_patterns
              (id, category, abstract, signals_required, trigger_dsl, intent,
               card_skeleton, specializations, surprise_init, practical_init,
               tier, status, source)
            VALUES (%s, 'ai_extracted', %s,
                    '[]'::jsonb, '[]'::jsonb, %s,
                    '{}'::jsonb, '[]'::jsonb, 'm', 'm',
                    'warmup', 'pending_review', 'ai_extracted')
            ON CONFLICT (id) DO UPDATE SET
              abstract = EXCLUDED.abstract,
              updated_at = NOW()
            """,
            (
                candidate.pattern_id,
                candidate.abstract,
                candidate.intent_key,
            ),
        )
    logger.info(
        "pattern_extractor: candidate=%s intent=%s cluster_size=%d basket=%s",
        candidate.pattern_id,
        candidate.intent_key,
        candidate.cluster_size,
        primary_basket,
    )
