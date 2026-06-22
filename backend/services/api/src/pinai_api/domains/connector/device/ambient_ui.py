"""Frontend Ambient cloud helpers."""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field

from ....domains.billing.provisioning import ensure_user_litellm_key
from ....platform.auth.deps import User, current_user, get_pool
from ....platform.litellm.client import LiteLLMError
from .ambient_summary import (
    DEFAULT_AMBIENT_SUMMARY_MODEL,
    AmbientSummaryContext,
    AmbientSummaryDraft,
    generate_ambient_summary,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/ambient", tags=["ambient"])


class AmbientSummaryRequest(BaseModel):
    context: AmbientSummaryContext


class AmbientSummaryResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    ok: bool = True
    draft: AmbientSummaryDraft
    model_id: str = Field(alias="modelId")


@router.post("/summary", response_model=AmbientSummaryResponse, response_model_by_alias=True)
async def summarize_ambient(
    req: AmbientSummaryRequest,
    user: User = Depends(current_user),
    pool=Depends(get_pool),
) -> AmbientSummaryResponse:
    try:
        user = await ensure_user_litellm_key(
            pool,
            user,
            required_models={DEFAULT_AMBIENT_SUMMARY_MODEL},
        )
    except Exception as exc:
        logger.exception("ambient summary key provisioning failed user=%s", user.id)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"unable to provision LiteLLM key: {type(exc).__name__}: {exc}",
        ) from exc
    if not user.litellm_virtual_key:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="LiteLLM key missing after provisioning",
        )

    try:
        draft = await generate_ambient_summary(
            context=req.context,
            bearer_token=user.litellm_virtual_key,
            model=DEFAULT_AMBIENT_SUMMARY_MODEL,
        )
    except LiteLLMError as exc:
        logger.warning("ambient summary failed user=%s: %s", user.id, exc)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=str(exc),
        ) from exc
    return AmbientSummaryResponse(draft=draft, modelId=DEFAULT_AMBIENT_SUMMARY_MODEL)
