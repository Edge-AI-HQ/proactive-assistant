"""POST /agent/generate — unified-generator endpoint.

The user's LiteLLM virtual_key arrives in the JWT claim (vk), not the
request body — same trust pattern as /agent/chat. Wire response shape
mirrors the existing TS contract so the web→chat proxy can pass it
through unchanged.
"""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from datetime import UTC, datetime
from typing import Any
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Header, HTTPException, status
from pydantic import BaseModel, Field, StrictInt

from agent_engine.config import get_chat_settings

from ...agents.generator import derive_source_apps, run_generator
from ...auth.run_jwt import RunJWTError, RunPrincipal, verify_run_jwt

logger = logging.getLogger(__name__)
router = APIRouter()


class GenerateRequest(BaseModel):
    cards_to_generate: StrictInt = Field(default=8, ge=1, le=8)
    output_language: str = Field(default="en")
    # Optional: caller-supplied run id. Web's scheduler dispatcher passes
    # the task.id here so pai_scheduled_tasks → pai_pipeline_runs share
    # one stable id. Sync /api/generate callers omit this and accept the
    # default-generated run_<uuid>.
    run_id: str | None = Field(default=None, max_length=64)
    # Optional user-requested topic for chat-triggered generation. When set,
    # the planner biases candidates toward this focus (still grounding-strict).
    # Omitted by the home "Generate" button / auto-fires → normal batch.
    focus: str | None = Field(default=None, max_length=400)
    # Web-side pattern matcher output. Chat receives this read-only so it
    # never has to query the pattern DB (trust boundary).
    matched_patterns: list[dict[str, Any]] = Field(default_factory=list)
    context_since: datetime | None = Field(default=None)
    context_until: datetime | None = Field(default=None)
    generation_request: dict[str, Any] | None = Field(default=None)
    # User's IANA timezone (profile truth, web-resolved — chat has no DB).
    # "Today is …" in the generator prompt is computed in THIS timezone:
    # with bare UTC an Asia/Shanghai user generating between local
    # 00:00-07:59 gets yesterday's date and date-sensitive cards drift.
    timezone: str | None = Field(default=None, max_length=64)


class GenerateResponse(BaseModel):
    run_id: str
    status: str
    duration_ms: int
    reasoning: str | None = None
    cards: list[dict[str, Any]]
    evaluations: list[dict[str, Any]]
    batch_feedback: str | None = None


_INFRA_ERROR_CARD_MARKERS = (
    "_error=",
    "connecterror",
    "name or service not known",
    "no-grounded-source-fallback",
    "system-error tombstone",
    "should never reach the user-facing pipeline",
    "数据源暂时无法连接",
    "无法生成个性化卡片",
)

_DUPLICATE_REJECTION_MARKERS = (
    "duplicate",
    "near-duplicate",
    "near duplicate",
    "novelty is critically low",
    "novelty is severely penalized",
    "重复",
    "近重复",
)


def _is_infra_error_card(card: dict[str, Any], evaluation: dict[str, Any] | None) -> bool:
    sources = card.get("sources")
    source_text = " ".join(str(item) for item in sources) if isinstance(sources, list) else ""
    text = " ".join(
        str(value)
        for value in (
            card.get("intentKey"),
            card.get("title"),
            card.get("whyNow"),
            card.get("summary"),
            source_text,
            (evaluation or {}).get("feedback"),
        )
        if value
    ).lower()
    return any(marker in text for marker in _INFRA_ERROR_CARD_MARKERS)


def _is_duplicate_rejection(evaluation: dict[str, Any] | None) -> bool:
    if not evaluation or evaluation.get("pass") is True:
        return False
    feedback = str(evaluation.get("feedback") or "").lower()
    return any(marker in feedback for marker in _DUPLICATE_REJECTION_MARKERS)


