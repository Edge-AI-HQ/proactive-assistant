"""/api/development-feedback — user-facing product suggestion intake."""

from __future__ import annotations

from dataclasses import asdict

from fastapi import APIRouter, Depends, status

from ....shared.api_models import (
    DevelopmentFeedbackCreateResponse,
    DevelopmentFeedbackItem,
    DevelopmentFeedbackLogRequest,
)
from ...auth.deps import User, current_user, get_pool
from ...db.repositories.development_feedback import (
    AddDevelopmentFeedbackInput,
    DevelopmentFeedbackRepository,
)
from ...db.rls import user_scoped_tx

router = APIRouter(prefix="/api/development-feedback", tags=["development-feedback"])


@router.post("", status_code=status.HTTP_201_CREATED)
async def post_development_feedback(
    body: DevelopmentFeedbackLogRequest,
    user: User = Depends(current_user),
    pool=Depends(get_pool),
):
    async with user_scoped_tx(pool, user.id) as conn:
        repo = DevelopmentFeedbackRepository(user.id, conn)
        row = await repo.add(
            AddDevelopmentFeedbackInput(
                text=body.text,
                summary=body.summary,
                category=body.category,
                surface=body.surface,
                source="user",
                conversation_id=body.conversation_id,
                message_id=body.message_id,
                metadata=body.metadata,
            )
        )
    return DevelopmentFeedbackCreateResponse(
        received=True,
        item=DevelopmentFeedbackItem(**asdict(row)),
    ).model_dump(by_alias=True)
