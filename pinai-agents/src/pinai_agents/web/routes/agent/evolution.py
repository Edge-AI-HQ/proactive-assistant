"""/api/agent/evolution/* — full evolution-run lifecycle.

Dream / evolve agents call create() at the start of a run, complete()
or fail() at the end. List / get are read for diagnostics (the
frontend dreaming panel reads via /api/dreaming/runs which uses the
same Repository — both surfaces stay consistent).
"""

from __future__ import annotations

from dataclasses import asdict
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, status

from ...auth.deps import AgentRun, current_agent_run, get_pool
from ...db.repositories.evolution import EvolutionRepository, EvolutionRunRow
from ...db.rls import user_scoped_tx

router = APIRouter(prefix="/api/agent/evolution", tags=["agent-evolution"])


def _to_dict(row: EvolutionRunRow) -> dict[str, Any]:
    d = asdict(row)
    for k in ("window_start", "window_end", "started_at", "completed_at"):
        v = d.get(k)
        if v is not None and hasattr(v, "isoformat"):
            d[k] = v.isoformat()
    return d


@router.post("/create")
async def create_evolution(
    body: dict,
    run: AgentRun = Depends(current_agent_run),
    pool=Depends(get_pool),
):
    trigger_kind = body.get("triggerKind") or body.get("trigger_kind")
    if not isinstance(trigger_kind, str) or not trigger_kind:
        raise HTTPException(status_code=400, detail="triggerKind required")
    window_start = body.get("windowStart") or body.get("window_start")
    window_end = body.get("windowEnd") or body.get("window_end")
    async with user_scoped_tx(pool, run.user_id) as conn:
        repo = EvolutionRepository(run.user_id, conn)
        row = await repo.create(
            trigger_kind=trigger_kind,
            context_summary=body.get("contextSummary") or body.get("context_summary"),
            window_start=_parse_dt(window_start),
            window_end=_parse_dt(window_end),
            prompt_excerpt=body.get("promptExcerpt") or body.get("prompt_excerpt"),
            run_id=run.run_id,  # bind agent run id so we can join later
        )
    return _to_dict(row)


@router.get("/list")
async def list_evolutions(
    run: AgentRun = Depends(current_agent_run),
    pool=Depends(get_pool),
    trigger_kind: str | None = Query(None, alias="triggerKind"),
    status_filter: str | None = Query(None, alias="status"),
    since: datetime | None = Query(None),
    limit: int = Query(50, ge=1, le=200),
):
    async with user_scoped_tx(pool, run.user_id) as conn:
        repo = EvolutionRepository(run.user_id, conn)
        rows = await repo.list(
            trigger_kind=trigger_kind,
            status=status_filter,
            since=since,
            limit=limit,
        )
    return {"items": [_to_dict(r) for r in rows]}


@router.get("/{evol_id}")
async def get_evolution(
    evol_id: str,
    run: AgentRun = Depends(current_agent_run),
    pool=Depends(get_pool),
):
    async with user_scoped_tx(pool, run.user_id) as conn:
        repo = EvolutionRepository(run.user_id, conn)
        row = await repo.get(evol_id)
    if row is None:
        raise HTTPException(status_code=404, detail="evolution not found")
    return _to_dict(row)


@router.post("/{evol_id}/complete", status_code=status.HTTP_204_NO_CONTENT)
async def complete_evolution(
    evol_id: str,
    body: dict,
    run: AgentRun = Depends(current_agent_run),
    pool=Depends(get_pool),
):
    async with user_scoped_tx(pool, run.user_id) as conn:
        repo = EvolutionRepository(run.user_id, conn)
        ok = await repo.complete(
            evol_id,
            llm_tokens=body.get("llmTokens") or body.get("llm_tokens"),
            duration_ms=body.get("durationMs") or body.get("duration_ms"),
            details=body.get("details"),
        )
    if not ok:
        raise HTTPException(
            status_code=404,
            detail="evolution not running or not found",
        )
    return None


@router.post("/{evol_id}/fail", status_code=status.HTTP_204_NO_CONTENT)
async def fail_evolution(
    evol_id: str,
    body: dict,
    run: AgentRun = Depends(current_agent_run),
    pool=Depends(get_pool),
):
    err = body.get("errorMessage") or body.get("error_message")
    if not isinstance(err, str) or not err:
        raise HTTPException(status_code=400, detail="errorMessage required")
    async with user_scoped_tx(pool, run.user_id) as conn:
        repo = EvolutionRepository(run.user_id, conn)
        ok = await repo.fail(evol_id, error_message=err)
    if not ok:
        raise HTTPException(
            status_code=404,
            detail="evolution not running or not found",
        )
    return None


def _parse_dt(v: Any) -> datetime | None:
    """ISO string or already-typed datetime → datetime. None on miss."""
    if v is None or v == "":
        return None
    if isinstance(v, datetime):
        return v
    if isinstance(v, str):
        try:
            return datetime.fromisoformat(v.replace("Z", "+00:00"))
        except ValueError:
            return None
    return None
