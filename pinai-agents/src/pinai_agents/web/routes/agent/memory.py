"""/api/agent/memory/* — agent-side memory endpoints (HS256 JWT).

Endpoints follow PinCLI command surface:
  GET  /api/agent/memory/list
  GET  /api/agent/memory/get/{id}
  POST /api/agent/memory/add
  POST /api/agent/memory/archive/{id}
  POST /api/agent/memory/supersede

Implementation reuses MemoryRepository (same as /api/memory). Auth dep
swaps Supabase JWT for HS256 agent run JWT.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query, status

from ...auth.deps import AgentRun, current_agent_run, get_pool
from ...db.repositories.memory import (
    AddMemoryInput,
    MemoryRepository,
    MemoryRow,
)
from ...db.rls import user_scoped_tx

router = APIRouter(prefix="/api/agent/memory", tags=["agent-memory"])


def _to_dict(row: MemoryRow) -> dict:
    return {
        "id": row.id, "text": row.text, "source": row.source,
        "sourceRunId": row.source_run_id, "subject": row.subject,
        "quality": row.quality, "confidence": row.confidence,
        "status": row.status, "supersededBy": row.superseded_by,
        "occurredAt": row.occurred_at.isoformat() if row.occurred_at else None,
        "createdAt": row.created_at.isoformat(),
        "tags": row.tags,
        "referenceCount": row.reference_count,
    }


@router.get("/list")
async def list_memory(
    run: AgentRun = Depends(current_agent_run),
    pool=Depends(get_pool),
    min_quality: float = Query(0.0, ge=0, le=1, alias="minQuality"),
    subject: str | None = Query(None),
    subject_prefix: str | None = Query(None, alias="subjectPrefix"),
    since: datetime | None = Query(None),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    order_by: str = Query("created_at_desc", alias="orderBy"),
):
    async with user_scoped_tx(pool, run.user_id) as conn:
        repo = MemoryRepository(run.user_id, conn)
        rows, _total = await repo.list_active(
            min_quality=min_quality, subject=subject,
            subject_prefix=subject_prefix, since=since,
            limit=limit, offset=offset, order_by=order_by,
        )
    return {"items": [_to_dict(r) for r in rows]}


@router.get("/search")
async def search_memory(
    run: AgentRun = Depends(current_agent_run),
    pool=Depends(get_pool),
    query: str = Query(..., min_length=1, max_length=2000, alias="q"),
    min_quality: float | None = Query(None, ge=0, le=1, alias="minQuality"),
    limit: int = Query(10, ge=1, le=50),
):
    """Semantic search over the user's memories.

    Embeds the query via LiteLLM `/embeddings` and runs cosine-similarity
    against pgvector-indexed memory rows. Rows whose embedding hasn't
    been computed yet (queue lag) are excluded — caller can fall back
    to /list for keyword filtering.
    """
    from ...embeddings import EmbeddingError, text_to_query_vector  # noqa: PLC0415
    try:
        qvec = await text_to_query_vector(query)
    except EmbeddingError as e:
        raise HTTPException(503, f"embedding service unavailable: {e}") from e

    async with user_scoped_tx(pool, run.user_id) as conn:
        repo = MemoryRepository(run.user_id, conn)
        rows = await repo.search_semantic(
            query_vector=qvec, limit=limit, min_quality=min_quality,
        )
    return {"items": [_to_dict(r) for r in rows]}


@router.get("/get/{memory_id}")
async def get_memory(
    memory_id: str,
    run: AgentRun = Depends(current_agent_run),
    pool=Depends(get_pool),
):
    async with user_scoped_tx(pool, run.user_id) as conn:
        repo = MemoryRepository(run.user_id, conn)
        row = await repo.get(memory_id)
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="not found")
    return _to_dict(row)


@router.post("/add")
async def add_memory(
    body: dict,
    run: AgentRun = Depends(current_agent_run),
    pool=Depends(get_pool),
):
    mem_id = body.get("id") or f"mem_{uuid.uuid4().hex[:16]}"
    async with user_scoped_tx(pool, run.user_id) as conn:
        repo = MemoryRepository(run.user_id, conn)
        row = await repo.add(AddMemoryInput(
            id=mem_id,
            text=body["text"],
            source=body.get("source", "agent"),
            subject=body.get("subject"),
            quality=float(body.get("quality", 0.5)),
            confidence=float(body.get("confidence", 0.5)),
            source_run_id=body.get("sourceRunId") or run.run_id,
            tags=body.get("tags") or [],
        ))
    return _to_dict(row)


@router.post("/archive/{memory_id}", status_code=status.HTTP_200_OK)
async def archive_memory(
    memory_id: str,
    run: AgentRun = Depends(current_agent_run),
    pool=Depends(get_pool),
):
    async with user_scoped_tx(pool, run.user_id) as conn:
        repo = MemoryRepository(run.user_id, conn)
        row = await repo.archive(memory_id)
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="already archived or missing")
    return _to_dict(row)


@router.post("/supersede")
async def supersede_memory(
    body: dict,
    run: AgentRun = Depends(current_agent_run),
    pool=Depends(get_pool),
):
    old_id = body.get("oldId") or body.get("old_id")
    new_id = body.get("newId") or body.get("new_id")
    if not old_id or not new_id:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                            detail="oldId / newId required")
    async with user_scoped_tx(pool, run.user_id) as conn:
        repo = MemoryRepository(run.user_id, conn)
        row = await repo.supersede(old_id=old_id, new_id=new_id)
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="old memory not active")
    return _to_dict(row)
