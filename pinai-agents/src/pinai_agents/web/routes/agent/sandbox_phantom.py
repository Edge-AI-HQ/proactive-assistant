"""/api/agent/sandbox/phantom/{mint,revoke} — chat → web phantom token API.

Trust boundary:
  Chat process (no DB creds, no signing key) calls these endpoints with
  its chat-driving JWT (carries `vk`). Web mints / revokes phantoms in
  its own service-role DB session, returns the raw token. Chat injects
  the raw token into the Daytona sandbox env at create time.

Why a chat-only dep (`current_chat_principal`):
  If `current_agent_run` were used here, a phantom-bearing call could
  mint a fresh phantom — privilege escalation. `current_chat_principal`
  rejects phantoms outright AND requires `vk`, so only legitimate
  chat-driving JWTs reach this surface.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException, status
from pydantic import BaseModel, Field

from ...auth.deps import ChatPrincipal, current_chat_principal, get_pool
from ...db.repositories.sandbox_phantom_tokens import (
    DEFAULT_PHANTOM_TTL_SECONDS,
    bind_sandbox,
    mint,
    revoke_by_sandbox,
    revoke_by_token,
)
from ...db.rls import service_tx

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/agent/sandbox/phantom", tags=["sandbox-phantom"])


class MintRequest(BaseModel):
    # Free-form correlation label. Chat process passes the session_key
    # (e.g. "card-thread-abc", "gen-run_xxx", or "oneshot-uuid") so audit
    # rows downstream can attribute the action back to a chat thread.
    scope_label: str | None = Field(default=None, max_length=200)
    # Override TTL in seconds. Default 24h (matches sandbox auto_delete).
    # Cap at 24h on the server — even if a caller asks for longer, we
    # refuse: phantom outliving sandbox is the orphan anti-pattern.
    ttl_seconds: int | None = Field(default=None, ge=60, le=DEFAULT_PHANTOM_TTL_SECONDS)


class MintResponse(BaseModel):
    token: str
    token_hash: str  # for chat-side correlation/logging only — not auth
    ttl_seconds: int


class BindRequest(BaseModel):
    token_hash: str = Field(min_length=64, max_length=64)
    sandbox_id: str = Field(min_length=1, max_length=200)


@router.post("/mint", response_model=MintResponse)
async def mint_phantom(
    body: MintRequest = Body(default_factory=MintRequest),
    principal: ChatPrincipal = Depends(current_chat_principal),
    pool=Depends(get_pool),
) -> MintResponse:
    """Mint a fresh phantom for the authenticated user.

    Returns the raw token EXACTLY ONCE. Caller (chat process) is
    responsible for ferrying it into the Daytona sandbox env. We never
    log the raw value; the response body is the only place it appears
    server-side, and the DB stores only the SHA-256 hash.
    """
    if pool is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="DB pool not initialized",
        )
    ttl = body.ttl_seconds or DEFAULT_PHANTOM_TTL_SECONDS
    async with service_tx(pool) as conn:
        raw, token_hash = await mint(
            conn,
            user_id=principal.user_id,
            scope_label=body.scope_label,
            ttl_seconds=ttl,
        )
    logger.info(
        "phantom minted user=%d scope=%s hash_prefix=%s ttl=%ds",
        principal.user_id,
        body.scope_label or "-",
        token_hash[:8],
        ttl,
    )
    return MintResponse(token=raw, token_hash=token_hash, ttl_seconds=ttl)


@router.post("/bind", status_code=status.HTTP_204_NO_CONTENT)
async def bind_phantom(
    body: BindRequest,
    principal: ChatPrincipal = Depends(current_chat_principal),
    pool=Depends(get_pool),
) -> None:
    """Attach a Daytona sandbox id to a previously-minted phantom.

    Two-step (mint → create sandbox → bind) is forced by Daytona: env
    vars are fixed at sandbox-create time, but we don't get a sandbox
    id until create returns. Bind closes the loop so revoke-by-sandbox
    has something to look up later.
    """
    if pool is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="DB pool not initialized",
        )
    async with service_tx(pool) as conn:
        await bind_sandbox(
            conn,
            token_hash=body.token_hash,
            sandbox_id=body.sandbox_id,
        )
    # No body — purely a metadata write.


class RevokeRequest(BaseModel):
    # Chat may revoke by raw token (it kept the value from /mint) OR by
    # sandbox id (e.g. background sweep on shutdown when chat doesn't
    # have the raw value any more). Exactly one must be supplied.
    token: str | None = None
    sandbox_id: str | None = Field(default=None, min_length=1, max_length=200)
    reason: str | None = Field(default=None, max_length=200)


@router.post("/revoke", status_code=status.HTTP_200_OK)
async def revoke_phantom(
    body: RevokeRequest,
    principal: ChatPrincipal = Depends(current_chat_principal),
    pool=Depends(get_pool),
) -> dict[str, Any]:
    """Revoke phantoms — by raw token OR by sandbox id.

    Idempotent: revoking an already-revoked phantom is a no-op (returns
    `{"revoked": 0}`). Always 200 so callers don't have to disambiguate
    "row missing" vs "already revoked".
    """
    if pool is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="DB pool not initialized",
        )
    if (body.token is None) == (body.sandbox_id is None):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="exactly one of {token, sandbox_id} required",
        )
    async with service_tx(pool) as conn:
        if body.token is not None:
            ok = await revoke_by_token(
                conn,
                raw_token=body.token,
                reason=body.reason,
            )
            count = 1 if ok else 0
        else:
            assert body.sandbox_id is not None  # narrowed by xor above
            count = await revoke_by_sandbox(
                conn,
                sandbox_id=body.sandbox_id,
                user_id=principal.user_id,
                reason=body.reason,
            )
    logger.info(
        "phantom revoked user=%d count=%d reason=%s",
        principal.user_id,
        count,
        body.reason or "-",
    )
    return {"revoked": count}
