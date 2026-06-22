"""/api/agent/cards/recent — flat card list across recent runs.

Mirrors /api/cards (UI surface); same SQL, swapped to current_agent_run.
The card body lives in pai_pipeline_runs.final_cards JSONB; we extract
into a flat list and return.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Query
from pinai_db.rls import user_scoped_tx

from ...platform.auth.deps import AgentRun, current_agent_run, get_pool

router = APIRouter(prefix="/api/agent/cards", tags=["agent-cards"])


@router.get("/recent")
async def recent_cards(
    run: AgentRun = Depends(current_agent_run),
    pool=Depends(get_pool),
    limit: int = Query(50, ge=1, le=500),
):
    async with user_scoped_tx(pool, run.user_id) as conn:
        cur = await conn.execute(
            """
            SELECT id, run_id, started_at, final_cards
            FROM pai_pipeline_runs
            WHERE user_id = %s AND status = 'completed' AND final_cards IS NOT NULL
            ORDER BY started_at DESC LIMIT %s
            """,
            (run.user_id, limit),
        )
        rows = await cur.fetchall()
    cards: list[dict[str, Any]] = []
    for r in rows:
        for c in r.get("final_cards") or []:
            if not isinstance(c, dict):
                continue
            c.setdefault("runId", r["run_id"])
            c.setdefault(
                "runStartedAt",
                r["started_at"].isoformat() if r["started_at"] else None,
            )
            cards.append(c)
            if len(cards) >= limit:
                break
        if len(cards) >= limit:
            break
    return {"items": cards}
