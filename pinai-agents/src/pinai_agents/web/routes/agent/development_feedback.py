"""/api/agent/development-feedback/* — agent-originated product suggestions."""

from __future__ import annotations

from dataclasses import asdict

from fastapi import APIRouter, Depends, status

from ....shared.api_models import (
    DevelopmentFeedbackItem,
    DevelopmentFeedbackLogRequest,
    DevelopmentFeedbackSource,
)
from ...auth.deps import AgentRun, current_agent_run, get_pool
from ...db.repositories.development_feedback import (
    AddDevelopmentFeedbackInput,
    DevelopmentFeedbackRepository,
)
from ...db.rls import user_scoped_tx

router = APIRouter(
    prefix="/api/agent/development-feedback",
    tags=["agent-development-feedback"],
)


def _resolve_source(run: AgentRun) -> DevelopmentFeedbackSource:
    if run.actor == "internal_operator":
        return "internal_operator"
    return "user"


@router.post("/log", status_code=status.HTTP_201_CREATED)
async def agent_log_development_feedback(
    body: DevelopmentFeedbackLogRequest,
    run: AgentRun = Depends(current_agent_run),
    pool=Depends(get_pool),
):
    metadata = dict(body.metadata)
    metadata["run_id"] = run.run_id
    if run.operator_id is not None:
        metadata["operator_id"] = run.operator_id
    source = _resolve_source(run)
    async with user_scoped_tx(pool, run.user_id) as conn:
        repo = DevelopmentFeedbackRepository(run.user_id, conn)
        row = await repo.add(
            AddDevelopmentFeedbackInput(
                text=body.text,
                summary=body.summary,
                category=body.category,
                surface=body.surface,
                source=source,
                conversation_id=body.conversation_id,
                message_id=body.message_id,
                metadata=metadata,
            )
        )
    return DevelopmentFeedbackItem(**asdict(row)).model_dump(by_alias=True)
