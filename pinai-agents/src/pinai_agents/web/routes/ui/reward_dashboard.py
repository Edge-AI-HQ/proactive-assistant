"""/api/reward-dashboard - internal card reward dashboard surface."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from math import isfinite
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query

from ...auth.deps import User, current_user, get_pool
from ...db.repositories.patterns import PatternsRepository
from ...db.repositories.reward import (
    VALID_CASEBOOK_LABELS,
    CasebookLabel,
    RewardRepository,
)
from ...db.rls import user_scoped_tx
from ...services.pattern_extractor import run_pattern_extractor
from ...services.pattern_health import (
    compute_pattern_health,
    compute_pattern_health_one,
    run_pattern_health_job,
)
from ...services.personal_data_snapshot import (
    PersonalDataCategory,
    PersonalDataSnapshotService,
)
from ...services.trace_artifacts import TraceArtifactService

router = APIRouter(prefix="/api/reward-dashboard", tags=["reward-dashboard"])
CASEBOOK_REVIEWER_NOTE_MAX_LENGTH = 2_000
SCORE_REASON_MAX_LENGTH = 1_000
REWARD_METADATA_MAX_JSON_LENGTH = 4_096
REWARD_METADATA_MAX_DEPTH = 4
CASEBOOK_OFFSET_MAX = 10_000
REWARD_TEXT_FILTER_MAX_LENGTH = 120


def _body_dict(body: Any) -> dict[str, Any]:
    return body if isinstance(body, dict) else {}


def _path_id(value: str, *, field_name: str) -> str:
    item_id = value.strip()
    if not item_id:
        raise HTTPException(status_code=422, detail=f"{field_name} required")
    return item_id


def _optional_path_id(value: Any, *, field_name: str) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise HTTPException(status_code=422, detail=f"{field_name} must be a string")
    item_id = value.strip()
    return item_id or None


def _casebook_label(value: Any) -> str:
    if not isinstance(value, str):
        raise HTTPException(status_code=422, detail="label required")
    label = value.strip()
    if not label:
        raise HTTPException(status_code=422, detail="label required")
    if label not in VALID_CASEBOOK_LABELS:
        raise HTTPException(status_code=422, detail=f"invalid casebook label: {label}")
    return label


def _optional_trimmed_text(
    value: Any,
    *,
    field_name: str,
    max_length: int,
) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise HTTPException(status_code=422, detail=f"{field_name} must be a string")
    text = value.strip()
    if not text:
        return None
    if len(text) > max_length:
        raise HTTPException(status_code=422, detail=f"{field_name} must be at most {max_length} characters")
    return text


def _safe_metadata_value(value: Any, *, field_name: str, depth: int = 0) -> Any:
    if depth > REWARD_METADATA_MAX_DEPTH:
        raise HTTPException(status_code=422, detail=f"{field_name} is too deeply nested")
    if value is None or isinstance(value, bool | str):
        return value
    if isinstance(value, int | float):
        if not isfinite(float(value)):
            raise HTTPException(status_code=422, detail=f"{field_name} numbers must be finite")
        return value
    if isinstance(value, list):
        if len(value) > 50:
            raise HTTPException(status_code=422, detail=f"{field_name} contains too many items")
        return [
            _safe_metadata_value(item, field_name=field_name, depth=depth + 1)
            for item in value
        ]
    if isinstance(value, dict):
        if len(value) > 50:
            raise HTTPException(status_code=422, detail=f"{field_name} contains too many items")
        return {
            str(key): _safe_metadata_value(item, field_name=field_name, depth=depth + 1)
            for key, item in value.items()
        }
    raise HTTPException(status_code=422, detail=f"{field_name} contains unsupported values")


def _reward_metadata(value: Any) -> dict[str, Any]:
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise HTTPException(status_code=422, detail="metadata must be an object")
    metadata = _safe_metadata_value(value, field_name="metadata")
    encoded = json.dumps(metadata, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
    if len(encoded) > REWARD_METADATA_MAX_JSON_LENGTH:
        raise HTTPException(
            status_code=422,
            detail=f"metadata must be at most {REWARD_METADATA_MAX_JSON_LENGTH} characters",
        )
    return metadata


def _optional_bool(value: Any, *, field_name: str, default: bool = False) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    raise HTTPException(status_code=422, detail=f"{field_name} must be a boolean")


def _score_event_type(data: dict[str, Any]) -> str:
    for key in ("eventType", "event_type"):
        value = data.get(key)
        if value is None:
            continue
        if not isinstance(value, str):
            raise HTTPException(status_code=422, detail="invalid score event")
        event_type = value.strip()
        if not event_type:
            continue
        if event_type not in {"card_open", "user_score", "reviewer_score"}:
            raise HTTPException(status_code=422, detail="invalid score event")
        return event_type
    return "reviewer_score"


def _score_source(data: dict[str, Any], *, event_type: str) -> str:
    value = data.get("source")
    default_source = "user" if event_type in {"card_open", "user_score"} else "reviewer"
    if value is None:
        return default_source
    if not isinstance(value, str):
        raise HTTPException(status_code=422, detail="invalid score source")
    source = value.strip()
    if not source:
        return default_source
    if source not in {"user", "reviewer", "system"}:
        raise HTTPException(status_code=422, detail="invalid score source")
    return source


def _sortable_datetime(value: datetime) -> datetime:
    if value.tzinfo is not None and value.utcoffset() is not None:
        return value.astimezone(UTC).replace(tzinfo=None)
    return value


def _validate_datetime_range(since: datetime | None, until: datetime | None) -> None:
    if since is None or until is None:
        return
    if _sortable_datetime(since) > _sortable_datetime(until):
        raise HTTPException(status_code=422, detail="since must be before or equal to until")


def _validate_numeric_range(
    min_value: float | None,
    max_value: float | None,
    *,
    min_name: str,
    max_name: str,
) -> None:
    for name, value in ((min_name, min_value), (max_name, max_value)):
        if value is not None and not isfinite(value):
            raise HTTPException(status_code=422, detail=f"{name} must be finite")
    if min_value is None or max_value is None:
        return
    if min_value > max_value:
        raise HTTPException(
            status_code=422,
            detail=f"{min_name} must be less than or equal to {max_name}",
        )


def _score_value(value: Any) -> float | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise HTTPException(status_code=422, detail="score must be a number")
    score = float(value)
    if not isfinite(score):
        raise HTTPException(status_code=422, detail="score must be a finite number")
    if not 0 <= score <= 10:
        raise HTTPException(status_code=422, detail="score must be between 0 and 10")
    return score


def _review_score_value(value: Any, *, event_type: str) -> float | None:
    score = _score_value(value)
    if event_type in {"user_score", "reviewer_score"} and (score is None or score < 1):
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
    _validate_datetime_range(since, until)
    safe_trigger = _optional_trimmed_text(
        trigger,
        field_name="trigger",
        max_length=REWARD_TEXT_FILTER_MAX_LENGTH,
    )
    async with user_scoped_tx(pool, user.id) as conn:
        repo = RewardRepository(user.id, conn)
        runs = await repo.list_runs(
            limit=limit,
            trigger=safe_trigger,
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
    safe_run_id = _path_id(run_id, field_name="run_id")
    async with user_scoped_tx(pool, user.id) as conn:
        repo = RewardRepository(user.id, conn)
        detail = await repo.get_run_detail(safe_run_id)
    if detail is None:
        raise HTTPException(status_code=404, detail="run not found")
    return {"ok": True, **detail}


@router.get("/cards/{card_id}")
async def get_card(
    card_id: str,
    user: User = Depends(current_user),
    pool=Depends(get_pool),
):
    safe_card_id = _path_id(card_id, field_name="card_id")
    async with user_scoped_tx(pool, user.id) as conn:
        repo = RewardRepository(user.id, conn)
        detail = await repo.get_card_detail(safe_card_id)
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
    safe_card_id = _path_id(card_id, field_name="card_id")
    data = _body_dict(body)
    event_type = _score_event_type(data)
    source = _score_source(data, event_type=event_type)
    _validate_score_event(source, event_type)
    score = _review_score_value(data.get("score"), event_type=event_type)
    metadata = _reward_metadata(data.get("metadata"))
    reason = _optional_trimmed_text(
        data.get("reason"),
        field_name="reason",
        max_length=SCORE_REASON_MAX_LENGTH,
    )
    run_id = data.get("runId") if "runId" in data else data.get("run_id")
    safe_run_id = _optional_path_id(run_id, field_name="run_id")
    if event_type == "card_open":
        score = 1.0

    try:
        async with user_scoped_tx(pool, user.id) as conn:
            repo = RewardRepository(user.id, conn)
            event = await repo.create_reward_event(
                card_id=safe_card_id,
                run_id=safe_run_id,
                source=source,
                event_type=event_type,
                score=score,
                reason=reason,
                metadata=metadata,
            )
            detail = await repo.get_card_detail(safe_card_id)
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
    safe_card_id = _path_id(card_id, field_name="card_id")
    data = _body_dict(body)
    label = _casebook_label(data.get("label"))
    note_raw = data.get("note")
    if "reviewer_note" in data:
        note_raw = data["reviewer_note"]
    if "reviewerNote" in data:
        note_raw = data["reviewerNote"]
    reviewer_note = _optional_trimmed_text(
        note_raw,
        field_name="reviewerNote",
        max_length=CASEBOOK_REVIEWER_NOTE_MAX_LENGTH,
    )
    try:
        async with user_scoped_tx(pool, user.id) as conn:
            case = await RewardRepository(user.id, conn).upsert_casebook(
                card_id=safe_card_id,
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
    safe_card_id = _path_id(card_id, field_name="card_id")
    async with user_scoped_tx(pool, user.id) as conn:
        deleted = await RewardRepository(user.id, conn).delete_casebook(safe_card_id)
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
    offset: int = Query(0, ge=0, le=CASEBOOK_OFFSET_MAX),
):
    _validate_datetime_range(since, until)
    _validate_numeric_range(
        min_score,
        max_score,
        min_name="minScore",
        max_name="maxScore",
    )
    safe_basket = _optional_trimmed_text(
        basket,
        field_name="basket",
        max_length=REWARD_TEXT_FILTER_MAX_LENGTH,
    )
    safe_intent = _optional_trimmed_text(
        intent,
        field_name="intent",
        max_length=REWARD_TEXT_FILTER_MAX_LENGTH,
    )
    async with user_scoped_tx(pool, user.id) as conn:
        repo = RewardRepository(user.id, conn)
        total = await repo.count_casebook(
            label=label,
            min_score=min_score,
            max_score=max_score,
            basket=safe_basket,
            intent=safe_intent,
            min_evaluator_gap=min_evaluator_gap,
            since=since,
            until=until,
        )
        cases = await repo.list_casebook(
            label=label,
            min_score=min_score,
            max_score=max_score,
            basket=safe_basket,
            intent=safe_intent,
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
    safe_run_id = _path_id(run_id, field_name="run_id")
    data = _body_dict(body)
    force = _optional_bool(data.get("force"), field_name="force")
    try:
        async with user_scoped_tx(pool, user.id) as conn:
            repo = RewardRepository(user.id, conn)
            artifact = await TraceArtifactService(repo).get_or_generate(safe_run_id, force=force)
    except LookupError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    return {"ok": True, "trace": artifact}


@router.get("/runs/{run_id}/trace")
async def get_trace(
    run_id: str,
    user: User = Depends(current_user),
    pool=Depends(get_pool),
):
    safe_run_id = _path_id(run_id, field_name="run_id")
    async with user_scoped_tx(pool, user.id) as conn:
        repo = RewardRepository(user.id, conn)
        canonical_run_id = await repo.resolve_run_id(safe_run_id)
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


@router.get("/patterns")
async def list_patterns(
    user: User = Depends(current_user),
    pool=Depends(get_pool),
    category: str | None = Query(None, max_length=120),
    status: Literal["pending_review", "active", "retired"] | None = Query(None),
    surprise: Literal["h", "m", "l"] | None = Query(None),
    tier: Literal["cold_start_friendly", "warmup", "mature"] | None = Query(None),
    intent: str | None = Query(None, max_length=120),
    limit: int = Query(200, ge=1, le=500),
    offset: int = Query(0, ge=0, le=10_000),
):
    safe_category = _optional_trimmed_text(
        category,
        field_name="category",
        max_length=REWARD_TEXT_FILTER_MAX_LENGTH,
    )
    safe_intent = _optional_trimmed_text(
        intent,
        field_name="intent",
        max_length=REWARD_TEXT_FILTER_MAX_LENGTH,
    )
    async with user_scoped_tx(pool, user.id) as conn:
        repo = PatternsRepository(user.id, conn)
        total = await repo.count_patterns(
            category=safe_category,
            status=status,
            surprise=surprise,
            tier=tier,
            intent=safe_intent,
        )
        patterns = await repo.list_patterns(
            category=safe_category,
            status=status,
            surprise=surprise,
            tier=tier,
            intent=safe_intent,
            limit=limit,
            offset=offset,
        )
        facets = await repo.list_facets()
    return {
        "ok": True,
        "items": patterns,
        "total": total,
        "limit": limit,
        "offset": offset,
        "facets": facets,
    }


@router.get("/patterns/pending")
async def list_pending_patterns(
    user: User = Depends(current_user),
    pool=Depends(get_pool),
):
    async with user_scoped_tx(pool, user.id) as conn:
        repo = PatternsRepository(user.id, conn)
        items = await repo.list_patterns(status="pending_review", limit=500)
    return {"ok": True, "items": items}


@router.post("/patterns/extract")
async def trigger_pattern_extract(
    body: dict | None = None,
    user: User = Depends(current_user),
    pool=Depends(get_pool),
):
    """Reviewer-triggered run of the pattern extractor (Phase 6).

    The scheduler is meant to run this weekly; this manual surface lets
    a reviewer demo it on demand. Accepts optional `lookbackDays` /
    `minClusterSize` overrides for tuning during development.
    """
    data = _body_dict(body)
    lookback_days = data.get("lookbackDays") or data.get("lookback_days") or 7
    min_cluster_size = (
        data.get("minClusterSize") or data.get("min_cluster_size") or 3
    )
    if not isinstance(lookback_days, int) or not 1 <= lookback_days <= 60:
        raise HTTPException(
            status_code=422,
            detail="lookbackDays must be an int between 1 and 60",
        )
    if not isinstance(min_cluster_size, int) or not 2 <= min_cluster_size <= 100:
        raise HTTPException(
            status_code=422,
            detail="minClusterSize must be an int between 2 and 100",
        )
    async with user_scoped_tx(pool, user.id) as conn:
        summary = await run_pattern_extractor(
            conn,
            lookback_days=lookback_days,
            min_cluster_size=min_cluster_size,
        )
    return {"ok": True, **summary}


@router.post("/patterns/pending/{pattern_id}/approve")
async def approve_pending_pattern(
    pattern_id: str,
    user: User = Depends(current_user),
    pool=Depends(get_pool),
):
    safe_id = _path_id(pattern_id, field_name="pattern_id")
    async with user_scoped_tx(pool, user.id) as conn:
        repo = PatternsRepository(user.id, conn)
        existing = await repo.get_pattern(safe_id)
        if existing is None:
            raise HTTPException(status_code=404, detail="pattern not found")
        if existing["status"] != "pending_review":
            raise HTTPException(
                status_code=409,
                detail=f"pattern status is {existing['status']}; only pending_review can be approved",
            )
        updated = await repo.set_status(safe_id, "active")
    return {"ok": True, "pattern": updated}


@router.post("/patterns/pending/{pattern_id}/reject")
async def reject_pending_pattern(
    pattern_id: str,
    user: User = Depends(current_user),
    pool=Depends(get_pool),
):
    safe_id = _path_id(pattern_id, field_name="pattern_id")
    async with user_scoped_tx(pool, user.id) as conn:
        repo = PatternsRepository(user.id, conn)
        existing = await repo.get_pattern(safe_id)
        if existing is None:
            raise HTTPException(status_code=404, detail="pattern not found")
        if existing["status"] != "pending_review":
            raise HTTPException(
                status_code=409,
                detail=f"pattern status is {existing['status']}; only pending_review can be rejected",
            )
        await repo.delete_pattern(safe_id)
    return {"ok": True, "deleted": True}


@router.get("/patterns/health")
async def get_patterns_health(
    user: User = Depends(current_user),
    pool=Depends(get_pool),
):
    """Per-pattern health snapshot. Read-only — auto-retire side effects
    happen in `POST /patterns/health/run` (jobs / cron call that)."""
    async with user_scoped_tx(pool, user.id) as conn:
        rows = await compute_pattern_health(conn)
    return {"ok": True, "items": [r.to_wire() for r in rows]}


@router.post("/patterns/health/run")
async def run_patterns_health(
    user: User = Depends(current_user),
    pool=Depends(get_pool),
):
    """Reviewer-triggered run of the daily health + auto-retire job.

    Same routine the scheduler tick calls. Returns the summary so the
    dashboard can show how many patterns were updated / retired.
    """
    async with user_scoped_tx(pool, user.id) as conn:
        summary = await run_pattern_health_job(conn)
    return {"ok": True, **summary}


@router.get("/patterns/{pattern_id}")
async def get_pattern(
    pattern_id: str,
    user: User = Depends(current_user),
    pool=Depends(get_pool),
):
    safe_id = _path_id(pattern_id, field_name="pattern_id")
    async with user_scoped_tx(pool, user.id) as conn:
        repo = PatternsRepository(user.id, conn)
        pattern = await repo.get_pattern(safe_id)
        if pattern is None:
            raise HTTPException(status_code=404, detail="pattern not found")
        demos = await repo.list_demos_for_pattern(safe_id)
        recent_hits = await repo.list_recent_hits(safe_id, limit=25)
        health_row = await compute_pattern_health_one(conn, safe_id)
    return {
        "ok": True,
        "pattern": pattern,
        "demos": demos,
        "recentHits": recent_hits,
        "health": health_row.to_wire() if health_row else None,
    }


def _opt_json_list(value: Any, field_name: str) -> list[Any] | None:
    if value is None:
        return None
    if not isinstance(value, list):
        raise HTTPException(status_code=422, detail=f"{field_name} must be a list")
    return value


def _opt_json_obj(value: Any, field_name: str) -> dict[str, Any] | None:
    if value is None:
        return None
    if not isinstance(value, dict):
        raise HTTPException(status_code=422, detail=f"{field_name} must be an object")
    return value


@router.post("/patterns/{pattern_id}")
async def upsert_pattern(
    pattern_id: str,
    body: dict,
    user: User = Depends(current_user),
    pool=Depends(get_pool),
):
    safe_id = _path_id(pattern_id, field_name="pattern_id")
    data = _body_dict(body)
    abstract = _optional_trimmed_text(
        data.get("abstract"), field_name="abstract", max_length=2_000,
    )
    category = _optional_trimmed_text(
        data.get("category"), field_name="category", max_length=120,
    )
    intent = _optional_trimmed_text(
        data.get("intent"), field_name="intent", max_length=120,
    )
    tier = _optional_trimmed_text(
        data.get("tier"), field_name="tier", max_length=40,
    )
    surprise_init = _optional_trimmed_text(
        data.get("surpriseInit") or data.get("surprise_init"),
        field_name="surpriseInit", max_length=2,
    )
    practical_init = _optional_trimmed_text(
        data.get("practicalInit") or data.get("practical_init"),
        field_name="practicalInit", max_length=2,
    )
    signals_required = _opt_json_list(
        data.get("signalsRequired") or data.get("signals_required"),
        "signalsRequired",
    )
    trigger_dsl = _opt_json_list(
        data.get("triggerDsl") or data.get("trigger_dsl"), "triggerDsl",
    )
    card_skeleton = _opt_json_obj(
        data.get("cardSkeleton") or data.get("card_skeleton"), "cardSkeleton",
    )
    specializations = _opt_json_list(data.get("specializations"), "specializations")
    try:
        async with user_scoped_tx(pool, user.id) as conn:
            repo = PatternsRepository(user.id, conn)
            updated = await repo.update_pattern(
                safe_id,
                abstract=abstract,
                category=category,
                intent=intent,
                tier=tier,
                surprise_init=surprise_init,
                practical_init=practical_init,
                signals_required=signals_required,
                trigger_dsl=trigger_dsl,
                card_skeleton=card_skeleton,
                specializations=specializations,
            )
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    if updated is None:
        raise HTTPException(status_code=404, detail="pattern not found")
    return {"ok": True, "pattern": updated}


@router.post("/patterns/{pattern_id}/status")
async def set_pattern_status(
    pattern_id: str,
    body: dict,
    user: User = Depends(current_user),
    pool=Depends(get_pool),
):
    safe_id = _path_id(pattern_id, field_name="pattern_id")
    data = _body_dict(body)
    status_value = data.get("status")
    if not isinstance(status_value, str) or not status_value.strip():
        raise HTTPException(status_code=422, detail="status required")
    try:
        async with user_scoped_tx(pool, user.id) as conn:
            updated = await PatternsRepository(user.id, conn).set_status(
                safe_id, status_value.strip(),
            )
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    if updated is None:
        raise HTTPException(status_code=404, detail="pattern not found")
    return {"ok": True, "pattern": updated}


@router.post("/patterns/{pattern_id}/demos")
async def add_pattern_demo(
    pattern_id: str,
    body: dict,
    user: User = Depends(current_user),
    pool=Depends(get_pool),
):
    safe_id = _path_id(pattern_id, field_name="pattern_id")
    data = _body_dict(body)
    card_id = _optional_path_id(data.get("cardId") or data.get("card_id"), field_name="cardId")
    source = data.get("source") or "golden"
    if source not in {"golden", "anti", "seed"}:
        raise HTTPException(status_code=422, detail="source must be golden|anti|seed")
    redacted = _optional_bool(data.get("redacted"), field_name="redacted", default=True)
    scenario = _optional_trimmed_text(
        data.get("scenario"), field_name="scenario", max_length=1_000,
    ) or ""
    why_surprise = _optional_trimmed_text(
        data.get("whySurprise") or data.get("why_surprise"),
        field_name="whySurprise", max_length=500,
    )
    why_practical = _optional_trimmed_text(
        data.get("whyPractical") or data.get("why_practical"),
        field_name="whyPractical", max_length=500,
    )
    wow_level = data.get("wowLevel") or data.get("wow_level")
    if wow_level is not None and not (isinstance(wow_level, int) and 1 <= wow_level <= 5):
        raise HTTPException(status_code=422, detail="wowLevel must be int 1..5")
    subtype = _optional_trimmed_text(
        data.get("subtype"), field_name="subtype", max_length=120,
    )
    raw_card = data.get("card") if isinstance(data.get("card"), dict) else None
    signals_used = _opt_json_list(
        data.get("signalsUsed") or data.get("signals_used"), "signalsUsed",
    )

    try:
        async with user_scoped_tx(pool, user.id) as conn:
            repo = PatternsRepository(user.id, conn)
            pattern = await repo.get_pattern(safe_id)
            if pattern is None:
                raise HTTPException(status_code=404, detail="pattern not found")
            card_snapshot: dict[str, Any]
            if raw_card:
                card_snapshot = raw_card
            elif card_id:
                reward_repo = RewardRepository(user.id, conn)
                detail = await reward_repo.get_card_detail(card_id)
                if detail is None:
                    raise HTTPException(status_code=404, detail="card not found")
                card_snapshot = (
                    detail.get("card")
                    if isinstance(detail.get("card"), dict) else {}
                )
                if not card_snapshot:
                    raise HTTPException(status_code=404, detail="card body missing")
            else:
                raise HTTPException(status_code=422, detail="card or cardId required")
            demo = await repo.insert_demo_from_card(
                safe_id,
                card=card_snapshot, subtype=subtype, scenario=scenario,
                signals_used=signals_used, why_surprise=why_surprise,
                why_practical=why_practical, wow_level=wow_level,
                source=source, source_card_id=card_id, redacted=redacted,
            )
    except HTTPException:
        raise
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    return {"ok": True, "demo": demo}


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
    _validate_datetime_range(since, until)
    async with user_scoped_tx(pool, user.id) as conn:
        return await PersonalDataSnapshotService(conn, user.id).snapshot(
            category=category,
            since=since,
            until=until,
            query=q.strip() if isinstance(q, str) and q.strip() else None,
            limit=limit,
            offset=offset,
        )
