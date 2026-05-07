"""/api/dreaming/* — frontend dreaming runs surface.

Dreaming runs live in pai_evolution_runs with trigger_kind='daily_dream'
(or 'manual' when user-triggered). Trigger goes through scheduler which
dispatches to chat worker /agent/run/dream.
"""

from __future__ import annotations

import uuid
from dataclasses import asdict
from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status

from ...auth.deps import User, current_user, get_pool
from ...db.repositories.evolution import EvolutionRepository, EvolutionRunRow
from ...db.repositories.scheduled_tasks import ScheduledTasksRepository
from ...db.rls import user_scoped_tx

router = APIRouter(prefix="/api/dreaming", tags=["dreaming"])


def _to_dict(row: EvolutionRunRow) -> dict[str, Any]:
    d = asdict(row)
    for k in ("window_start", "window_end", "started_at", "completed_at"):
        v = d.get(k)
        if v is not None and hasattr(v, "isoformat"):
            d[k] = v.isoformat()
    return d


@router.get("/runs")
async def list_dreaming_runs(
    user: User = Depends(current_user),
    pool=Depends(get_pool),
):
    """List dream/manual runs from pai_evolution_runs.

    Response shape: `{ok, runs}` where each run has the snake_case row
    fields the SPA's AutoDreamingSettings reads directly.
    """
    async with user_scoped_tx(pool, user.id) as conn:
        repo = EvolutionRepository(user.id, conn)
        # Daily dream + manual (user-triggered) runs.
        rows = await repo.list(limit=50)
    return {
        "ok": True,
        "runs": [_to_dict(r) for r in rows
                 if r.trigger_kind in ("daily_dream", "manual")],
    }


@router.get("/runs/{run_id}")
async def get_dream_run(
    run_id: str,
    user: User = Depends(current_user),
    pool=Depends(get_pool),
):
    """Single dream run detail.

    SPA's `DreamRunDetailResponse` expects `{ok, run, detail}`. The
    `detail` blob holds the rich tracing payload (rawInputs / dream
    markdown / source breakdown / log) that the EvolutionRunRow itself
    doesn't carry today — return an empty-shaped placeholder so the SPA
    doesn't blow up reading missing keys, and we can fill it in once
    the agent run pipeline persists tracing artifacts.
    """
    async with user_scoped_tx(pool, user.id) as conn:
        repo = EvolutionRepository(user.id, conn)
        row = await repo.get(run_id)
    if row is None:
        raise HTTPException(status_code=404, detail="dream run not found")
    return {
        "ok": True,
        "run": _to_dict(row),
        "detail": {
            "rawInputs": {},
            "normalizedInputs": {},
            "summary": {"kind": row.trigger_kind, "text": row.context_summary or ""},
            "dreamMarkdownPath": None,
            "dreamMarkdown": "",
            "profileDelta": {},
            "goalDelta": {"changes": []},
            "candidates": [],
            "sourceBreakdown": [],
            "logPath": None,
            "logText": "",
        },
    }


@router.post("/run", status_code=status.HTTP_202_ACCEPTED)
async def trigger_dream(
    user: User = Depends(current_user),
    pool=Depends(get_pool),
):
    """Manual trigger via scheduler. Inserts a 'once' task with
    next_run_at=NOW() so the next tick picks it up and dispatches to
    chat worker /agent/run/dream.
    """
    task_id = f"dream-manual-{uuid.uuid4().hex[:8]}"
    async with user_scoped_tx(pool, user.id) as conn:
        repo = ScheduledTasksRepository(user.id, conn)
        await repo.upsert(
            id=task_id, kind="auto.dreaming",
            trigger_kind="once",
            next_run_at=datetime.now(UTC) - timedelta(seconds=1),  # immediately due
            payload={"trigger": "manual"},
            name="Manual dream trigger",
        )
    # Frontend AutoDreamingSettings checks `data.ok` and uses `data.runId`
    # for the success notice. We don't materialize a run row until the
    # dispatcher claims this task, so reuse task_id as the runId proxy —
    # callers only use it for display, not for cross-table joins.
    return {
        "ok": True,
        "runId": task_id,
        "taskId": task_id,
        "status": "queued",
        "asOf": datetime.now(UTC).isoformat(),
    }
