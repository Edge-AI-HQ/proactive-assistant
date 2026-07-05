"""POST /agent/run/{kind} — chat worker entry for scheduler-dispatched runs.

Web's scheduler dispatcher signs an EdDSA JWT and POSTs here for
auto.dreaming / connector.evolve / etc. — no SSE response, just a
JSON summary of the run.

Returns 202 Accepted + run summary. Failures bubble up as 500;
dispatcher catches and persists 'failed' status.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Body, Header, HTTPException, status

from ...agents.evolve import (
    TRIGGER_DAILY,
    TRIGGER_ON_EVENT,
    run_evolve,
)
from ...agents.rollup_semantic import run_rollup_semantic
from ...auth.run_jwt import RunJWTError, verify_run_jwt

logger = logging.getLogger(__name__)
router = APIRouter()


def _verify(authorization: str | None) -> tuple[int, str, str]:
    """Returns (user_id, run_id, raw_token). The raw token is needed
    downstream — sandbox.create_oneshot_sandbox uses it to mint a phantom
    token via web's /api/agent/sandbox/phantom/mint, which is the only
    auth the sandbox-side SDK has back to web. Without forwarding the
    JWT, SDK calls 401."""
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "missing bearer")
    token = authorization[len("bearer ") :].strip()
    try:
        p = verify_run_jwt(token)
    except RunJWTError as e:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, f"bad jwt: {e}") from e
    return p.user_id, p.run_id, token


@router.post("/agent/run/dream", status_code=status.HTTP_200_OK)
async def post_run_dream(
    body: dict = Body(...),
    authorization: str | None = Header(default=None),
):
    user_id, run_id, run_jwt = _verify(authorization)
    if user_id != body.get("user_id"):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "user_id mismatch")
    virtual_key = body.get("virtual_key", "")
    if not virtual_key:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "virtual_key required")
    output_language = str(body.get("generation_language") or "en")
    model = body.get("model")
    # Daily sweep order matters (rollup R5): rollup_semantic FIRST — it rolls the
    # 24h ambient firehose into episode events in L1. THEN evolve — it curates +
    # distils, now seeing those episodes. Reversed, evolve would miss the day's
    # firehose (episodes not yet written).
    rollup_summary = await run_rollup_semantic(
        virtual_key=virtual_key,
        user_id=user_id,
        run_id=run_id,
        run_jwt=run_jwt,
        model=model,
        output_language=output_language,
    )
    evolve_summary = await run_evolve(
        trigger_kind=TRIGGER_DAILY,
        virtual_key=virtual_key,
        user_id=user_id,
        run_id=run_id,
        run_jwt=run_jwt,
        model=model,
        output_language=output_language,
    )
    return {"rollup_semantic": rollup_summary, "evolve": evolve_summary}


@router.post("/agent/run/evolve", status_code=status.HTTP_200_OK)
async def post_run_evolve(
    body: dict = Body(...),
    authorization: str | None = Header(default=None),
):
    user_id, run_id, run_jwt = _verify(authorization)
    if user_id != body.get("user_id"):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "user_id mismatch")
    virtual_key = body.get("virtual_key", "")
    if not virtual_key:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "virtual_key required")
    summary = await run_evolve(
        trigger_kind=TRIGGER_ON_EVENT,
        virtual_key=virtual_key,
        user_id=user_id,
        run_id=run_id,
        run_jwt=run_jwt,
        connector=body.get("connector", "unknown"),
        raw_sources=body.get("raw_sources"),
        model=body.get("model"),
        output_language=str(body.get("generation_language") or "en"),
    )
    return summary


# (the /agent/run/crystallize endpoint is gone — crystallize / chat_burst
# distillation was deleted, design §八: single-session distillation was two-sided
# dead, covered by the hot path + daily evolve. The web dispatcher no longer
# routes a crystallize task here.)