def _serialize_passing_cards(
    parsed,
    *,
    run_id: str,
    max_cards: int,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Serialize generator output and select cards for the web response.

    Passing evaluator rows win. If the evaluator fails every candidate,
    keep the highest-scored candidate instead of turning the whole
    user-facing generation into a 502; the failed evaluation remains
    attached for audit.
    """
    raw_cards: list[dict[str, Any]] = [c.model_dump(by_alias=True) for c in parsed.cards]
    if not raw_cards:
        raise ValueError("generator returned no cards")
    evals: list[dict[str, Any]] = [e.model_dump(by_alias=True) for e in parsed.evaluations]
    eval_by_intent = {
        str(ev.get("intentKey")): ev for ev in evals if isinstance(ev.get("intentKey"), str)
    }
    passing_intents = {
        str(ev.get("intentKey")) for ev in evals if ev.get("pass") is True and ev.get("intentKey")
    }
    cards = [
        card
        for card in raw_cards
        if str(card.get("intentKey")) in passing_intents
        and not _is_infra_error_card(card, eval_by_intent.get(str(card.get("intentKey"))))
    ]
    if cards and len(cards) < max_cards:
        selected_intents = {str(card.get("intentKey")) for card in cards}
        fill_candidates = [
            card
            for card in raw_cards
            if str(card.get("intentKey")) not in selected_intents
            and not _is_infra_error_card(card, eval_by_intent.get(str(card.get("intentKey"))))
            and not _is_duplicate_rejection(eval_by_intent.get(str(card.get("intentKey"))))
            and float(eval_by_intent.get(str(card.get("intentKey")), {}).get("overall") or -1) >= 5
        ]
        cards.extend(
            sorted(
                fill_candidates,
                key=lambda card: float(
                    eval_by_intent.get(str(card.get("intentKey")), {}).get("overall") or -1
                ),
                reverse=True,
            )[: max_cards - len(cards)]
        )
    if not cards:
        fallback_cards = [
            card
            for card in raw_cards
            if not _is_infra_error_card(card, eval_by_intent.get(str(card.get("intentKey"))))
        ]
        if not fallback_cards:
            raise ValueError("generator returned only infrastructure-error cards")
        cards = sorted(
            fallback_cards,
            key=lambda card: float(
                eval_by_intent.get(str(card.get("intentKey")), {}).get("overall") or -1
            ),
            reverse=True,
        )[:1]
        logger.warning(
            "generator returned no passing cards run=%s candidates=%d; keeping best-scored candidate",
            run_id,
            len(raw_cards),
        )
    cards = cards[:max_cards]
    for i, card in enumerate(cards):
        card["id"] = f"{run_id}_card_{i:02d}"
        card["sourceApps"] = derive_source_apps(card.get("sources") or [])
    intent_to_id = {c["intentKey"]: c["id"] for c in cards}
    for ev in evals:
        ev["cardId"] = intent_to_id.get(ev["intentKey"])
    return cards, evals


def _extract_bearer(authorization: str | None) -> str:
    """Pull the raw token from Authorization. Raises 401 on missing/bad
    shape. We need the raw token (not just RunPrincipal) because it's
    forwarded to the Daytona sandbox as `PAI_RUN_JWT` so pinai_sdk can
    re-auth into web /api/agent/*."""
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authorization: Bearer <token> required",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return authorization[len("bearer ") :].strip()


def _verify_principal(token: str) -> RunPrincipal:
    """Token → RunPrincipal. 401 on bad token; 400 if `vk` is missing
    (chat-driving tokens always carry it; sandbox-only tokens skip vk
    and shouldn't reach this route)."""
    try:
        principal = verify_run_jwt(token)
    except RunJWTError as e:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"invalid run JWT: {e}",
            headers={"WWW-Authenticate": "Bearer"},
        ) from e
    if not principal.virtual_key:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="run JWT missing `vk` claim",
        )
    return principal


def _local_date(moment: datetime, tz_name: str | None) -> str:
    """The user-local calendar date for the generator's "Today is …" prompt.
    Invalid/absent timezone falls back to UTC (the old behavior)."""
    try:
        tz = ZoneInfo(tz_name) if tz_name else UTC
    except Exception:
        tz = UTC
    return moment.astimezone(tz).strftime("%Y-%m-%d")


@router.post("/agent/generate", response_model=GenerateResponse)
async def generate(
    req: GenerateRequest,
    authorization: str | None = Header(default=None),
) -> GenerateResponse:
    raw_jwt = _extract_bearer(authorization)
    principal = _verify_principal(raw_jwt)
    # Caller-supplied run_id wins (scheduler dispatch path); else mint
    # a fresh one (legacy sync /api/generate path).
    run_id = req.run_id or f"run_{uuid.uuid4().hex[:16]}"
    context_until = req.context_until or datetime.now(UTC)
    current_date = _local_date(context_until, req.timezone)
    t0 = time.perf_counter()
    # Guarded by _verify_principal — virtual_key is non-None here.
    virtual_key = principal.virtual_key
    assert virtual_key is not None
    timeout_seconds = get_chat_settings().generate_timeout_seconds
    try:
        async with asyncio.timeout(timeout_seconds):
            parsed = await run_generator(
                virtual_key=virtual_key,
                current_date=current_date,
                user_id=principal.user_id,
                run_id=run_id,
                run_jwt=raw_jwt,
                cards_to_generate=req.cards_to_generate,
                output_language=req.output_language,
                focus=req.focus,
                matched_patterns=req.matched_patterns,
                context_since=req.context_since,
                context_until=context_until,
                generation_request=req.generation_request,
            )
    except TimeoutError as e:
        logger.warning(
            "generator timed out run_id=%s after %ss",
            run_id,
            int(timeout_seconds),
        )
        raise HTTPException(
            status_code=status.HTTP_504_GATEWAY_TIMEOUT,
            detail=f"generator timed out after {int(timeout_seconds)}s",
        ) from e
    except ValueError as e:
        # Bad output shape from the model — distinct from infra failure.
        logger.warning("generator shape error run_id=%s: %s", run_id, e)
        raise HTTPException(status_code=502, detail=f"generator shape error: {e}") from e
    except Exception as e:
        logger.exception("generator infra failure run_id=%s", run_id)
        raise HTTPException(status_code=500, detail=f"{type(e).__name__}: {e}") from e

    duration_ms = int((time.perf_counter() - t0) * 1000)
    # Convert each card / evaluation to dict, filter out evaluator-failed
    # cards, then assign run-scoped ids so downstream selection / evaluation
    # joins are stable. We dump with by_alias=True so `pass_` round-trips
    # back as `pass` on the wire.
    try:
        cards, evals = _serialize_passing_cards(
            parsed, run_id=run_id, max_cards=req.cards_to_generate
        )
    except ValueError as e:
        logger.warning("generator shape error run_id=%s: %s", run_id, e)
        raise HTTPException(status_code=502, detail=f"generator shape error: {e}") from e
    # Stamp scheduled-generator provenance onto each card so the UI can show a
    # lightweight "Scheduled · <label>" marker. Source comes from the
    # dispatcher's generation_request (absent on manual / auto runs); cards are
    # plain dicts here, so this rides through final_cards JSONB to the frontend.
    gen_req = req.generation_request or {}
    source_kind = gen_req.get("source_kind")
    source_label = gen_req.get("source_label")
    if source_kind:
        for card in cards:
            card.setdefault("sourceKind", source_kind)
            if source_label:
                card.setdefault("sourceLabel", source_label)
    logger.info(
        "generator ok run_id=%s duration=%dms cards=%d evals=%d",
        run_id,
        duration_ms,
        len(cards),
        len(evals),
    )
    return GenerateResponse(
        run_id=run_id,
        status="completed",
        duration_ms=duration_ms,
        reasoning=parsed.reasoning,
        cards=cards,
        evaluations=evals,
        batch_feedback=parsed.batch_feedback,
    )
