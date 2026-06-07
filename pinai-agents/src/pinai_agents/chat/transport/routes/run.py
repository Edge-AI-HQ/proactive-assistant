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

from ...agents.crystallize import run_crystallize
from ...agents.dream import run_dream
from ...agents.evolve import run_evolve
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
    summary = await run_dream(
        virtual_key=virtual_key,
        user_id=user_id,
        run_id=run_id,
        run_jwt=run_jwt,
        model=body.get("model"),
    )
    return summary


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
        virtual_key=virtual_key,
        user_id=user_id,
        run_id=run_id,
        run_jwt=run_jwt,
        connector=body.get("connector", "unknown"),
        model=body.get("model"),
    )
    return summary


@router.post("/agent/run/crystallize", status_code=status.HTTP_200_OK)
async def post_run_crystallize(
    body: dict = Body(...),
    authorization: str | None = Header(default=None),
):
    """Distill one chat session into memories + skill triggers.

    Triggered by web's scheduler dispatcher when a `crystallize` task
    fires (was previously fired inline from the chat worker on session
    timeout — moved to scheduler so the run is observable + retryable
    + survives chat-worker restart, same lifecycle as dream/evolve).
    """
    user_id, run_id, _ = _verify(authorization)
    if user_id != body.get("user_id"):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "user_id mismatch")
    virtual_key = body.get("virtual_key", "")
    if not virtual_key:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "virtual_key required")
    session_key = body.get("session_key") or ""
    if not session_key:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "session_key required")
    summary = await run_crystallize(
        virtual_key=virtual_key,
        user_id=user_id,
        run_id=run_id,
        session_key=session_key,
        model=body.get("model"),
    )
    return summary
