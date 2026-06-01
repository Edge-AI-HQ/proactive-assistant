"""/api/admin/jwt/revoke — security-incident endpoint.

Auth: Supabase JWT (current_user). The user can only revoke their OWN
in-flight tokens. For staff-level cross-user revocation, use a service-
account Supabase JWT or invoke the repo directly from a one-shot script.

Body shape:
  {jti, expiresAtUnix, reason?}              — single revoke
  {jtis: [{jti, expiresAtUnix}], reason?}    — bulk revoke

Use cases:
  * User notices "device was lost / token leaked" → revoke active jtis.
  * Sandbox compromise alert → bulk-revoke all jtis active in the
    suspicious time window.
  * Routine: not used. JWT TTL (1h) is the default revocation mechanism.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from ...auth.deps import User, current_user, get_pool
from ...db.repositories.jti_revocations import revoke, revoke_all_for_user
from ...db.rls import service_tx

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/admin/jwt", tags=["admin"])


class RevokeOne(BaseModel):
    jti: str = Field(min_length=1, max_length=200)
    expiresAtUnix: int = Field(ge=0)
    reason: str | None = None


class RevokeBulk(BaseModel):
    jtis: list[dict[str, Any]] = Field(min_length=1, max_length=1000)
    reason: str | None = None


@router.post("/revoke", status_code=status.HTTP_204_NO_CONTENT)
async def revoke_jwt(
    body: RevokeOne,
    user: User = Depends(current_user),
    pool=Depends(get_pool),
) -> None:
    """Revoke a single jti. The endpoint runs as service_role for the
    insert (revocations span all users), but we tag the row with the
    caller's user_id for audit."""
    expires_at = datetime.fromtimestamp(body.expiresAtUnix, tz=UTC)
    async with service_tx(pool) as conn:
        await revoke(
            conn,
            jti=body.jti,
            user_id=user.id,
            expires_at=expires_at,
            reason=body.reason,
        )
    logger.info(
        "jwt revoke: user=%d jti=%s reason=%s",
        user.id,
        body.jti,
        body.reason,
    )
    return None


@router.post("/revoke-bulk")
async def revoke_jwt_bulk(
    body: RevokeBulk,
    user: User = Depends(current_user),
    pool=Depends(get_pool),
) -> dict:
    """Revoke many jtis at once. Each item must have {jti, expiresAtUnix}."""
    pairs: list[tuple[str, datetime]] = []
    for it in body.jtis:
        jti = it.get("jti")
        exp = it.get("expiresAtUnix")
        if not isinstance(jti, str) or not jti or not isinstance(exp, (int, float)):
            raise HTTPException(400, f"bad bulk item: {it!r}")
        pairs.append((jti, datetime.fromtimestamp(int(exp), tz=UTC)))
    async with service_tx(pool) as conn:
        n = await revoke_all_for_user(
            conn,
            user_id=user.id,
            jtis=pairs,
            reason=body.reason,
        )
    logger.info("jwt bulk revoke: user=%d count=%d", user.id, n)
    return {"revoked": n}
