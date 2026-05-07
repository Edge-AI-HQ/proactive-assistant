"""/api/agent/world/* — agent-facing world signal queries.

The shared world signals table is global; per-user salience / status
lives in pai_world_signal_user_view. Reads JOIN both. Writes target the
view (score/consume/reference) — all user-scoped via RLS.

Ingest of new world rows belongs in the scheduled-task / connector
layer, not on the agent surface, so /ingest is intentionally absent
here. If a need arises, add a service-role guarded route.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, Query, status

from ...auth.deps import AgentRun, current_agent_run, get_pool
from ...db.repositories.world_signals import WorldSignalsRepository
from ...db.rls import user_scoped_tx

router = APIRouter(prefix="/api/agent/world", tags=["agent-world"])


@router.get("/recent")
async def list_world_signals(
    run: AgentRun = Depends(current_agent_run),
    pool=Depends(get_pool),
    status_filter: str = Query(
        "open", alias="status",
        pattern="^(open|consumed|archived|all|new)$",
    ),
    provider: str | None = Query(None),
    hours: int | None = Query(None, ge=1, le=24 * 14),
    min_salience: float | None = Query(None, ge=0, le=1, alias="minSalience"),
    limit: int = Query(30, ge=1, le=200),
):
    actual_status = None if status_filter == "all" else status_filter
    since = None
    if hours is not None:
        since = datetime.now(UTC) - timedelta(hours=hours)
    async with user_scoped_tx(pool, run.user_id) as conn:
        repo = WorldSignalsRepository(run.user_id, conn)
        rows = await repo.list_for_user(
            status=actual_status, provider=provider,
            min_salience=min_salience, since=since, limit=limit,
        )
    return {"items": [{
        "id": r.id, "provider": r.provider, "title": r.title,
        "url": r.url, "summary": r.summary,
        "publishedAt": r.published_at.isoformat() if r.published_at else None,
        "topics": r.topics, "importance": r.importance,
        "salience": r.salience, "status": r.status,
        "scoredAt": r.scored_at.isoformat() if r.scored_at else None,
        "referenceCount": r.reference_count,
    } for r in rows]}


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
            world_signal_id=sig_id, salience=salience,
            scored_reason=reason, status=next_status,
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
