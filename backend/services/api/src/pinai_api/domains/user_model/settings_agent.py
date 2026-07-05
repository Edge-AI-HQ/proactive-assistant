"""/api/agent/settings/* — agent writes user settings.

The only agent-facing setting is `generation_language` (the chat agent's
set_generation_language tool, when the user says "use English from now
on"). Profile/goals agent endpoints (the retired pai_profile/pai_goals)
moved to memory_edit (USER/MEMORY/GOALS portrait slots) + event_append
(preferences) in the lifelong-memory sunset.
"""

from __future__ import annotations

from dataclasses import asdict

from fastapi import APIRouter, Depends
from pinai_contracts.api_models import GenerationLanguageSetRequest
from pinai_db.rls import user_scoped_tx

from ...platform.auth.deps import AgentRun, current_agent_run, get_pool
from .settings import SettingsRepository

router = APIRouter(prefix="/api/agent/settings", tags=["agent-settings"])


@router.post("/generation-language")
async def agent_set_generation_language(
    body: GenerationLanguageSetRequest,
    run: AgentRun = Depends(current_agent_run),
    pool=Depends(get_pool),
):
    """Flip the user's `generation_language` from chat (the user said
    "use English from now on"). Persisted to pai_user_settings so the next
    generate run reads it deterministically. Returns the updated settings row.
    """
    async with user_scoped_tx(pool, run.user_id) as conn:
        repo = SettingsRepository(run.user_id, conn)
        row = await repo.upsert_settings(
            generation_language=body.generation_language,
        )
    return asdict(row)
