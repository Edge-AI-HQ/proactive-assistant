"""/api/agent/profile/* — agent reads + writes user profile + goals.

PinCLI: pin profile get / set, pin goals upsert
"""

from __future__ import annotations

import uuid
from dataclasses import asdict

from fastapi import APIRouter, Depends, status

from ....shared.api_models import GoalUpsertRequest, ProfileUpsertRequest
from ...auth.deps import AgentRun, current_agent_run, get_pool
from ...db.repositories.profile import ProfileRepository
from ...db.rls import user_scoped_tx

router = APIRouter(prefix="/api/agent/profile", tags=["agent-profile"])


@router.get("/get")
async def agent_get_profile(
    run: AgentRun = Depends(current_agent_run),
    pool=Depends(get_pool),
):
    async with user_scoped_tx(pool, run.user_id) as conn:
        repo = ProfileRepository(run.user_id, conn)
        profile = await repo.get_profile()
        goals = await repo.list_goals(status="active")
    return {
        "profile": asdict(profile) if profile else None,
        "goals": [asdict(g) for g in goals],
    }


@router.post("/upsert")
async def agent_upsert_profile(
    body: ProfileUpsertRequest,
    run: AgentRun = Depends(current_agent_run),
    pool=Depends(get_pool),
):
    async with user_scoped_tx(pool, run.user_id) as conn:
        repo = ProfileRepository(run.user_id, conn)
        row = await repo.upsert_profile(
            display_name=body.display_name,
            locale=body.locale,
            timezone=body.timezone,
            summary=body.summary,
            facts=body.facts,
            preferences=body.preferences,
            constraints=body.constraints,
            metadata=body.metadata,
        )
    return asdict(row)


@router.post("/goals/upsert", status_code=status.HTTP_201_CREATED)
async def agent_upsert_goal(
    body: GoalUpsertRequest,
    run: AgentRun = Depends(current_agent_run),
    pool=Depends(get_pool),
):
    """Insert a new goal or update an existing one. Mirror of the UI
    /api/profile/goals route, scoped to agent JWT so chat / dream / evolve
    agents can persist user-stated goals from conversation."""
    goal_id = body.id or f"goal_{uuid.uuid4().hex[:12]}"
    async with user_scoped_tx(pool, run.user_id) as conn:
        repo = ProfileRepository(run.user_id, conn)
        row = await repo.upsert_goal(
            id=goal_id, key=body.key, title=body.title,
            priority=body.priority, status=body.status,
            summary=body.summary,
        )
    return asdict(row)
