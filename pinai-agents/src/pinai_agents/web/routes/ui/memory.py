"""/api/memory — frontend memory CRUD.

Mirrors plugin's /memory endpoint shape. Uses MemoryRepository.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query, status

from ....shared.api_models import (
    MemoryCreateRequest,
    MemoryItem,
    MemorySupersedeRequest,
)
from ...auth.deps import User, current_user, get_pool
from ...db.repositories.memory import AddMemoryInput, MemoryRepository, MemoryRow
from ...db.rls import user_scoped_tx

router = APIRouter(prefix="/api/memory", tags=["memory"])


def _to_item(row: MemoryRow) -> MemoryItem:
    return MemoryItem(
        id=row.id,
        text=row.text,
        source=row.source,
        source_run_id=row.source_run_id,
        subject=row.subject,
        quality=row.quality,
        confidence=row.confidence,
        status=row.status,
        superseded_by=row.superseded_by,
        occurred_at=row.occurred_at,
        created_at=row.created_at,
        tags=row.tags,
        related_memory_ids=row.related_memory_ids,
        reference_count=row.reference_count,
        last_referenced_at=row.last_referenced_at,
    )


# Frontend `MemoryListFilter` exposes orderBy + orderDirection as
# separate fields ('created_at' / 'quality' / 'last_referenced_at' x
# 'asc' / 'desc'). The repository takes a single combined token
# (`created_at_desc`, `quality_desc`, `last_referenced_desc`) so we
# fold the two query params into the repo's vocabulary here. Unsupported
# combinations fall back to the repo default.
_ORDER_BY_MAP: dict[tuple[str, str], str] = {
    ("created_at", "desc"): "created_at_desc",
    ("quality", "desc"): "quality_desc",
    ("last_referenced_at", "desc"): "last_referenced_desc",
}


def _resolve_order_by(order_by: str | None, order_direction: str | None) -> str:
    if (
        order_by
        and "_" in order_by
        and order_by
        in {
            "created_at_desc",
            "quality_desc",
            "last_referenced_desc",
        }
    ):
        return order_by  # already a combined token
    direction = (order_direction or "desc").lower()
    return _ORDER_BY_MAP.get((order_by or "created_at", direction), "created_at_desc")


@router.get("")
async def list_memory(
    user: User = Depends(current_user),
    pool=Depends(get_pool),
    min_quality: float = Query(0.0, ge=0, le=1, alias="minQuality"),
    subject: str | None = Query(None, max_length=200),
    subject_prefix: str | None = Query(None, max_length=200, alias="subjectPrefix"),
    since: datetime | None = Query(None),
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
    order_by: str | None = Query(None, alias="orderBy"),
    order_direction: str | None = Query(None, alias="orderDirection"),
):
    """Wire shape `{ok, memories, total}` matches the frontend's
    `fetchMemories` contract (lib/api.ts). Agents read the same data via
    `/api/agent/memory/list` which uses the simpler `{items}` envelope —
    intentionally different so the UI can paginate without breaking
    SDK callers."""
    async with user_scoped_tx(pool, user.id) as conn:
        repo = MemoryRepository(user.id, conn)
        rows, total = await repo.list_active(
            min_quality=min_quality,
            subject=subject,
            subject_prefix=subject_prefix,
            since=since,
            limit=limit,
            offset=offset,
            order_by=_resolve_order_by(order_by, order_direction),
        )
    items = [_to_item(r) for r in rows]
    # MemoryItem dumps to camelCase keys via _CamelModel; bypass
    # response_model so we can hand-craft the wrapper shape the
    # frontend reads (response_model would re-wrap into MemoryListResponse).
    return {
        "ok": True,
        "memories": [m.model_dump(by_alias=True, mode="json") for m in items],
        "total": total,
    }


@router.get("/{memory_id}", response_model=MemoryItem)
async def get_memory(
    memory_id: str,
    user: User = Depends(current_user),
    pool=Depends(get_pool),
):
    async with user_scoped_tx(pool, user.id) as conn:
        repo = MemoryRepository(user.id, conn)
        row = await repo.get(memory_id)
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="memory not found")
    return _to_item(row)


@router.post("", response_model=MemoryItem, status_code=status.HTTP_201_CREATED)
async def add_memory(
    body: MemoryCreateRequest,
    user: User = Depends(current_user),
    pool=Depends(get_pool),
):
    mem_id = body.id or f"mem_{uuid.uuid4().hex[:16]}"
    async with user_scoped_tx(pool, user.id) as conn:
        repo = MemoryRepository(user.id, conn)
        row = await repo.add(
            AddMemoryInput(
                id=mem_id,
                text=body.text,
                source=body.source,
                subject=body.subject,
                quality=body.quality,
                confidence=body.confidence,
                source_run_id=body.source_run_id,
                occurred_at=body.occurred_at,
                tags=body.tags,
            )
        )
    return _to_item(row)


@router.post("/{memory_id}/archive", response_model=MemoryItem)
async def archive_memory(
    memory_id: str,
    user: User = Depends(current_user),
    pool=Depends(get_pool),
):
    async with user_scoped_tx(pool, user.id) as conn:
        repo = MemoryRepository(user.id, conn)
        row = await repo.archive(memory_id)
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="memory not found or already archived",
        )
    return _to_item(row)


@router.post("/supersede", response_model=MemoryItem)
async def supersede_memory(
    body: MemorySupersedeRequest,
    user: User = Depends(current_user),
    pool=Depends(get_pool),
):
    async with user_scoped_tx(pool, user.id) as conn:
        repo = MemoryRepository(user.id, conn)
        row = await repo.supersede(old_id=body.old_id, new_id=body.new_id)
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="old memory not found or not active",
        )
    return _to_item(row)
