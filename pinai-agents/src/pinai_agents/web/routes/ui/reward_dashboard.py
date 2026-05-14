"""/api/reward-dashboard - internal card reward dashboard surface."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query

from ...auth.deps import User, current_user, get_pool
from ...db.repositories.reward import (
    CasebookLabel,
    RewardRepository,
)
from ...db.rls import user_scoped_tx
from ...services.personal_data_snapshot import (
    PersonalDataCategory,
    PersonalDataSnapshotService,
)
from ...services.trace_artifacts import TraceArtifactService

router = APIRouter(prefix="/api/reward-dashboard", tags=["reward-dashboard"])


def _body_dict(body: Any) -> dict[str, Any]:
    return body if isinstance(body, dict) else {}


def _score_value(value: Any) -> float | None:
    if value is None:
        return None
    if not isinstance(value, int | float):
        raise HTTPException(status_code=422, detail="score must be a number")
    score = float(value)
    if not 0 <= score <= 10:
        raise HTTPException(status_code=422, detail="score must be between 0 and 10")
    return score


def _review_score_value(value: Any, *, event_type: str) -> float | None:
    score = _score_value(value)
    if event_type in {"user_score", "reviewer_score"} and score is not None and score < 1:
        raise HTTPException(status_code=422, detail=f"{event_type} score must be between 1 and 10")
    return score


def _validate_score_event(source: str, event_type: str) -> None:
    valid_pairs = {
        "card_open": {"user"},
        "user_score": {"user"},
        "reviewer_score": {"reviewer"},
        "dismiss": {"user"},
        "imported_feedback": {"system"},
    }
    allowed_sources = valid_pairs.get(event_type)
    if allowed_sources is None or source not in allowed_sources:
        raise HTTPException(
            status_code=422,
            detail=f"invalid source/eventType pair: {source}/{event_type}",
        )


@router.get("/runs")
async def list_runs(
    user: User = Depends(current_user),
    pool=Depends(get_pool),
    limit: int = Query(50, ge=1, le=200),
    trigger: str | None = Query(None),
    since: datetime | None = Query(None),
    until: datetime | None = Query(None),
    reviewed: bool | None = Query(None),
    quality: Literal["aha", "dead", "reviewer_aha"] | None = Query(None),
):
    async with user_scoped_tx(pool, user.id) as conn:
        repo = RewardRepository(user.id, conn)
        runs = await repo.list_runs(
            limit=limit,
            trigger=trigger,
            since=since,
            until=until,
            reviewed=reviewed,
            quality=quality,
        )
    return {"ok": True, "runs": runs}


@router.get("/runs/{run_id}")
async def get_run(
    run_id: str,
    user: User = Depends(current_user),
    pool=Depends(get_pool),
):
    async with user_scoped_tx(pool, user.id) as conn:
        repo = RewardRepository(user.id, conn)
        detail = await repo.get_run_detail(run_id)
    if detail is None:
        raise HTTPException(status_code=404, detail="run not found")
    return {"ok": True, **detail}


@router.get("/cards/{card_id}")
async def get_card(
    card_id: str,
    user: User = Depends(current_user),
    pool=Depends(get_pool),
):
    async with user_scoped_tx(pool, user.id) as conn:
        repo = RewardRepository(user.id, conn)
        detail = await repo.get_card_detail(card_id)
    if detail is None:
        raise HTTPException(status_code=404, detail="card not found")
    return {"ok": True, **detail}


@router.post("/cards/{card_id}/score")
async def score_card(
    card_id: str,
    body: dict,
    user: User = Depends(current_user),
    pool=Depends(get_pool),
):
    data = _body_dict(body)
    event_type = data.get("eventType") or data.get("event_type") or "reviewer_score"
    source = data.get("source") or ("user" if event_type in {"card_open", "user_score"} else "reviewer")
    if not isinstance(event_type, str) or not isinstance(source, str):
        raise HTTPException(status_code=422, detail="invalid score event")
    _validate_score_event(source, event_type)
    score = _review_score_value(data.get("score"), event_type=event_type)
    metadata = data.get("metadata") if isinstance(data.get("metadata"), dict) else {}
    reason = data.get("reason") if isinstance(data.get("reason"), str) else None
    run_id = data.get("runId") or data.get("run_id")
    if event_type == "card_open":
        score = 1.0

    try:
        async with user_scoped_tx(pool, user.id) as conn:
            repo = RewardRepository(user.id, conn)
            event = await repo.create_reward_event(
                card_id=card_id,
                run_id=run_id if isinstance(run_id, str) else None,
                source=source,
                event_type=event_type,
                score=score,
                reason=reason,
                metadata=metadata,
            )
            detail = await repo.get_card_detail(card_id)
    except LookupError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    return {"ok": True, "event": event, "card": detail}


@router.post("/cards/{card_id}/casebook")
async def upsert_casebook(
    card_id: str,
    body: dict,
    user: User = Depends(current_user),
    pool=Depends(get_pool),
):
    data = _body_dict(body)
    label = data.get("label")
    if not isinstance(label, str) or not label:
        raise HTTPException(status_code=422, detail="label required")
    note_raw = data.get("reviewerNote") or data.get("reviewer_note") or data.get("note")
    reviewer_note = note_raw if isinstance(note_raw, str) else None
    try:
        async with user_scoped_tx(pool, user.id) as conn:
            case = await RewardRepository(user.id, conn).upsert_casebook(
                card_id=card_id,
                label=label,
                reviewer_note=reviewer_note,
            )
    except LookupError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    return {"ok": True, "casebook": case}


@router.delete("/cards/{card_id}/casebook")
async def delete_casebook(
    card_id: str,
    user: User = Depends(current_user),
    pool=Depends(get_pool),
):
    async with user_scoped_tx(pool, user.id) as conn:
        deleted = await RewardRepository(user.id, conn).delete_casebook(card_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="casebook entry not found")
    return {"ok": True}


@router.get("/casebook")
async def list_casebook(
    user: User = Depends(current_user),
    pool=Depends(get_pool),
    label: CasebookLabel | None = Query(None),
    min_score: float | None = Query(None, ge=0, le=10, alias="minScore"),
    max_score: float | None = Query(None, ge=0, le=10, alias="maxScore"),
    basket: str | None = Query(None),
    intent: str | None = Query(None),
    min_evaluator_gap: float | None = Query(None, ge=0, le=10, alias="minEvaluatorGap"),
    since: datetime | None = Query(None),
    until: datetime | None = Query(None),
    limit: int = Query(20, ge=1, le=200),
    offset: int = Query(0, ge=0),
):
    async with user_scoped_tx(pool, user.id) as conn:
        repo = RewardRepository(user.id, conn)
        total = await repo.count_casebook(
            label=label,
            min_score=min_score,
            max_score=max_score,
            basket=basket,
            intent=intent,
            min_evaluator_gap=min_evaluator_gap,
            since=since,
            until=until,
        )
        cases = await repo.list_casebook(
            label=label,
            min_score=min_score,
            max_score=max_score,
            basket=basket,
            intent=intent,
            min_evaluator_gap=min_evaluator_gap,
            since=since,
            until=until,
            limit=limit,
            offset=offset,
        )
    return {"ok": True, "items": cases, "total": total, "limit": limit, "offset": offset}


@router.post("/runs/{run_id}/trace")
async def build_trace(
    run_id: str,
    body: dict | None = None,
    user: User = Depends(current_user),
    pool=Depends(get_pool),
):
    data = _body_dict(body)
    force = bool(data.get("force"))
    try:
        async with user_scoped_tx(pool, user.id) as conn:
            repo = RewardRepository(user.id, conn)
            artifact = await TraceArtifactService(repo).get_or_generate(run_id, force=force)
    except LookupError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    return {"ok": True, "trace": artifact}


@router.get("/runs/{run_id}/trace")
async def get_trace(
    run_id: str,
    user: User = Depends(current_user),
    pool=Depends(get_pool),
):
    async with user_scoped_tx(pool, user.id) as conn:
        repo = RewardRepository(user.id, conn)
        canonical_run_id = await repo.resolve_run_id(run_id)
        artifact = (
            await repo.get_trace_artifact(canonical_run_id)
            if canonical_run_id is not None
            else None
        )
    if canonical_run_id is None:
        raise HTTPException(status_code=404, detail="run not found")
    if artifact is None:
        return {
            "ok": True,
            "trace": {
                "runId": canonical_run_id,
                "status": "missing",
                "traceTree": {},
                "summary": {"reason": "trace artifact has not been generated"},
                "error": "trace artifact has not been generated",
            },
        }
    return {"ok": True, "trace": artifact}


@router.get("/metrics")
async def metrics(
    user: User = Depends(current_user),
    pool=Depends(get_pool),
    days: int = Query(14, ge=1, le=90),
):
    async with user_scoped_tx(pool, user.id) as conn:
        out = await RewardRepository(user.id, conn).metrics(days=days)
    return {"ok": True, **out}


@router.get("/personal-data")
async def personal_data(
    user: User = Depends(current_user),
    pool=Depends(get_pool),
    category: PersonalDataCategory = Query("all"),
    since: datetime | None = Query(None),
    until: datetime | None = Query(None),
    q: str | None = Query(None, max_length=200),
    limit: int = Query(40, ge=5, le=200),
    offset: int = Query(0, ge=0, le=10000),
):
    async with user_scoped_tx(pool, user.id) as conn:
        return await PersonalDataSnapshotService(conn, user.id).snapshot(
            category=category,
            since=since,
            until=until,
            query=q.strip() if isinstance(q, str) and q.strip() else None,
            limit=limit,
            offset=offset,
        )
