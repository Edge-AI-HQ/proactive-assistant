"""/api/agent/world/* — agent-facing world signal queries.

The shared world signals table is global; per-user salience / status
lives in pai_world_signal_user_view. Reads JOIN both. Writes target the
view (score/consume/reference) — all user-scoped via RLS.

Ingest of new world rows belongs in the scheduled-task / connector
layer, not on the agent surface, so /ingest is intentionally absent
here. If a need arises, add a service-role guarded route.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, Query, status
from pinai_db.rls import user_scoped_tx

from ....platform.auth.deps import AgentRun, current_agent_run, get_pool
from ....platform.auth.user_service import load_user_by_id
from ....platform.embeddings import EmbeddingError, embed_batch
from .world_signals import WorldSignalsRepository

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/agent/world", tags=["agent-world"])


@router.get("/recent")
async def list_world_signals(
    run: AgentRun = Depends(current_agent_run),
    pool=Depends(get_pool),
    status_filter: str = Query(
        "open",
        alias="status",
        pattern="^(open|consumed|archived|all|new)$",
    ),
    provider: str | None = Query(None),
    hours: int | None = Query(None, ge=1, le=24 * 14),
    since: datetime | None = Query(None),
    until: datetime | None = Query(None),
    min_salience: float | None = Query(None, ge=0, le=1, alias="minSalience"),
    limit: int = Query(30, ge=1, le=200),
):
    actual_status = None if status_filter == "all" else status_filter
    lower_bound = since
    before = until
    if hours is not None:
        now = datetime.now(UTC)
        lower_bound = now - timedelta(hours=hours)
        before = now
    async with user_scoped_tx(pool, run.user_id) as conn:
        repo = WorldSignalsRepository(run.user_id, conn)
        rows = await repo.list_for_user(
            status=actual_status,
            provider=provider,
            min_salience=min_salience,
            since=lower_bound,
            before=before,
            limit=limit,
        )
    return {
        "items": [
            {
                "id": r.id,
                "provider": r.provider,
                "title": r.title,
                "url": r.url,
                "summary": r.summary,
                "publishedAt": r.published_at.isoformat() if r.published_at else None,
                "topics": r.topics,
                "importance": r.importance,
                "salience": r.salience,
                "status": r.status,
                "scoredAt": r.scored_at.isoformat() if r.scored_at else None,
                "referenceCount": r.reference_count,
            }
            for r in rows
        ]
    }


@router.post("/score", status_code=status.HTTP_204_NO_CONTENT)
async def score_world_signal(
    body: dict,
    run: AgentRun = Depends(current_agent_run),
    pool=Depends(get_pool),
):
    """Upsert per-user salience for a world signal."""
    sig_id = body.get("id") or body.get("worldSignalId")
    if not sig_id:
        return None
    salience = float(body.get("salience", 0))
    reason = body.get("scoredReason")
    next_status = body.get("status", "open")
    async with user_scoped_tx(pool, run.user_id) as conn:
        repo = WorldSignalsRepository(run.user_id, conn)
        await repo.score(
            world_signal_id=sig_id,
            salience=salience,
            scored_reason=reason,
            status=next_status,
        )
    return None


@router.post("/consume", status_code=status.HTTP_204_NO_CONTENT)
async def consume_world_signal(
    body: dict,
    run: AgentRun = Depends(current_agent_run),
    pool=Depends(get_pool),
):
    sig_id = body.get("id") or body.get("worldSignalId")
    if not sig_id:
        return None
    target_run = body.get("runId") or run.run_id
    async with user_scoped_tx(pool, run.user_id) as conn:
        repo = WorldSignalsRepository(run.user_id, conn)
        await repo.mark_consumed(world_signal_id=sig_id, run_id=target_run)
    return None


@router.get("/search")
async def search_world_signals(
    run: AgentRun = Depends(current_agent_run),
    pool=Depends(get_pool),
    q: str = Query(..., min_length=1, max_length=500),
    limit: int = Query(10, ge=1, le=50),
    status_filter: str = Query(
        "open",
        alias="status",
        pattern="^(open|consumed|archived|all|new)$",
    ),
):
    """Hybrid keyword + semantic search over world signals.

    Strategy: fetch top-K candidates from each side independently, then
    fuse by Reciprocal Rank Fusion (RRF, k=60 — Cormack et al. 2009 default).
    Both sides JOIN pai_world_signal_user_view so per-user `status` and
    salience travel with the result. Items missing a user_view row (never
    scored for this user) are scored 0 by the LEFT JOIN and still surface;
    the caller can decide what to do with them.

    Why RRF instead of weighted sum:
      * Robust to score-scale differences (cosine ~0-1 vs ts_rank
        unbounded). Rank-based is what the old plugin used.
      * Single tunable (k); no per-domain weight calibration.
    """
    # 1. Embed the query via LiteLLM (single text → 1536d vector).
    #    Bill the query embedding to the searching user's virtual key.
    searcher = await load_user_by_id(pool, run.user_id)
    try:
        vectors = await embed_batch(
            [q],
            virtual_key=searcher.litellm_virtual_key if searcher else None,
        )
    except EmbeddingError as e:
        logger.warning("world.search embedding failed: %s", e)
        # Fall through to keyword-only — partial result better than 500.
        vectors = []
    query_vec_lit: str | None = None
    if vectors:
        query_vec_lit = "[" + ",".join(f"{x:.6f}" for x in vectors[0]) + "]"

    actual_status = None if status_filter == "all" else status_filter

    # 2. Run both lookups under user-scoped tx so RLS limits user_view
    #    rows to this user. The shared pai_world_signals is publicly
    #    readable, so the JOINs work fine.
    fetch_n = limit * 5  # over-fetch each side so RRF has room to combine
    async with user_scoped_tx(pool, run.user_id) as conn:
        # ── keyword side: tsvector @@ plainto_tsquery, ranked by ts_rank
        cur = await conn.execute(
            """
            SELECT ws.id,
                   ws.title, ws.summary, ws.url, ws.provider, ws.topics,
                   ws.importance, ws.published_at,
                   v.salience, v.status, v.scored_at,
                   ts_rank_cd(ws.title_summary_tsv, plainto_tsquery('english', %s)) AS kw_score
            FROM pai_world_signals ws
            LEFT JOIN pai_world_signal_user_view v
              ON v.world_signal_id = ws.id AND v.user_id = %s
            WHERE ws.title_summary_tsv @@ plainto_tsquery('english', %s)
              AND (%s::text IS NULL OR v.status = %s)
            ORDER BY kw_score DESC, ws.published_at DESC NULLS LAST
            LIMIT %s
            """,
            (q, run.user_id, q, actual_status, actual_status, fetch_n),
        )
        kw_rows = await cur.fetchall()

        # ── semantic side: pgvector cosine. Skip if embedding failed
        #    or no rows have embeddings yet (cold start).
        sem_rows: list = []
        if query_vec_lit:
            cur = await conn.execute(
                """
                SELECT ws.id,
                       ws.title, ws.summary, ws.url, ws.provider, ws.topics,
                       ws.importance, ws.published_at,
                       v.salience, v.status, v.scored_at,
                       1 - (ws.embedding <=> %s::vector) AS sem_score
                FROM pai_world_signals ws
                LEFT JOIN pai_world_signal_user_view v
                  ON v.world_signal_id = ws.id AND v.user_id = %s
                WHERE ws.embedding IS NOT NULL
                  AND (%s::text IS NULL OR v.status = %s)
                ORDER BY ws.embedding <=> %s::vector
                LIMIT %s
                """,
                (query_vec_lit, run.user_id, actual_status, actual_status, query_vec_lit, fetch_n),
            )
            sem_rows = await cur.fetchall()

    # 3. RRF fusion. k=60 is the Cormack default — minor tuning here
    #    rarely beats it on heterogeneous score distributions.
    K = 60
    fused: dict[str, dict] = {}

    def _rrf_blend(rows: list, score_key: str) -> None:
        for rank, row in enumerate(rows):
            sig_id = row["id"]
            slot = fused.setdefault(
                sig_id, {"row": row, "rrf": 0.0, "kw_rank": None, "sem_rank": None}
            )
            slot["rrf"] += 1.0 / (K + rank + 1)
            slot[score_key + "_rank"] = rank + 1
            # Keep the richer row (one with score). Doesn't matter which —
            # both queries return the same columns; we only care about rank.

    _rrf_blend(kw_rows, "kw")
    _rrf_blend(sem_rows, "sem")

    fused_sorted = sorted(fused.values(), key=lambda s: s["rrf"], reverse=True)[:limit]

    return {
        "items": [
            {
                "id": s["row"]["id"],
                "provider": s["row"]["provider"],
                "title": s["row"]["title"],
                "url": s["row"]["url"],
                "summary": s["row"]["summary"],
                "topics": s["row"]["topics"],
                "importance": s["row"]["importance"],
                "publishedAt": s["row"]["published_at"].isoformat()
                if s["row"]["published_at"]
                else None,
                "salience": s["row"]["salience"],
                "status": s["row"]["status"],
                "rrfScore": s["rrf"],
                "kwRank": s["kw_rank"],
                "semRank": s["sem_rank"],
            }
            for s in fused_sorted
        ],
        "kwHits": len(kw_rows),
        "semHits": len(sem_rows),
    }


@router.post("/reference", status_code=status.HTTP_204_NO_CONTENT)
async def reference_world_signal(
    body: dict,
    run: AgentRun = Depends(current_agent_run),
    pool=Depends(get_pool),
):
    """Bump reference count when an evolution run uses the signal as
    input. Distinct from consume: a single signal can be referenced by
    many runs; consume is a one-shot lifecycle transition."""
    sig_id = body.get("id") or body.get("worldSignalId")
    if not sig_id:
        return None
    target_run = body.get("runId") or run.run_id
    async with user_scoped_tx(pool, run.user_id) as conn:
        repo = WorldSignalsRepository(run.user_id, conn)
        await repo.increment_reference(world_signal_id=sig_id, run_id=target_run)
    return None
