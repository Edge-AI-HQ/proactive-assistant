"""POST /agent/generate — unified-generator endpoint.

Step 1.5 stub. Frontend currently posts to `/api/proxy/generate` which APIs
forwards to OpenClaw; Step 1.7 swaps the APIs target to this endpoint.
The wire response shape mirrors the existing TS contract so APIs / frontend
need no changes once routing flips:

    { runId, status: "completed", cards, evaluations, batchFeedback, reasoning }
"""

from __future__ import annotations

import logging
import time
import uuid
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ..agents.generator import run_generator

logger = logging.getLogger(__name__)
router = APIRouter()


class GenerateRequest(BaseModel):
    virtual_key: str = Field(min_length=8)
    cards_to_generate: int = Field(default=4, ge=1, le=10)
    output_language: str = Field(default="en")
    model: str | None = None


class GenerateResponse(BaseModel):
    run_id: str
    status: str
    duration_ms: int
    reasoning: str | None = None
    cards: list[dict[str, Any]]
    evaluations: list[dict[str, Any]]
    batch_feedback: str | None = None


@router.post("/agent/generate", response_model=GenerateResponse)
async def generate(req: GenerateRequest) -> GenerateResponse:
    run_id = f"run_{uuid.uuid4().hex[:16]}"
    current_date = datetime.now(UTC).strftime("%Y-%m-%d")
    t0 = time.perf_counter()
    try:
        parsed = await run_generator(
            virtual_key=req.virtual_key,
            current_date=current_date,
            cards_to_generate=req.cards_to_generate,
            output_language=req.output_language,
            model=req.model,
        )
    except ValueError as e:
        # Bad output shape from the model — distinct from infra failure.
        logger.warning("generator shape error run_id=%s: %s", run_id, e)
        raise HTTPException(status_code=502, detail=f"generator shape error: {e}") from e
    except Exception as e:
        logger.exception("generator infra failure run_id=%s", run_id)
        raise HTTPException(status_code=500, detail=f"{type(e).__name__}: {e}") from e

    duration_ms = int((time.perf_counter() - t0) * 1000)
    cards = parsed.get("cards") or []
    # Re-id cards with run-scoped ids so downstream selection / evaluation
    # joins are stable. Mirrors TS `seedGeneratedCardsFromFinalCards`.
    for i, card in enumerate(cards):
        card["id"] = f"{run_id}_card_{i:02d}"
    # If the model emitted evaluation cardId placeholders ("matches card id"),
    # re-link them positionally to the freshly-stamped card ids.
    evals = parsed.get("evaluations") or []
    for i, ev in enumerate(evals):
        if i < len(cards) and isinstance(ev, dict):
            ev["cardId"] = cards[i]["id"]
    logger.info(
        "generator ok run_id=%s duration=%dms cards=%d",
        run_id, duration_ms, len(cards),
    )
    return GenerateResponse(
        run_id=run_id,
        status="completed",
        duration_ms=duration_ms,
        reasoning=parsed.get("reasoning"),
        cards=cards,
        evaluations=evals,
        batch_feedback=parsed.get("batchFeedback"),
    )
