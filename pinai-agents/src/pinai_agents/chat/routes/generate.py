"""POST /agent/generate — unified-generator endpoint.

The user's LiteLLM virtual_key arrives in the JWT claim (vk), not the
request body — same trust pattern as /agent/chat. Wire response shape
mirrors the existing TS contract so the web→chat proxy can pass it
through unchanged.
"""

from __future__ import annotations

import logging
import time
import uuid
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Header, HTTPException, status
from pydantic import BaseModel, Field, StrictInt

from ..agents.generator import run_generator
from ..auth.run_jwt import RunJWTError, RunPrincipal, verify_run_jwt

logger = logging.getLogger(__name__)
router = APIRouter()


class GenerateRequest(BaseModel):
    cards_to_generate: StrictInt = Field(default=8, ge=1, le=10)
    output_language: str = Field(default="en")
    # Optional: caller-supplied run id. Web's scheduler dispatcher passes
    # the task.id here so pai_scheduled_tasks → pai_pipeline_runs share
    # one stable id. Sync /api/generate callers omit this and accept the
    # default-generated run_<uuid>.
    run_id: str | None = Field(default=None, max_length=64)


class GenerateResponse(BaseModel):
    run_id: str
    status: str
    duration_ms: int
    reasoning: str | None = None
    cards: list[dict[str, Any]]
    evaluations: list[dict[str, Any]]
    batch_feedback: str | None = None


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
    return authorization[len("bearer "):].strip()


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
    current_date = datetime.now(UTC).strftime("%Y-%m-%d")
    t0 = time.perf_counter()
    # Guarded by _verify_principal — virtual_key is non-None here.
    virtual_key = principal.virtual_key
    assert virtual_key is not None
    try:
        parsed = await run_generator(
            virtual_key=virtual_key,
            current_date=current_date,
            user_id=principal.user_id,
            run_id=run_id,
            run_jwt=raw_jwt,
            cards_to_generate=req.cards_to_generate,
            output_language=req.output_language,
        )
    except ValueError as e:
        # Bad output shape from the model — distinct from infra failure.
        logger.warning("generator shape error run_id=%s: %s", run_id, e)
        raise HTTPException(status_code=502, detail=f"generator shape error: {e}") from e
    except Exception as e:
        logger.exception("generator infra failure run_id=%s", run_id)
        raise HTTPException(status_code=500, detail=f"{type(e).__name__}: {e}") from e

    duration_ms = int((time.perf_counter() - t0) * 1000)
    # parsed is a validated GeneratorOutput (Pydantic). Convert each
    # card / evaluation to dict + assign run-scoped ids so downstream
    # selection / evaluation joins are stable. We dump with by_alias=True
    # so `pass_` round-trips back as `pass` on the wire.
    cards: list[dict[str, Any]] = [c.model_dump(by_alias=True) for c in parsed.cards]
    for i, card in enumerate(cards):
        card["id"] = f"{run_id}_card_{i:02d}"
    evals: list[dict[str, Any]] = [e.model_dump(by_alias=True) for e in parsed.evaluations]
    # Map evaluations to their cards by intentKey, then attach the
    # run-scoped card id. This is more robust than positional indexing
    # because the orchestrator may emit evaluations for cards it dropped
    # (audit trail), so list lengths can differ. Keys are camelCase
    # because by_alias=True respects the alias_generator.
    intent_to_id = {c["intentKey"]: c["id"] for c in cards}
    for ev in evals:
        ev["cardId"] = intent_to_id.get(ev["intentKey"])
    logger.info(
        "generator ok run_id=%s duration=%dms cards=%d evals=%d",
        run_id, duration_ms, len(cards), len(evals),
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
