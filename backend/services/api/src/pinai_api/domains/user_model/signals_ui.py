"""/api/signals — frontend personal signal queries."""

from __future__ import annotations

import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, Query, status
from pinai_contracts.api_models import (
    PersonalSignalConsumeRequest,
    PersonalSignalIngestRequest,
    PersonalSignalItem,
)
from pinai_db.rls import user_scoped_tx

from ...platform.auth.deps import User, current_user, get_pool
from .personal_signals import (
    IngestSignalInput,
    PersonalSignalRow,
    PersonalSignalsRepository,
)

router = APIRouter(prefix="/api/signals", tags=["signals"])


def _to_item(row: PersonalSignalRow) -> PersonalSignalItem:
    return PersonalSignalItem(
        id=row.id,
        kind=row.kind,
        title=row.title,
        summary=row.summary,
        payload=row.payload,
        salience=row.salience,
        confidence=row.confidence,
        dedupe_key=row.dedupe_key,
        occurred_at=row.occurred_at,
        available_at=row.available_at,
        expires_at=row.expires_at,
        source=row.source,
        device_id=row.device_id,
        subject=row.subject,
        source_raw_table=row.source_raw_table,
        source_raw_ids=row.source_raw_ids,
        status=row.status,
        consumed_by_run_id=row.consumed_by_run_id,
        ingested_at=row.ingested_at,
    )


@router.get("")
async def list_signals(
    user: User = Depends(current_user),
    pool=Depends(get_pool),
    status_filter: str | None = Query(
        "open", alias="status", pattern="^(open|consumed|archived|all)$"
    ),
    kind: str | None = Query(None),
    source: str | None = Query(None),
    device_id: str | None = Query(None, alias="deviceId"),
    since: datetime | None = Query(None),
    before: datetime | None = Query(None),
    min_salience: float | None = Query(None, ge=0, le=1, alias="minSalience"),
    limit: int = Query(30, ge=1, le=200),
    offset: int = Query(0, ge=0),
):
    """Wire shape `{ok, signals, total, has_more}` matches the frontend's
    `fetchSignals` contract (lib/api.ts). Bypasses response_model so we
    can hand-craft the wrapper — matches the same pattern memory.py uses
    so the SPA's `Signals N open` metric reads a real number instead of
    falling back to -1.

    `total` is the count of all rows matching the filters (via
    `COUNT(*) OVER()` inside list_recent), not just the current page,
    so the SPA's "Signals N open" metric and load-more pagination both
    show the truth. `has_more` is computed from `offset + len(rows)`
    against `total` rather than `len(rows) >= limit`, which avoids the
    false-positive when the filtered set happens to fill exactly one
    page.
    """
    actual_status = None if status_filter == "all" else status_filter
    async with user_scoped_tx(pool, user.id) as conn:
        repo = PersonalSignalsRepository(user.id, conn)
        rows, total = await repo.list_recent(
            status=actual_status,
            kind=kind,
            source=source,
            device_id=device_id,
            since=since,
            before=before,
            min_salience=min_salience,
            limit=limit,
            offset=offset,
        )
    items = [_to_item(r) for r in rows]
    return {
        "ok": True,
        "signals": [s.model_dump(by_alias=True, mode="json") for s in items],
        "total": total,
        "has_more": offset + len(rows) < total,
        "next_cursor": None,
    }


@router.post("/ingest", response_model=PersonalSignalItem, status_code=status.HTTP_201_CREATED)
async def ingest_signal(
    body: PersonalSignalIngestRequest,
    user: User = Depends(current_user),
    pool=Depends(get_pool),
):
    sig_id = body.id or f"sig_{uuid.uuid4().hex[:16]}"
    async with user_scoped_tx(pool, user.id) as conn:
        repo = PersonalSignalsRepository(user.id, conn)
        row = await repo.ingest_one(
            IngestSignalInput(
                id=sig_id,
                kind=body.kind,
                title=body.title,
                summary=body.summary,
                occurred_at=body.occurred_at,
                payload=body.payload,
                salience=body.salience,
                confidence=body.confidence,
                dedupe_key=body.dedupe_key,
                available_at=body.available_at,
                expires_at=body.expires_at,
                source=body.source,
                device_id=body.device_id,
                subject=body.subject,
                source_raw_table=body.source_raw_table,
                source_raw_ids=body.source_raw_ids,
            )
        )
    return _to_item(row)


@router.post("/{signal_id}/consume", status_code=status.HTTP_204_NO_CONTENT)
async def consume_signal(
    signal_id: str,
    body: PersonalSignalConsumeRequest,
    user: User = Depends(current_user),
    pool=Depends(get_pool),
):
    async with user_scoped_tx(pool, user.id) as conn:
        repo = PersonalSignalsRepository(user.id, conn)
        await repo.mark_consumed(signal_id, body.run_id)
    return None
