"""/api/agent-runs/* — frontend agent-run dashboard surface.

`useActiveAgentRuns` (frontend hook) polls /active to drive the global
status pill + refresh-safe per-task indicators. Same `pai_scheduled_tasks`
+ `pai_scheduled_task_runs` join as /api/tasks, but filtered to the
"agent" subset (kinds the user actually started or that produce
user-visible artifacts) and projected with FE-friendly camelCase keys.

Distinct from /api/tasks (which is the legacy data-connector debug page
shape) so we can evolve the agent-run UI without breaking that.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends

from ...auth.deps import User, current_user, get_pool
from ...db.rls import user_scoped_tx

router = APIRouter(prefix="/api/agent-runs", tags=["agent-runs"])


# Kinds we surface to the FE indicator. `connector.sync` is intentionally
# omitted — it runs on a recurring schedule every ~15min and would
# clutter the indicator with non-user-initiated activity. The user only
# needs to see things they kicked off (or that follow-up automatically:
# init→evolve, dream, generator, crystallize).
_AGENT_KINDS = (
    "auto.dreaming",
    "connector.init",
    "connector.evolve",
    "crystallize",
    "generator.manual",
    "generator.auto",
    "generator.chat",
    "generator.scheduled",
    "user.prompt",
)


def _project_status(task_status: str, run_status: str | None) -> str:
    """Same mapping as routes/ui/tasks._project_status. Duplicated for
    now to avoid coupling the two endpoints; if a third caller needs it
    we'll lift it into a shared helper.
    """
    if run_status == "running":
        return "running"
    if task_status == "archived":
        return "succeeded" if run_status == "success" else "failed"
    if task_status == "paused":
        return "cancelled"
    return "queued"


def _row_to_run(r: dict[str, Any]) -> dict[str, Any]:
    """FE shape (camelCase): {id, kind, status, startedAt, ...}."""
    status = _project_status(r["task_status"], r.get("run_status"))
    progress = r.get("progress") or {}
    completed_at = r["updated_at"] if r["task_status"] == "archived" else None
    return {
        "id": r["id"],
        "kind": r["kind"],
        "status": status,
        "trigger": (r.get("payload") or {}).get("trigger"),
        "startedAt": _iso(r.get("last_run_at")),
        "completedAt": _iso(completed_at),
        "createdAt": _iso(r.get("created_at")),
        "updatedAt": _iso(r.get("updated_at")),
        "attempts": int(r.get("attempts") or 0),
        "maxAttempts": int(r.get("max_attempts") or 3),
        "lastError": r.get("last_error") or r.get("run_error"),
        "progress": progress,
        "payload": r.get("payload") or {},
    }


def _iso(v: Any) -> str | None:
    if v is None:
        return None
    if isinstance(v, datetime):
        return v.isoformat()
    return str(v)


# Shared SELECT — only the WHERE clause differs between /active and /{id}.
_BASE_SELECT = """
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
      AND st.kind = ANY(%s)
"""

_ACTIVE_FILTER = """
      -- "Active" sources of truth, OR'd together:
      --   1. once-task with st.status='active' → queued, never claimed.
      --      Recurring schedules also sit in status='active' between
      --      fires, but `next_run_at` may be hours away — those are NOT
      --      in flight. The trigger_kind gate keeps us honest.
      --   2. run.status='running' → claimed, agent currently working.
      --      For recurring schedules this is the only signal that
      --      surfaces them (st.status stays 'active' across all fires).
      --   3. recently completed one-shot tasks (within 30s) → for the
      --      brief success/failure flash before the pill disappears.
      --      Recurring schedule rows can also be archived by settings
      --      updates, which is not an agent run completion.
      AND (
        (st.status = 'active' AND st.trigger_kind = 'once')
        OR run.status = 'running'
        OR (
          st.status = 'archived'
          AND st.trigger_kind = 'once'
          AND st.updated_at >= NOW() - INTERVAL '30 seconds'
        )
      )
    ORDER BY st.updated_at DESC
    LIMIT 50
"""


@router.get("/active")
async def list_active_agent_runs(
    user: User = Depends(current_user),
    pool=Depends(get_pool),
):
    """Current user's in-flight + just-finished agent runs.

    "Just-finished" = archived within the last 30s — gives the FE
    indicator a window to flash success/failure before clearing. Beyond
    that it's history (use a separate endpoint when we need it).
    """
    async with user_scoped_tx(pool, user.id) as conn:
        cur = await conn.execute(
            _BASE_SELECT + _ACTIVE_FILTER,
            (user.id, list(_AGENT_KINDS)),
        )
        rows = await cur.fetchall()
    runs = [_row_to_run(r) for r in rows]
    return {"ok": True, "runs": runs, "asOf": datetime.utcnow().isoformat() + "Z"}


@router.get("/{run_id}")
async def get_agent_run(
    run_id: str,
    user: User = Depends(current_user),
    pool=Depends(get_pool),
):
    """Single run detail — same projection. Returns 404 if not the
    user's run or not one of the agent kinds.
    """
    async with user_scoped_tx(pool, user.id) as conn:
        cur = await conn.execute(
            _BASE_SELECT + " AND st.id = %s LIMIT 1",
            (user.id, list(_AGENT_KINDS), run_id),
        )
        row = await cur.fetchone()
    if row is None:
        from fastapi import HTTPException  # noqa: PLC0415

        raise HTTPException(status_code=404, detail="agent run not found")
    return {"ok": True, "run": _row_to_run(row)}
