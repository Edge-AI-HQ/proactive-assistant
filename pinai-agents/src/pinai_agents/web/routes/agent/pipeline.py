"""/api/agent/pipeline/* — generator-run lifecycle.

Schema: pai_pipeline_runs (one row per generator invocation). The
generator agent in the chat process opens a row at start, marks it
'completed' / 'failed' at end, and persists the produced cards under
final_cards JSONB so /api/cards can surface them across runs.

Direct SQL (no Repository): the table's other readers
(routes/ui/runs_and_cards.py, routes/agent/cards.py) also use raw
SQL. A Repository would be over-engineering for these three writes.
"""

from __future__ import annotations

import json
import uuid
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status

from ...auth.deps import AgentRun, current_agent_run, get_pool
from ...db.rls import user_scoped_tx

router = APIRouter(prefix="/api/agent/pipeline", tags=["agent-pipeline"])


def _row_to_dict(row: dict[str, Any]) -> dict[str, Any]:
    out = dict(row)
    for k in ("started_at", "completed_at", "updated_at"):
        v = out.get(k)
        if isinstance(v, datetime):
            out[k] = v.isoformat()
    return out


@router.post("/create")
async def create_run(
    body: dict,
    agent_run: AgentRun = Depends(current_agent_run),
    pool=Depends(get_pool),
):
    """Open a pai_pipeline_runs row in 'running'. The agent run id from
    the JWT (agent_run.run_id) is the row's natural id — same value lets
    /complete close it without bookkeeping a separate db id."""
    rid = body.get("runId") or body.get("run_id") or agent_run.run_id
    pid = body.get("id") or f"pl_{uuid.uuid4().hex[:16]}"
    trigger = body.get("trigger")
    async with user_scoped_tx(pool, agent_run.user_id) as conn:
        cur = await conn.execute(
            """
            INSERT INTO pai_pipeline_runs
              (user_id, id, run_id, status, trigger,
               subagent_run_id, subagent_session_key)
            VALUES (%s, %s, %s, 'running', %s, %s, %s)
            RETURNING *
            """,
            (
                agent_run.user_id,
                pid,
                rid,
                trigger,
                body.get("subagentRunId") or body.get("subagent_run_id"),
                body.get("subagentSessionKey") or body.get("subagent_session_key"),
            ),
        )
        row = await cur.fetchone()
    if row is None:
        raise HTTPException(status_code=500, detail="pipeline insert returned no row")
    return _row_to_dict(row)


@router.post("/{pipeline_id}/complete")
async def complete_run(
    pipeline_id: str,
    body: dict,
    agent_run: AgentRun = Depends(current_agent_run),
    pool=Depends(get_pool),
):
    """Close a running row with cards / iterations / iterations count."""
    final_cards = body.get("finalCards") or body.get("final_cards")
    iterations = body.get("iterations")
    total_iterations = body.get("totalIterations") or body.get("total_iterations")
    async with user_scoped_tx(pool, agent_run.user_id) as conn:
        cur = await conn.execute(
            """
            UPDATE pai_pipeline_runs
            SET status = 'completed', completed_at = NOW(), updated_at = NOW(),
                final_cards = COALESCE(%s::jsonb, final_cards),
                iterations = COALESCE(%s::jsonb, iterations),
                total_iterations = COALESCE(%s, total_iterations)
            WHERE user_id = %s AND id = %s AND status = 'running'
            RETURNING *
            """,
            (
                json.dumps(final_cards) if final_cards is not None else None,
                json.dumps(iterations) if iterations is not None else None,
                total_iterations,
                agent_run.user_id,
                pipeline_id,
            ),
        )
        row = await cur.fetchone()
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="pipeline not running or not found",
        )
    return _row_to_dict(row)


@router.post("/{pipeline_id}/fail")
async def fail_run(
    pipeline_id: str,
    body: dict,
    agent_run: AgentRun = Depends(current_agent_run),
    pool=Depends(get_pool),
):
    err = body.get("error")
    if not isinstance(err, str) or not err:
        raise HTTPException(status_code=400, detail="error required")
    async with user_scoped_tx(pool, agent_run.user_id) as conn:
        cur = await conn.execute(
            """
            UPDATE pai_pipeline_runs
            SET status = 'failed', completed_at = NOW(), updated_at = NOW(),
                error = %s
            WHERE user_id = %s AND id = %s AND status = 'running'
            RETURNING *
            """,
            (err, agent_run.user_id, pipeline_id),
        )
        row = await cur.fetchone()
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="pipeline not running or not found",
        )
    return _row_to_dict(row)
