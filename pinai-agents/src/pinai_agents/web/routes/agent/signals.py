"""/api/agent/signals/* — agent personal signal queries."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Query, status

from ...auth.deps import AgentRun, current_agent_run, get_pool
from ...db.repositories.personal_signals import (
    IngestSignalInput,
    PersonalSignalsRepository,
)
from ...db.rls import user_scoped_tx

router = APIRouter(prefix="/api/agent/signals", tags=["agent-signals"])


@router.get("/recent")
async def list_signals(
    run: AgentRun = Depends(current_agent_run),
    pool=Depends(get_pool),
    status_filter: str = Query("open", alias="status",
                               pattern="^(open|consumed|archived|all)$"),
    kind: str | None = Query(None),
    hours: int | None = Query(None, ge=1, le=24 * 14),
    min_salience: float | None = Query(None, ge=0, le=1, alias="minSalience"),
    limit: int = Query(30, ge=1, le=200),
):
    actual_status = None if status_filter == "all" else status_filter
    since = None
    if hours is not None:
        from datetime import UTC, timedelta
        since = datetime.now(UTC) - timedelta(hours=hours)
    async with user_scoped_tx(pool, run.user_id) as conn:
        repo = PersonalSignalsRepository(run.user_id, conn)
        rows, _total = await repo.list_recent(
            status=actual_status, kind=kind,
            min_salience=min_salience, since=since, limit=limit,
        )
    return {"items": [{
        "id": r.id, "kind": r.kind, "title": r.title, "summary": r.summary,
        "salience": r.salience, "occurredAt": r.occurred_at.isoformat(),
        "status": r.status, "subject": r.subject,
    } for r in rows]}


@router.get("/get/{signal_id}")
async def get_signal(
    signal_id: str,
    run: AgentRun = Depends(current_agent_run),
    pool=Depends(get_pool),
):
    """Full payload for one signal — drill-down from `/recent` summary.
    404 if the id doesn't belong to the caller (RLS already blocks
    cross-user reads, this just turns an empty result into the right code)."""
    async with user_scoped_tx(pool, run.user_id) as conn:
        repo = PersonalSignalsRepository(run.user_id, conn)
        row = await repo.get_one(signal_id)
    if row is None:
        raise HTTPException(status_code=404, detail="signal not found")
    return {
        "id": row.id, "kind": row.kind, "title": row.title,
        "summary": row.summary, "payload": row.payload,
        "salience": row.salience, "confidence": row.confidence,
        "occurredAt": row.occurred_at.isoformat(),
        "status": row.status, "subject": row.subject,
        "source": row.source, "deviceId": row.device_id,
        "consumedByRunId": row.consumed_by_run_id,
    }


@router.post("/consume", status_code=status.HTTP_204_NO_CONTENT)
async def consume_signal(
    body: dict,
    run: AgentRun = Depends(current_agent_run),
    pool=Depends(get_pool),
):
    sig_id = body.get("id")
    if not sig_id:
        return None
    target_run = body.get("runId") or run.run_id
    async with user_scoped_tx(pool, run.user_id) as conn:
        repo = PersonalSignalsRepository(run.user_id, conn)
        await repo.mark_consumed(sig_id, target_run)
    return None


@router.post("/ingest")
async def ingest_signal(
    body: dict,
    run: AgentRun = Depends(current_agent_run),
    pool=Depends(get_pool),
):
    sig_id = body.get("id") or f"sig_{uuid.uuid4().hex[:16]}"
    # `occurred_at` is NOT NULL on the table. Agents (especially LLM-driven
    # evolve) routinely omit the field when the underlying event has no
    # natural timestamp; default to "now" so the insert succeeds. Callers
    # that *do* know the event time (gmail messageTimestamp, gcal start)
    # still pass it through unchanged.
    occurred = body.get("occurredAt")
    if isinstance(occurred, str):
        occurred_at = datetime.fromisoformat(occurred.replace("Z", "+00:00"))
    elif isinstance(occurred, datetime):
        occurred_at = occurred
    else:
        occurred_at = datetime.now(UTC)
    async with user_scoped_tx(pool, run.user_id) as conn:
        repo = PersonalSignalsRepository(run.user_id, conn)
        row = await repo.ingest_one(IngestSignalInput(
            id=sig_id, kind=body["kind"], title=body["title"],
            summary=body.get("summary", ""),
            occurred_at=occurred_at,
            payload=body.get("payload") or {},
            salience=float(body.get("salience", 0)),
            confidence=float(body.get("confidence", 0)),
            dedupe_key=body.get("dedupeKey"),
            source=body.get("source", "agent"),
            subject=body.get("subject"),
        ))
    return {"id": row.id, "status": row.status}
