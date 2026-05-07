"""/api/tasks/* — read-only task list / detail for frontend Data Connections UI.

Backed by `pai_scheduled_tasks` (consolidated queue, migration 031). The
frontend `useInitTask` hook expects a shape inherited from the legacy
`pai_background_tasks` row — id / type / status / payload / progress /
attempts / max_attempts / last_error_message / started_at / completed_at.
We project from the new schema:

  pai_scheduled_tasks.kind                 → type
  pai_scheduled_tasks.id                   → id
  status synthesis (see _project_status)   → status
  pai_scheduled_tasks.payload / progress   → payload / progress
  attempts / max_attempts / last_error     → ditto
  last_run_at / updated_at                 → started_at / completed_at

Status synthesis rules (the table itself uses active/paused/archived,
runs use running/success/failed):

  most-recent run = running                                 → "running"
  task = archived, most-recent run = success                → "succeeded"
  task = archived, anything else                            → "failed"
  task = paused                                             → "cancelled"
  attempts > 0 and most-recent run = failed (mid-retry)     → "queued" (will retry)
  otherwise                                                 → "queued"
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query

from ...auth.deps import User, current_user, get_pool
from ...db.rls import user_scoped_tx

router = APIRouter(prefix="/api/tasks", tags=["tasks"])


# Public (frontend-facing) status enum, kept stable as `pai_background_tasks`
# legacy. Internally the new schema uses different state machines for
# pai_scheduled_tasks (active/paused/archived) + pai_scheduled_task_runs
# (running/success/failed) — _project_status fuses them.
_PUBLIC_STATUS = {
    "queued", "running", "succeeded", "failed", "skipped", "cancelled",
}


def _project_status(task_status: str, run_status: str | None) -> str:
    if run_status == "running":
        return "running"
    if task_status == "archived":
        return "succeeded" if run_status == "success" else "failed"
    if task_status == "paused":
        return "cancelled"
    return "queued"


# Project the joined row to the legacy `InitTaskRow` shape so the
# frontend's `useInitTask` hook keeps working untouched.
_LIST_SQL = """
    SELECT
      st.id,
      st.kind,
      st.status            AS task_status,
      st.payload,
      st.progress,
      st.attempts,
      st.max_attempts,
      st.last_error,
      st.last_run_at,
      st.created_at,
      st.updated_at,
      run.status           AS run_status,
      run.error            AS run_error
    FROM pai_scheduled_tasks st
    LEFT JOIN LATERAL (
      SELECT status, error
      FROM pai_scheduled_task_runs
      WHERE user_id = st.user_id AND task_id = st.id
      ORDER BY fired_at DESC
      LIMIT 1
    ) run ON TRUE
    WHERE st.user_id = %s
      AND (%s::text IS NULL OR st.kind = %s)
      AND (%s::timestamptz IS NULL OR st.created_at >= %s)
    ORDER BY st.created_at DESC
    LIMIT %s
"""

_DETAIL_SQL = """
    SELECT
      st.id,
      st.kind,
      st.status            AS task_status,
      st.payload,
      st.progress,
      st.attempts,
      st.max_attempts,
      st.last_error,
      st.last_run_at,
      st.created_at,
      st.updated_at,
      run.status           AS run_status,
      run.error            AS run_error
    FROM pai_scheduled_tasks st
    LEFT JOIN LATERAL (
      SELECT status, error
      FROM pai_scheduled_task_runs
      WHERE user_id = st.user_id AND task_id = st.id
      ORDER BY fired_at DESC
      LIMIT 1
    ) run ON TRUE
    WHERE st.user_id = %s AND st.id = %s
"""


@router.get("")
async def list_tasks(
    user: User = Depends(current_user),
    pool=Depends(get_pool),
    type_filter: str | None = Query(None, alias="type"),
    status_filter: str | None = Query(None, alias="status"),
    since: datetime | None = Query(None),
    limit: int = Query(50, ge=1, le=200),
):
    if status_filter and status_filter not in _PUBLIC_STATUS:
        raise HTTPException(status_code=400, detail=f"unknown status: {status_filter}")
    async with user_scoped_tx(pool, user.id) as conn:
        cur = await conn.execute(
            _LIST_SQL,
            (user.id, type_filter, type_filter, since, since, limit),
        )
        rows = await cur.fetchall()
    projected = [_project_row(r) for r in rows]
    if status_filter:
        projected = [t for t in projected if t["status"] == status_filter]
    return {"count": len(projected), "tasks": projected}


@router.get("/{task_id}")
async def get_task(
    task_id: str,
    user: User = Depends(current_user),
    pool=Depends(get_pool),
):
    async with user_scoped_tx(pool, user.id) as conn:
        cur = await conn.execute(_DETAIL_SQL, (user.id, task_id))
        row = await cur.fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="task not found")
    return {"task": _project_row(row)}


def _project_row(r: dict[str, Any]) -> dict[str, Any]:
    status = _project_status(r["task_status"], r.get("run_status"))
    last_error = r.get("last_error") or r.get("run_error")
    completed_at = (
        r["updated_at"] if r["task_status"] == "archived" else None
    )
    progress = r.get("progress") or {}
    return {
        "id": r["id"],
        "type": r["kind"],
        "status": status,
        "payload": r.get("payload") or {},
        "progress": progress,
        # Legacy `result` shape the DebugPanel chip reads from. The new
        # pipeline writes everything to `progress` instead, so on success
        # we hoist the headline counts up so the chip can render
        # "Done · X raw, Y mem, Z skill" without each caller having to
        # know the new key path. Returns None for non-terminal tasks.
        "result": _result_from_progress(status, progress),
        "attempts": int(r.get("attempts") or 0),
        "max_attempts": int(r.get("max_attempts") or 3),
        # Frontend reads last_error_message AND last_error_code; we only
        # carry one error string, so map both to it (caller already
        # falls back gracefully when one is null).
        "last_error_code": None,
        "last_error_message": last_error,
        "started_at": _iso(r.get("last_run_at")),
        "completed_at": _iso(completed_at),
        "created_at": _iso(r.get("created_at")),
        "updated_at": _iso(r.get("updated_at")),
    }


def _result_from_progress(
    status: str, progress: dict[str, Any],
) -> dict[str, Any] | None:
    """Promote known counts out of `progress` into the legacy `result`
    shape so the DebugPanel chip can render meaningful numbers.

    connector.init writes camelCase `rawInserted`, dream/evolve agents
    have no progress writes today (their counts only exist in the run
    summary). Keep keys lowercase for forward compat — frontend reads
    `rawInserted`, `memoriesWritten`, `skillsAdded`.
    """
    if status != "succeeded":
        return None
    return {
        "rawInserted": int(progress.get("rawInserted") or progress.get("inserted") or 0),
        "memoriesWritten": int(progress.get("memoriesWritten") or 0),
        "skillsAdded": int(progress.get("skillsAdded") or 0),
    }


def _iso(v: Any) -> str | None:
    if v is None:
        return None
    if isinstance(v, datetime):
        return v.isoformat()
    return str(v)
