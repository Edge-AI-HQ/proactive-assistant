"""User-facing scheduled generator API.

Both the frontend and Main Chat native tools call this same `/api/*` surface:
frontend requests authenticate as a Supabase user, while native tools
authenticate with an agent-run JWT.
"""

from __future__ import annotations

import inspect
from collections.abc import Mapping
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, status
from fastapi.responses import JSONResponse
from psycopg_pool import AsyncConnectionPool
from pydantic import BaseModel, ConfigDict, Field

from ...auth.deps import AgentRun, User, current_agent_run, current_user, get_pool
from ...services.scheduled_generators import (
    ScheduledGeneratorNotFoundError,
    ScheduledGeneratorValidationError,
    create_scheduled_generator,
    delete_scheduled_generator,
    list_scheduled_generators,
    pause_scheduled_generator,
    preview_scheduled_generator,
    resume_scheduled_generator,
    serialize_task,
)

router = APIRouter(prefix="/api/scheduled-generators", tags=["scheduled-generators"])


class _CamelModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=lambda name: _to_camel(name),
        populate_by_name=True,
    )


def _to_camel(snake: str) -> str:
    parts = snake.split("_")
    return parts[0] + "".join(part.capitalize() for part in parts[1:])


class _ScheduledGeneratorPrincipal(BaseModel):
    user_id: int
    source: str


class ScheduledGeneratorPreviewRequest(_CamelModel):
    original_request: str = Field(min_length=1, max_length=2000)
    timezone: str = Field(min_length=1, max_length=100)
    conversation_id: str | None = Field(default=None, max_length=200)


class ScheduledGeneratorCreateRequest(_CamelModel):
    preview_id: str = Field(min_length=1, max_length=80)
    semantic_signature: str = Field(min_length=1, max_length=300)
    original_request: str = Field(min_length=1, max_length=2000)
    parsed_intent: dict[str, Any]
    confirmed_brief: dict[str, Any]
    duplicate_ack: bool = False
    similar_task_ids_seen: list[str] = Field(default_factory=list)


async def _call_dependency(fn, **kwargs):
    result = fn(**kwargs)
    if inspect.isawaitable(result):
        return await result
    return result


async def scheduled_generator_principal(
    request: Request,
    authorization: str | None = Header(default=None),
    x_dev_auth: str | None = Header(default=None, alias="X-Dev-Auth"),
    pool: AsyncConnectionPool = Depends(get_pool),
) -> _ScheduledGeneratorPrincipal:
    """Resolve either agent-run JWT or Supabase user JWT.

    We try the agent principal first because agent-run JWT validation is local
    and avoids a Supabase JWKS lookup when the caller is a native tool.
    """
    agent_dep = request.app.dependency_overrides.get(current_agent_run)
    user_dep = request.app.dependency_overrides.get(current_user)
    agent_error: HTTPException | None = None
    try:
        if agent_dep is not None:
            agent = await _call_dependency(agent_dep)
        else:
            agent = await current_agent_run(authorization=authorization, pool=pool)
        if isinstance(agent, AgentRun):
            return _ScheduledGeneratorPrincipal(user_id=agent.user_id, source="agent")
    except HTTPException as e:
        agent_error = e

    try:
        if user_dep is not None:
            user = await _call_dependency(user_dep)
        else:
            user = await current_user(
                authorization=authorization,
                x_dev_auth=x_dev_auth,
                pool=pool,
            )
        if isinstance(user, User):
            return _ScheduledGeneratorPrincipal(user_id=user.id, source="user")
    except HTTPException as user_error:
        if authorization is None and x_dev_auth is None:
            raise user_error from user_error
        raise agent_error or user_error

    raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid principal")


@router.post("/preview")
async def preview(
    req: ScheduledGeneratorPreviewRequest,
    principal: _ScheduledGeneratorPrincipal = Depends(scheduled_generator_principal),
    pool: AsyncConnectionPool = Depends(get_pool),
):
    try:
        result = await preview_scheduled_generator(
            pool,
            user_id=principal.user_id,
            original_request=req.original_request,
            timezone=req.timezone,
            conversation_id=req.conversation_id,
        )
    except ScheduledGeneratorValidationError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return _dump(result)


@router.get("")
async def list_items(
    include_archived: bool = Query(default=False, alias="includeArchived"),
    principal: _ScheduledGeneratorPrincipal = Depends(scheduled_generator_principal),
    pool: AsyncConnectionPool = Depends(get_pool),
):
    items = await list_scheduled_generators(
        pool,
        user_id=principal.user_id,
        include_archived=include_archived,
    )
    return _dump({"items": [serialize_task(row) for row in items]})


@router.post("")
async def create(
    req: ScheduledGeneratorCreateRequest,
    principal: _ScheduledGeneratorPrincipal = Depends(scheduled_generator_principal),
    pool: AsyncConnectionPool = Depends(get_pool),
):
    try:
        result = await create_scheduled_generator(
            pool,
            user_id=principal.user_id,
            preview_id=req.preview_id,
            semantic_signature=req.semantic_signature,
            original_request=req.original_request,
            parsed_intent=req.parsed_intent,
            confirmed_brief=req.confirmed_brief,
            duplicate_ack=req.duplicate_ack,
            similar_task_ids_seen=req.similar_task_ids_seen,
        )
    except ScheduledGeneratorValidationError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    if result.requires_confirmation:
        return JSONResponse(
            status_code=status.HTTP_409_CONFLICT,
            content=_dump(
                {
                    "requires_confirmation": True,
                    "similar_tasks": [serialize_task(row) for row in result.similar_tasks],
                }
            ),
        )
    assert result.task is not None
    return JSONResponse(
        status_code=status.HTTP_201_CREATED if result.created else status.HTTP_200_OK,
        content=_dump({"task": serialize_task(result.task)}),
    )


@router.post("/{task_id}/pause")
async def pause(
    task_id: str,
    principal: _ScheduledGeneratorPrincipal = Depends(scheduled_generator_principal),
    pool: AsyncConnectionPool = Depends(get_pool),
):
    try:
        task = await pause_scheduled_generator(pool, user_id=principal.user_id, task_id=task_id)
    except ScheduledGeneratorNotFoundError as e:
        raise HTTPException(status_code=404, detail="scheduled generator not found") from e
    return _dump({"task": serialize_task(task)})


@router.post("/{task_id}/resume")
async def resume(
    task_id: str,
    principal: _ScheduledGeneratorPrincipal = Depends(scheduled_generator_principal),
    pool: AsyncConnectionPool = Depends(get_pool),
):
    try:
        task = await resume_scheduled_generator(pool, user_id=principal.user_id, task_id=task_id)
    except ScheduledGeneratorNotFoundError as e:
        raise HTTPException(status_code=404, detail="scheduled generator not found") from e
    return _dump({"task": serialize_task(task)})


@router.delete("/{task_id}")
async def delete(
    task_id: str,
    principal: _ScheduledGeneratorPrincipal = Depends(scheduled_generator_principal),
    pool: AsyncConnectionPool = Depends(get_pool),
):
    try:
        task = await delete_scheduled_generator(pool, user_id=principal.user_id, task_id=task_id)
    except ScheduledGeneratorNotFoundError as e:
        raise HTTPException(status_code=404, detail="scheduled generator not found") from e
    return _dump({"task": serialize_task(task)})


def _dump(value: Any) -> Any:
    if isinstance(value, BaseModel):
        return _dump(value.model_dump(mode="python", by_alias=False))
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, Mapping):
        return {_to_camel(str(key)): _dump(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_dump(item) for item in value]
    return value
