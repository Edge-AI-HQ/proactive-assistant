"""FastAPI dependency factories for auth principals.

Three principal types map to three deps:

  * `current_user`            — frontend Supabase JWT → User (BIGINT id)
  * `current_agent_run`       — agent HS256 JWT → AgentRun (user_id + run_id)
  * `pool` (utility)          — extracts the live pg pool from app.state

The deps DO NOT enforce app.user_id RLS — that's the route's job to
construct a Repository inside `user_scoped_tx`. Putting RLS in the dep
would over-eagerly hold a connection across the whole request.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

from fastapi import Depends, Header, HTTPException, Request, status
from psycopg_pool import AsyncConnectionPool

from .agent_jwt import AgentJWTError, verify_agent_run_jwt
from .supabase_jwt import JWTVerifyError, verify_supabase_jwt
from .user_service import User, upsert_user_by_supabase_id

logger = logging.getLogger(__name__)


@dataclass(slots=True)
class AgentRun:
    user_id: int
    run_id: str
    scope: str
    # Impersonation provenance. 'user' = the account owner drives this run.
    # 'internal_operator' = an internal reviewer acting on the user's behalf;
    # routes use this (not agent-reported body) to stamp write `source`.
    actor: str = "user"
    operator_id: str | None = None


@dataclass(slots=True)
class ChatPrincipal:
    """Stricter version of AgentRun for endpoints that mint sandbox
    credentials. Only minted from a JWT carrying `vk` (the LiteLLM virtual
    key claim) — phantom tokens are rejected, so a compromised sandbox
    cannot escalate by minting itself fresh credentials."""

    user_id: int
    run_id: str
    virtual_key: str
    jti: str


def _extract_bearer(authorization: str | None) -> str:
    """Pull `<token>` out of `Authorization: Bearer <token>`. Raises 401 on miss."""
    if not authorization:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authorization header missing",
            headers={"WWW-Authenticate": "Bearer"},
        )
    parts = authorization.strip().split(None, 1)
    if len(parts) != 2 or parts[0].lower() != "bearer":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authorization header must be `Bearer <token>`",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return parts[1]


def get_pool(request: Request) -> AsyncConnectionPool:
    """Extract the lifespan-managed pool. 503 if DB never opened."""
    pool: AsyncConnectionPool | None = getattr(request.app.state, "pool", None)
    if pool is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="DB pool not initialized — check DATABASE_URL",
        )
    return pool


# Dev-only short-circuit. Active ONLY when DEPLOY_ENV=dev AND the request
# carries an opaque marker header. Lets the internal-reward-dashboard be
# verified end-to-end in a local browser without Supabase OAuth round-trips.
# The marker is a fixed string rather than a secret because:
#   * the bypass only fires under DEPLOY_ENV=dev, never on prod/test/fly
#   * the dev compose Postgres is local-only and not exposed
# In any non-dev environment the header is ignored entirely.
_DEV_AUTH_BYPASS_HEADER_VALUE = "pinai-dev-reviewer"
_DEV_AUTH_BYPASS_EMAIL = "dev-reviewer@local.invalid"
# Fixed deterministic UUID for the dev bypass user (so the same row is reused
# every time the bypass fires). users.supabase_user_id is UUID-typed.
_DEV_AUTH_BYPASS_SUB = "00000000-0000-0000-0000-00000000d0d0"


def _maybe_dev_bypass_marker(value: str | None) -> str | None:
    if not value:
        return None
    return value.strip() or None


async def current_user(
    authorization: str | None = Header(default=None),
    x_dev_auth: str | None = Header(default=None, alias="X-Dev-Auth"),
    pool: AsyncConnectionPool = Depends(get_pool),
) -> User:
    """Verify Supabase JWT and resolve to BIGINT user row.

    On miss: 401. The user upsert is idempotent — first time a user hits
    this dep we create the row; subsequent calls fetch existing.

    Dev-only bypass: when DEPLOY_ENV=dev AND the request carries
    `X-Dev-Auth: pinai-dev-reviewer`, return a deterministic test user
    without touching Supabase. Used by the internal-reward-dashboard for
    local browser verification. Inert outside DEPLOY_ENV=dev.
    """
    # NOTE: defer the settings import to avoid widening the module-load
    # surface; this keeps the bypass strictly opt-in per request.
    from ...config import get_web_settings  # noqa: PLC0415

    settings = get_web_settings()
    bypass_marker = _maybe_dev_bypass_marker(x_dev_auth)
    if settings.deploy_env == "dev" and bypass_marker == _DEV_AUTH_BYPASS_HEADER_VALUE:
        logger.info("dev auth bypass active (DEPLOY_ENV=dev)")
        return await upsert_user_by_supabase_id(
            pool,
            supabase_user_id=_DEV_AUTH_BYPASS_SUB,
            email=_DEV_AUTH_BYPASS_EMAIL,
        )

    token = _extract_bearer(authorization)
    try:
        claims = await verify_supabase_jwt(token)
    except JWTVerifyError as e:
        logger.info("Supabase JWT verify failed: %s", e)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="invalid Supabase token",
            headers={"WWW-Authenticate": "Bearer"},
        ) from e

    return await upsert_user_by_supabase_id(
        pool,
        supabase_user_id=claims.sub,
        email=claims.email,
    )


async def current_agent_run(
    authorization: str | None = Header(default=None),
    pool=Depends(get_pool),
) -> AgentRun:
    """Resolve the bearer to an AgentRun.

    Two token families are accepted on the same dep so the same routes
    serve both call paths without per-route branching:

      * Phantom token (`pai_sbx_…` prefix) — sandbox-side bearer minted
        via `/api/agent/sandbox/phantom/mint`. Hot-path resolve is one
        cached DB lookup (token_hash → user_id). NEVER carries a
        virtual_key.
      * EdDSA JWT — chat-driving / scheduler bearer. user_id is in the
        signed claims, plus jti revocation lookup.

    Order matters for performance: phantom check is just a string-prefix
    test plus a cached lookup, so we run it first to keep JWTs off the
    hot path of sandbox-originated calls (the >99% case).
    """
    from ..db.repositories.jti_revocations import is_revoked  # noqa: PLC0415
    from ..db.repositories.sandbox_phantom_tokens import (  # noqa: PLC0415
        PHANTOM_PREFIX,
    )
    from ..db.repositories.sandbox_phantom_tokens import (
        resolve as resolve_phantom,
    )
    from ..db.rls import service_tx  # noqa: PLC0415

    token = _extract_bearer(authorization)

    # ── Phantom path ──
    if token.startswith(PHANTOM_PREFIX):
        if pool is None:
            # Phantom resolution is DB-only; without the pool we can't
            # auth. Distinct error from "invalid token" so ops can
            # diagnose a misconfigured deployment.
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="DB pool unavailable for phantom token resolution",
            )
        async with service_tx(pool) as conn:
            resolved = await resolve_phantom(conn, raw_token=token)
        if resolved is None:
            logger.info("phantom token verify failed (revoked / expired / unknown)")
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="invalid sandbox token",
                headers={"WWW-Authenticate": "Bearer"},
            )
        # run_id is for audit-trail attribution. scope_label was supplied
        # by the chat process at mint time (e.g. "card-thread-xyz"); fall
        # back to a sandbox-bound id, then to a generic placeholder so
        # the field is never empty (downstream repos write it as the
        # source_run_id on memory rows etc.).
        run_id = resolved.scope_label or (
            f"sbx_{resolved.sandbox_id}" if resolved.sandbox_id else "phantom"
        )
        return AgentRun(user_id=resolved.user_id, run_id=run_id, scope="agent")

    # ── JWT path ──
    try:
        claims = verify_agent_run_jwt(token)
    except AgentJWTError as e:
        logger.info("agent JWT verify failed: %s", e)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="invalid agent run token",
            headers={"WWW-Authenticate": "Bearer"},
        ) from e

    # Revocation check. service_tx because the verify path runs before
    # we trust the user_id claim (and revocations span all users anyway).
    if claims.jti and pool is not None:
        async with service_tx(pool) as conn:
            if await is_revoked(conn, claims.jti):
                logger.info(
                    "agent JWT verify rejected — jti revoked: jti=%s user=%d",
                    claims.jti,
                    claims.user_id,
                )
                raise HTTPException(
                    status_code=status.HTTP_401_UNAUTHORIZED,
                    detail="agent run token revoked",
                    headers={"WWW-Authenticate": "Bearer"},
                )
    return AgentRun(
        user_id=claims.user_id,
        run_id=claims.run_id,
        scope=claims.scope,
        actor=claims.actor,
        operator_id=claims.operator_id,
    )


async def current_chat_principal(
    authorization: str | None = Header(default=None),
    pool=Depends(get_pool),
) -> ChatPrincipal:
    """Verify a chat-driving JWT and reject phantoms outright.

    Used by `/api/agent/sandbox/phantom/{mint,revoke}` so a compromised
    sandbox cannot use its phantom token to mint a fresh phantom for
    itself. Also requires the `vk` claim — the bearer must be a
    chat-driving caller (phantom mint is meaningless without a virtual
    key to attribute the sandbox to).
    """
    from ..db.repositories.jti_revocations import is_revoked  # noqa: PLC0415
    from ..db.repositories.sandbox_phantom_tokens import (  # noqa: PLC0415
        PHANTOM_PREFIX,
    )
    from ..db.rls import service_tx  # noqa: PLC0415

    token = _extract_bearer(authorization)
    if token.startswith(PHANTOM_PREFIX):
        # Don't even try to resolve — explicit refusal preserves the
        # invariant "phantom can never escalate to mint".
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="phantom tokens cannot mint or revoke phantoms",
        )

    try:
        claims = verify_agent_run_jwt(token)
    except AgentJWTError as e:
        logger.info("chat JWT verify failed: %s", e)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="invalid chat token",
            headers={"WWW-Authenticate": "Bearer"},
        ) from e

    if not claims.virtual_key:
        # Sandbox / scheduler tokens omit `vk`; only chat-driving JWTs
        # carry it. Phantom mint is gated to chat-driving paths.
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="JWT missing `vk` claim — only chat-driving callers may mint phantoms",
        )

    if claims.jti and pool is not None:
        async with service_tx(pool) as conn:
            if await is_revoked(conn, claims.jti):
                raise HTTPException(
                    status_code=status.HTTP_401_UNAUTHORIZED,
                    detail="chat token revoked",
                    headers={"WWW-Authenticate": "Bearer"},
                )
    return ChatPrincipal(
        user_id=claims.user_id,
        run_id=claims.run_id,
        virtual_key=claims.virtual_key,
        jti=claims.jti,
    )
